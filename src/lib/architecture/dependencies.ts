import type { Connection, ResolvedComponents } from "./types";

export type DependencyDirection = "callers" | "dependencies";

/** Component ids and original connection indexes, in the order the call travels. */
export interface DependencyPath {
  ids: string[];
  edges: number[];
}

interface Route {
  previous: string;
  edge: number;
  hops: number;
  asynchronous: boolean;
}

/** Breadth first so each reachable component is listed once, with its shortest known route.
 * Keep the original edge indexes so parallel connections can be highlighted individually. */
export function traceDependencies(
  connections: readonly Connection[],
  comps: ResolvedComponents,
  root: string,
  direction: DependencyDirection,
  syncOnly: boolean,
) {
  const links = new Map<string, Array<{ to: string; index: number; asynchronous: boolean }>>();
  connections.forEach((edge, index) => {
    const asynchronous = edge.kind === "async";
    if (syncOnly && asynchronous) return;
    if (!Object.prototype.hasOwnProperty.call(comps, edge.from) || !Object.prototype.hasOwnProperty.call(comps, edge.to)) return;
    const [from, to] = direction === "callers" ? [edge.to, edge.from] : [edge.from, edge.to];
    const list = links.get(from);
    const link = { to, index, asynchronous };
    if (list) list.push(link);
    else links.set(from, [link]);
  });

  const routes = new Map<string, Route>();
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const previous = queue[i];
    const parent = routes.get(previous);
    for (const { to, index, asynchronous } of links.get(previous) ?? []) {
      if (to === root || routes.has(to)) continue;
      routes.set(to, {
        previous,
        edge: index,
        hops: (parent?.hops ?? 0) + 1,
        asynchronous: asynchronous || !!parent?.asynchronous,
      });
      queue.push(to);
    }
  }

  const pathTo = (id: string): DependencyPath | null => {
    let route = routes.get(id);
    if (!route) return null;
    const ids = [id];
    const edges: number[] = [];
    while (route) {
      ids.push(route.previous);
      edges.push(route.edge);
      route = routes.get(route.previous);
    }
    return direction === "callers" ? { ids, edges } : { ids: ids.reverse(), edges: edges.reverse() };
  };
  return { routes, pathTo };
}
