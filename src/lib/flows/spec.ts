/**
 * The flow document on the frontend: its types, and every edit the canvas makes to it.
 *
 * The mirror of `src-tauri/src/flows/spec.rs`. Rust is the gate — a row never holds a document that
 * fails `spec::validate` — and this file is what keeps the canvas from ever *producing* one: a
 * connection the backend would refuse is refused here first, as the user drags it, rather than
 * after the autosave has already been told no.
 *
 * Every function is pure and returns a new document, so the store's undo history is just the list
 * of documents it has had.
 */

import type { FlowNodeDescriptor } from "../tauri/flowsCommands";

export const SPEC_SCHEMA = 1;
/** The only node a cycle may pass through — `catalog::LOOP_TYPE`. */
export const LOOP_TYPE = "logic.loop";
/** `catalog::RUNS_THROUGH`: the last milestone whose nodes this build runs. */
export const RUNS_THROUGH = 3;
/** `spec::MAX_NAME`. */
export const MAX_NODE_NAME = 120;

export interface FlowNodeSpec {
  id: string;
  type: string;
  name: string;
  pos: [number, number];
  params: Record<string, unknown>;
  settings: Record<string, unknown>;
  disabled?: boolean;
}

export interface FlowConnection {
  from: string;
  out: number;
  to: string;
  in: number;
}

export interface StickyNoteSpec {
  id: string;
  pos: [number, number];
  size: [number, number];
  text: string;
}

export interface FlowSpec {
  schema: number;
  nodes: FlowNodeSpec[];
  connections: FlowConnection[];
  notes: StickyNoteSpec[];
  settings: Record<string, unknown>;
}

/** The catalogue by type id. */
export type Catalog = ReadonlyMap<string, FlowNodeDescriptor>;

