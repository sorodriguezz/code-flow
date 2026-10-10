/**
 * Where the «Mapa» view puts its nodes: in columns by dependency, importers on the left and what
 * they import to their right — so the code everything leans on settles at the right edge and the
 * entry points at the left, which is how people already draw an architecture.
 *
 * Layered by longest path over the import graph with its cycles broken (a back edge found by
 * depth-first search is ignored for ranking; it is still drawn). Within a column, nodes keep a stable
 * order: folders before files, then the most-imported first. Pure, so it is tested without a canvas.
 */

export interface LayoutNode {
  id: string;
  folder: boolean;
  importedBy: number;
  label: string;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export const COLUMN = 280;
export const ROW = 96;
/** A column longer than this wraps into a second one beside it — a folder of 200 files is a wall. */
export const MAX_ROWS = 14;
/** Dependency chains deeper than this share columns: twelve layers of stores importing stores laid
 *  out one per column fit the canvas only at a zoom where nothing can be read. */
export const MAX_COLUMNS = 5;

export function layoutMap(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  { maxRows = MAX_ROWS, maxColumns = MAX_COLUMNS }: { maxRows?: number; maxColumns?: number } = {},
): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const node of nodes) out.set(node.id, []);
  for (const edge of edges) {
    if (ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to) out.get(edge.from)!.push(edge.to);
  }

  // Back edges, by depth-first search in a stable order: the ones that close a cycle.
  const back = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const visit = (start: string) => {
    const stack: [string, number][] = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [id, index] = top;
      const targets = out.get(id) ?? [];
      if (index >= targets.length) {
        state.set(id, 2);
        stack.pop();
        continue;
      }
      top[1] = index + 1;
      const target = targets[index];
      const seen = state.get(target) ?? 0;
      if (seen === 1) back.add(`${id}\u0000${target}`);
      else if (seen === 0) {
        state.set(target, 1);
        stack.push([target, 0]);
      }
    }
  };
  for (const node of ordered) if (!state.get(node.id)) visit(node.id);

  // Longest path from the sources, over the acyclic rest.
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const [from, targets] of out) {
    for (const to of targets) if (!back.has(`${from}\u0000${to}`)) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const queue = ordered.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of out.get(id) ?? []) {
      if (back.has(`${id}\u0000${to}`)) continue;
      rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, left);
      if (left === 0) queue.push(to);
    }
  }

  // Columns, each split when it would run past MAX_ROWS. Ranks past MAX_COLUMNS are folded in
  // proportionally, keeping left-of order between any two that end up in different columns.
  const deepest = Math.max(0, ...rank.values());
  const fold = (r: number) => (deepest < maxColumns ? r : Math.floor((r * maxColumns) / (deepest + 1)));
  const byRank = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const r = fold(rank.get(node.id) ?? 0);
    byRank.set(r, [...(byRank.get(r) ?? []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let column = 0;
  for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
    const list = byRank
      .get(r)!
      .sort((a, b) => Number(b.folder) - Number(a.folder) || b.importedBy - a.importedBy || a.label.localeCompare(b.label));
    for (let start = 0; start < list.length; start += maxRows) {
      const chunk = list.slice(start, start + maxRows);
      const top = -((chunk.length - 1) * ROW) / 2;
      chunk.forEach((node, i) => positions.set(node.id, { x: column * COLUMN, y: top + i * ROW }));
      column += 1;
    }
  }
  return positions;
}
