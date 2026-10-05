import { connectionKey, type FlowSpec } from "./spec";

/**
 * What an AI proposal changes, for the canvas to draw before anything is accepted.
 *
 * The proposal is drawn as it would be, plus **ghosts**: the nodes and wires it removes, put back
 * where they were so a deletion is something you see rather than something you notice missing.
 * A node is *changed* when what it does changed — its type, name, parameters or whether it is
 * switched off; moving it is not a change worth a mark.
 */

export type DiffMark = "added" | "changed" | "removed";

export interface FlowDiff {
  /** The proposal with the removed nodes and wires drawn back in. Only ever rendered, never saved. */
  shown: FlowSpec;
  nodes: Map<string, DiffMark>;
  /** By `connectionKey`. */
  connections: Map<string, DiffMark>;
  counts: { added: number; changed: number; removed: number };
}

/** JSON with object keys in order, so two equal values compare equal however they were written. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function diffSpecs(before: FlowSpec, after: FlowSpec): FlowDiff {
  const nodes = new Map<string, DiffMark>();
  const connections = new Map<string, DiffMark>();
  const old = new Map(before.nodes.map((node) => [node.id, node]));
  const kept = new Set(after.nodes.map((node) => node.id));
  for (const node of after.nodes) {
    const previous = old.get(node.id);
    if (!previous) {
      nodes.set(node.id, "added");
    } else if (
      previous.type !== node.type ||
      previous.name !== node.name ||
      (previous.disabled ?? false) !== (node.disabled ?? false) ||
      stable(previous.params ?? {}) !== stable(node.params ?? {})
    ) {
      nodes.set(node.id, "changed");
    }
  }
  const ghosts = before.nodes.filter((node) => !kept.has(node.id));
  for (const ghost of ghosts) nodes.set(ghost.id, "removed");

  const oldWires = new Set(before.connections.map(connectionKey));
  const newWires = new Set(after.connections.map(connectionKey));
  for (const wire of after.connections) {
    if (!oldWires.has(connectionKey(wire))) connections.set(connectionKey(wire), "added");
  }
  const goneWires = before.connections.filter((wire) => !newWires.has(connectionKey(wire)));
  for (const wire of goneWires) connections.set(connectionKey(wire), "removed");

  const count = (mark: DiffMark) => [...nodes.values()].filter((value) => value === mark).length;
  return {
    shown: { ...after, nodes: [...after.nodes, ...ghosts], connections: [...after.connections, ...goneWires] },
    nodes,
    connections,
    counts: { added: count("added"), changed: count("changed"), removed: count("removed") },
  };
}