export function emptySpec(): FlowSpec {
  return { schema: SPEC_SCHEMA, nodes: [], connections: [], notes: [], settings: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pair = (value: unknown, fallback: [number, number]): [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && Number.isFinite(v))
    ? [value[0], value[1]]
    : fallback;

/**
 * Reads a stored document, filling the defaults Rust fills (`#[serde(default)]`). Throws on text
 * that is not JSON at all — that is a broken row, and the caller says so rather than drawing an
 * empty canvas over it.
 *
 * Unknown top-level fields and unknown node fields are **kept**, for the reason the Rust module
 * gives: a field a newer build wrote must survive a save from this one.
 */
export function parseSpec(text: string): FlowSpec {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("not a flow document");
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(isRecord) : [];
  const connections = Array.isArray(raw.connections) ? raw.connections.filter(isRecord) : [];
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(isRecord) : [];
  return {
    ...raw,
    schema: typeof raw.schema === "number" ? raw.schema : SPEC_SCHEMA,
    nodes: nodes.map((node) => ({
      ...node,
      id: String(node.id ?? ""),
      type: String(node.type ?? ""),
      name: String(node.name ?? ""),
      pos: pair(node.pos, [0, 0]),
      params: isRecord(node.params) ? node.params : {},
      settings: isRecord(node.settings) ? node.settings : {},
      disabled: node.disabled === true,
    })),
    connections: connections.map((c) => ({
      from: String(c.from ?? ""),
      out: typeof c.out === "number" ? c.out : 0,
      to: String(c.to ?? ""),
      in: typeof c.in === "number" ? c.in : 0,
    })),
    notes: notes.map((note) => ({
      ...note,
      id: String(note.id ?? ""),
      pos: pair(note.pos, [0, 0]),
      size: pair(note.size, [240, 120]),
      text: typeof note.text === "string" ? note.text : "",
    })),
    settings: isRecord(raw.settings) ? raw.settings : {},
  } as FlowSpec;
}

export function serializeSpec(spec: FlowSpec): string {
  return JSON.stringify(spec);
}

export const connectionKey = (c: FlowConnection) => `${c.from}:${c.out}>${c.to}:${c.in}`;

/** A short id nothing in `taken` uses. Random rather than counted, so two pastes of the same
 *  fragment into two flows can later be merged into one without colliding. */
export function newId(prefix: string, taken: ReadonlySet<string>): string {
  for (;;) {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    const id = prefix + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
    if (!taken.has(id)) return id;
  }
}

/** `base`, or `base 2`, `base 3`… — the first one `taken` does not hold. A base that already ends
 *  in a number counts on from it, so copying "HTTP 2" gives "HTTP 3" rather than "HTTP 2 2". */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(Array.from(taken, (name) => name.trim()));
  const clean = base.trim().slice(0, MAX_NODE_NAME) || "Node";
  if (!names.has(clean)) return clean;
  const match = /^(.*?)(?:\s+(\d+))?$/.exec(clean);
  const stem = (match?.[1] ?? clean).trim() || clean;
  let n = match?.[2] ? Number(match[2]) : 1;
  for (;;) {
    n += 1;
    const candidate = `${stem} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

function allIds(spec: FlowSpec): Set<string> {
  return new Set([...spec.nodes.map((n) => n.id), ...spec.notes.map((n) => n.id)]);
}

export function addNode(
  spec: FlowSpec,
  typeId: string,
  name: string,
  pos: [number, number],
): { spec: FlowSpec; id: string } {
  const id = newId("n", allIds(spec));
  const node: FlowNodeSpec = {
    id,
    type: typeId,
    name: uniqueName(name, spec.nodes.map((n) => n.name)),
    pos: [Math.round(pos[0]), Math.round(pos[1])],
    params: {},
    settings: {},
  };
  return { spec: { ...spec, nodes: [...spec.nodes, node] }, id };
}

export function addNote(spec: FlowSpec, pos: [number, number], text = ""): { spec: FlowSpec; id: string } {
  const id = newId("s", allIds(spec));
  const note: StickyNoteSpec = { id, pos: [Math.round(pos[0]), Math.round(pos[1])], size: [240, 120], text };
  return { spec: { ...spec, notes: [...spec.notes, note] }, id };
}

/**
 * Whether the graph has a cycle that no loop node closes — Kahn's algorithm over the graph with
 * every loop node removed, exactly as `spec::has_cycle_outside_loops` does it.
 */
export function hasCycleOutsideLoops(
  nodes: readonly FlowNodeSpec[],
  connections: readonly FlowConnection[],
): boolean {
  const kept = new Set(nodes.filter((n) => n.type !== LOOP_TYPE).map((n) => n.id));
  const indegree = new Map<string, number>([...kept].map((id) => [id, 0]));
  const next = new Map<string, string[]>();
  for (const c of connections) {
    if (!kept.has(c.from) || !kept.has(c.to)) continue;
    next.set(c.from, [...(next.get(c.from) ?? []), c.to]);
    indegree.set(c.to, (indegree.get(c.to) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  let peeled = 0;
  while (queue.length) {
    const id = queue.shift()!;
    peeled += 1;
    for (const to of next.get(id) ?? []) {
      const degree = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, degree);
      if (degree === 0) queue.push(to);
    }
  }
  return peeled < kept.size;
}

/**
 * Whether a node sends its failures out of an extra "error" port — `run::has_error_output`. Triggers,
 * Stop and No-op never do: nothing to route, or nowhere to route it from.
 */
export function hasErrorOutput(node: FlowNodeSpec, descriptor: FlowNodeDescriptor | undefined): boolean {
  return (
    !!descriptor &&
    descriptor.family !== "trigger" &&
    node.type !== "logic.stop" &&
    node.type !== "logic.noop" &&
    node.settings?.onError === "errorOutput"
  );
}

/** The ports a node has on the canvas: the catalogue's, plus the error port — `run::output_count`. */
export function outputCount(node: FlowNodeSpec, descriptor: FlowNodeDescriptor | undefined): number {
  return (descriptor?.outputs ?? 0) + (hasErrorOutput(node, descriptor) ? 1 : 0);
}

/** Why a connection may not be made, or `null` when it may. */
export function connectionProblem(
  spec: FlowSpec,
  catalog: Catalog,
  c: FlowConnection,
): "missing" | "self" | "port" | "duplicate" | "cycle" | null {
  const from = spec.nodes.find((n) => n.id === c.from);
  const to = spec.nodes.find((n) => n.id === c.to);
  if (!from || !to) return "missing";
  if (c.from === c.to) return "self";
  const fromDescriptor = catalog.get(from.type);
  const toDescriptor = catalog.get(to.type);
  if (!fromDescriptor || !toDescriptor) return "missing";
  if (c.out < 0 || c.out >= outputCount(from, fromDescriptor) || c.in < 0 || c.in >= toDescriptor.inputs) return "port";
  const key = connectionKey(c);
  if (spec.connections.some((existing) => connectionKey(existing) === key)) return "duplicate";
  if (hasCycleOutsideLoops(spec.nodes, [...spec.connections, c])) return "cycle";
  return null;
}

export function connect(spec: FlowSpec, catalog: Catalog, c: FlowConnection): FlowSpec | null {
  if (connectionProblem(spec, catalog, c)) return null;
  return { ...spec, connections: [...spec.connections, c] };
}

/** Removes nodes (with every connection touching them), notes and connections, by id/key. */
export function removeElements(
  spec: FlowSpec,
  remove: { nodes?: Iterable<string>; notes?: Iterable<string>; connections?: Iterable<string> },
): FlowSpec {
  const nodes = new Set(remove.nodes ?? []);
  const notes = new Set(remove.notes ?? []);
  const connections = new Set(remove.connections ?? []);
  if (nodes.size === 0 && notes.size === 0 && connections.size === 0) return spec;
  const next = {
    ...spec,
    nodes: spec.nodes.filter((n) => !nodes.has(n.id)),
    notes: spec.notes.filter((n) => !notes.has(n.id)),
    connections: spec.connections.filter(
      (c) => !nodes.has(c.from) && !nodes.has(c.to) && !connections.has(connectionKey(c)),
    ),
  };
  // The same document when nothing matched, so a removal React Flow reports twice — a node, then the
  // edges it took with it — is one undo step rather than two.
  const unchanged =
    next.nodes.length === spec.nodes.length &&
    next.notes.length === spec.notes.length &&
    next.connections.length === spec.connections.length;
  return unchanged ? spec : next;
}

/** Puts nodes and notes where `positions` says. Unchanged elements keep their identity, which is
 *  what lets the canvas skip re-adopting them. */
export function moveElements(spec: FlowSpec, positions: ReadonlyMap<string, [number, number]>): FlowSpec {
  if (positions.size === 0) return spec;
  const place = <T extends { id: string; pos: [number, number] }>(item: T): T => {
    const pos = positions.get(item.id);
    return pos && (pos[0] !== item.pos[0] || pos[1] !== item.pos[1]) ? { ...item, pos } : item;
  };
  return { ...spec, nodes: spec.nodes.map(place), notes: spec.notes.map(place) };
}

/** A node's new name, or `null` when it is empty or another node already has it — names are what
 *  expressions address nodes by, so two alike would be ambiguous. */
export function renameNode(spec: FlowSpec, id: string, name: string): FlowSpec | null {
  const clean = name.trim().slice(0, MAX_NODE_NAME);
  if (!clean) return null;
  if (spec.nodes.some((n) => n.id !== id && n.name.trim() === clean)) return null;
  return { ...spec, nodes: spec.nodes.map((n) => (n.id === id ? { ...n, name: clean } : n)) };
}

export function setNodeDisabled(spec: FlowSpec, ids: Iterable<string>, disabled: boolean): FlowSpec {
  const set = new Set(ids);
  return { ...spec, nodes: spec.nodes.map((n) => (set.has(n.id) ? { ...n, disabled } : n)) };
}

/** A node with one parameter changed. `undefined` removes it, so the default applies again. */
export function setNodeParam(spec: FlowSpec, id: string, name: string, value: unknown): FlowSpec {
  return {
    ...spec,
    nodes: spec.nodes.map((n) => {
      if (n.id !== id) return n;
      const params = { ...n.params };
      if (value === undefined) delete params[name];
      else params[name] = value;
      return { ...n, params };
    }),
  };
}

/**
 * A node with its settings changed. Turning the error port off takes its connections with it — a
 * wire from a port that no longer exists is one the backend would refuse.
 */
export function setNodeSettings(spec: FlowSpec, catalog: Catalog, id: string, change: Record<string, unknown>): FlowSpec {
  const node = spec.nodes.find((n) => n.id === id);
  if (!node) return spec;
  const settings = { ...node.settings };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined || value === null || value === "" || value === false) delete settings[key];
    else settings[key] = value;
  }
  const updated = { ...node, settings };
  const descriptor = catalog.get(node.type);
  const ports = outputCount(updated, descriptor);
  return {
    ...spec,
    nodes: spec.nodes.map((n) => (n.id === id ? updated : n)),
    connections: spec.connections.filter((c) => c.from !== id || c.out < ports),
  };
}

export function updateNote(
  spec: FlowSpec,
  id: string,
  change: Partial<Pick<StickyNoteSpec, "text" | "size" | "pos">>,
): FlowSpec {
  return { ...spec, notes: spec.notes.map((n) => (n.id === id ? { ...n, ...change } : n)) };
}

// ---------- clipboard ----------

export const FRAGMENT_KIND = "codeflow/flow-fragment";

export interface FlowFragment {
  kind: typeof FRAGMENT_KIND;
  version: 1;
  nodes: FlowNodeSpec[];
  connections: FlowConnection[];
  notes: StickyNoteSpec[];
}

/** The selection as a self-contained piece: only the connections both of whose ends are in it. */
export function copyFragment(spec: FlowSpec, nodeIds: Iterable<string>, noteIds: Iterable<string>): FlowFragment {
  const nodes = new Set(nodeIds);
  const notes = new Set(noteIds);
  return {
    kind: FRAGMENT_KIND,
    version: 1,
    nodes: spec.nodes.filter((n) => nodes.has(n.id)),
    connections: spec.connections.filter((c) => nodes.has(c.from) && nodes.has(c.to)),
    notes: spec.notes.filter((n) => notes.has(n.id)),
  };
}

export function parseFragment(text: string): FlowFragment | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.kind !== FRAGMENT_KIND) return null;
    const asSpec = parseSpec(JSON.stringify({ schema: SPEC_SCHEMA, nodes: raw.nodes, connections: raw.connections, notes: raw.notes }));
    return { kind: FRAGMENT_KIND, version: 1, nodes: asSpec.nodes, connections: asSpec.connections, notes: asSpec.notes };
  } catch {
    return null;
  }
}

/**
 * Pastes a fragment `offset` away from where it was copied: fresh ids, names made unique against
 * the flow (and against each other), nodes of a type this build does not know left out with the
 * connections that touched them.
 */
export function pasteFragment(
  spec: FlowSpec,
  fragment: FlowFragment,
  catalog: Catalog,
  offset: [number, number],
): { spec: FlowSpec; nodeIds: string[]; noteIds: string[] } {
  const taken = allIds(spec);
  const names = spec.nodes.map((n) => n.name);
  const ids = new Map<string, string>();
  const nodes: FlowNodeSpec[] = [];
  for (const node of fragment.nodes) {
    if (!catalog.has(node.type)) continue;
    const id = newId("n", taken);
    taken.add(id);
    ids.set(node.id, id);
    const name = uniqueName(node.name, names);
    names.push(name);
    nodes.push({ ...node, id, name, pos: [node.pos[0] + offset[0], node.pos[1] + offset[1]] });
  }
  const notes: StickyNoteSpec[] = fragment.notes.map((note) => {
    const id = newId("s", taken);
    taken.add(id);
    return { ...note, id, pos: [note.pos[0] + offset[0], note.pos[1] + offset[1]] };
  });
  const connections = fragment.connections
    .filter((c) => ids.has(c.from) && ids.has(c.to))
    .map((c) => ({ ...c, from: ids.get(c.from)!, to: ids.get(c.to)! }));
  return {
    spec: {
      ...spec,
      nodes: [...spec.nodes, ...nodes],
      notes: [...spec.notes, ...notes],
      connections: [...spec.connections, ...connections],
    },
    nodeIds: nodes.map((n) => n.id),
    noteIds: notes.map((n) => n.id),
  };
}

// ---------- layout ----------

export const LAYOUT_COLUMN = 200;
export const LAYOUT_ROW = 130;

/**
 * Arranges the nodes in columns by dependency depth — the longest path from a node with no inputs —
 * and, inside a column, keeps the order they already had top to bottom. Notes stay where they are:
 * they annotate a place the user chose, and moving them is how they end up pointing at nothing.
 *
 * A loop node's feedback edge (one arriving from something the loop itself reaches) is ignored for
 * the depth, or the loop would push itself to the right forever.
 */
export function autoLayout(spec: FlowSpec): FlowSpec {
  if (spec.nodes.length === 0) return spec;
  const ids = new Set(spec.nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const c of spec.connections) {
    if (ids.has(c.from) && ids.has(c.to)) out.set(c.from, [...(out.get(c.from) ?? []), c.to]);
  }
  const reach = (start: string) => {
    const seen = new Set<string>();
    const stack = [...(out.get(start) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(out.get(id) ?? []));
    }
    return seen;
  };
  const loops = new Map(spec.nodes.filter((n) => n.type === LOOP_TYPE).map((n) => [n.id, reach(n.id)]));
  const edges = spec.connections.filter(
    (c) => ids.has(c.from) && ids.has(c.to) && !(loops.get(c.to)?.has(c.from) ?? false),
  );

  const indegree = new Map(spec.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>();
  for (const c of edges) {
    next.set(c.from, [...(next.get(c.from) ?? []), c.to]);
    indegree.set(c.to, (indegree.get(c.to) ?? 0) + 1);
  }
  const depth = new Map(spec.nodes.map((n) => [n.id, 0]));
  const queue = spec.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of next.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, (depth.get(id) ?? 0) + 1));
      const degree = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, degree);
      if (degree === 0) queue.push(to);
    }
  }

  const columns = new Map<number, FlowNodeSpec[]>();
  for (const node of spec.nodes) {
    const d = depth.get(node.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), node]);
  }
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  const left = Math.min(...spec.nodes.map((n) => n.pos[0]));
  const top = Math.min(...spec.nodes.map((n) => n.pos[1]));
  const positions = new Map<string, [number, number]>();
  for (const [d, column] of columns) {
    const ordered = [...column].sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0]);
    const lead = ((tallest - ordered.length) * LAYOUT_ROW) / 2;
    ordered.forEach((node, row) => {
      positions.set(node.id, [Math.round(left + d * LAYOUT_COLUMN), Math.round(top + lead + row * LAYOUT_ROW)]);
    });
  }
  return { ...spec, nodes: spec.nodes.map((n) => ({ ...n, pos: positions.get(n.id) ?? n.pos })) };
}
