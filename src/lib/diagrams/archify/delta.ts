/**
 * Two architectures, one picture: what a change added, removed and altered.
 *
 * Archify's `compare architecture base head` does this for a pull request; here it is a button on a
 * diagram — pick another one to compare with — so a map written last month can be held against
 * today's. Components are matched by id, connections by their ends and label; the picture is the
 * *head* laid out as usual with what only the base had put back in, marked removed.
 */
import type { ArchifyArchitecture, ArchifyBoundary, ArchifyComponent, ArchifyConnection } from "./ir";
import { buildScene } from "./layout/build";
import type { ArchifyScene } from "./scene";

const linkKey = (c: ArchifyConnection) => `${c.from}\u0000${c.to}\u0000${c.label ?? ""}`;

function differs(a: ArchifyComponent, b: ArchifyComponent): boolean {
  return a.label !== b.label || a.type !== b.type || (a.sublabel ?? "") !== (b.sublabel ?? "") || (a.tag ?? "") !== (b.tag ?? "");
}

export function compareArchitectures(base: ArchifyArchitecture, head: ArchifyArchitecture, linkSources = false): ArchifyScene {
  const baseById = new Map(base.components.map((c) => [c.id, c]));
  const headById = new Map(head.components.map((c) => [c.id, c]));
  const removedComponents = base.components.filter((c) => !headById.has(c.id));

  const headLinks = new Set(head.connections.map(linkKey));
  const baseLinks = new Set(base.connections.map(linkKey));
  const removedLinks = base.connections.filter((c) => !headLinks.has(linkKey(c)));

  const known = new Set([...head.components, ...removedComponents].map((c) => c.id));
  // A frame the base had and the head dropped stays, holding what it held that is still drawn.
  const boundaries: ArchifyBoundary[] = head.boundaries.map((b) => ({ ...b, wraps: [...b.wraps] }));
  for (const b of base.boundaries) {
    const wraps = b.wraps.filter((id) => known.has(id));
    const same = boundaries.find((x) => x.label === b.label && x.kind === b.kind);
    if (same) same.wraps = [...new Set([...same.wraps, ...wraps])];
    else if (wraps.length) boundaries.push({ ...b, wraps });
  }

  const merged: ArchifyArchitecture = {
    ...head,
    meta: { ...head.meta },
    components: [...head.components.map((c) => ({ ...c, pos: undefined, size: undefined, row: undefined, col: undefined })), ...removedComponents.map((c) => ({ ...c, pos: undefined, size: undefined, row: undefined, col: undefined }))],
    boundaries,
    connections: [...head.connections, ...removedLinks],
    layout: undefined,
  };
  const scene = buildScene(merged, { linkSources });

  const counts = { added: 0, removed: 0, changed: 0 };
  for (const node of scene.nodes) {
    const was = baseById.get(node.id);
    const is = headById.get(node.id);
    if (!was) {
      node.status = "added";
      counts.added++;
    } else if (!is) {
      node.status = "removed";
      counts.removed++;
    } else if (differs(was, is)) {
      node.status = "changed";
      counts.changed++;
    }
  }
  merged.connections.forEach((c, at) => {
    const edge = scene.edges.find((e) => e.id === (c.id ?? `c${at + 1}`));
    if (!edge) return;
    if (!baseLinks.has(linkKey(c))) edge.status = "added";
    else if (!headLinks.has(linkKey(c))) edge.status = "removed";
  });
  scene.delta = counts;
  return scene;
}
