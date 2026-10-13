/**
 * The document as a file archify's own CLI renders: `archify finalize <type> <file> <out.html>`.
 *
 * What the stored document can lack and archify requires, by type:
 * - **positions** — archify does not lay out. An architecture needs `pos`/`size` on every component
 *   (written from where this app drew it), a sequence a `y` on every message, and the three grid
 *   types a lane/column or stage/row on every node (written from the ranks the layout found);
 * - **`meta.output`** — the HTML file archify writes, named after the title;
 * - **`meta.repository` for `sources`** — archify refuses source evidence without a pinned commit to
 *   verify it against. The backend pins one when it can (`ai::ground_archify_answer`); when it could
 *   not (no `origin`, no commit yet) the sources are left out rather than making the whole export
 *   fail archify's first check.
 *
 * **Patched, not rebuilt, when nothing was missing.** An imported archify file carries fields this
 * viewer never reads — `icon`, `brand`, `legend`, routing hints like `via` — and rebuilding it from
 * the parsed IR would drop them. A document that is already complete is handed back byte for byte.
 */
import {
  activationsOf,
  portableOutput,
  type ArchifyDocument,
  type ArchifyArchitecture,
  type ArchifyDataflow,
  type ArchifyLifecycle,
  type ArchifySequence,
  type ArchifyWorkflow,
} from "./ir";
import { assignRanks, denseRanks } from "./layout/engine";
import { buildScene } from "./layout/build";

/** A file name archify's `portableOutputPath` takes, from a title. */
export function outputName(title: string): string {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "diagram";
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug) ? `${slug}-map.html` : `${slug}.html`;
}

/** The extension an archify file is conventionally saved under: `<name>.<type>.json`. */
export function archifyFileSuffix(doc: ArchifyDocument): string {
  return `${doc.diagram_type}.json`;
}

function meta(doc: ArchifyDocument): Record<string, unknown> {
  const out: Record<string, unknown> = { title: doc.meta.title };
  if (doc.meta.subtitle) out.subtitle = doc.meta.subtitle;
  out.output = doc.meta.output && portableOutput(doc.meta.output) ? doc.meta.output : outputName(doc.meta.title);
  if (doc.meta.repository) out.repository = doc.meta.repository;
  return out;
}

/** Sources only travel with the repository that vouches for them. */
function sources<T extends { sources?: unknown }>(item: T, pinned: boolean): Partial<T> {
  return pinned || !item.sources ? item : { ...item, sources: undefined };
}

function clean<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

function architecture(doc: ArchifyArchitecture): Record<string, unknown> {
  const scene = buildScene(doc, { linkSources: false });
  const placed = new Map(scene.nodes.map((n) => [n.id, n.box]));
  const authored = doc.components.every((c) => c.pos || (doc.layout && c.row !== undefined && c.col !== undefined));
  const minX = Math.min(...scene.nodes.map((n) => n.box[0]));
  const minY = Math.min(...scene.nodes.map((n) => n.box[1]));
  const pinned = !!doc.meta.repository;
  return {
    schema_version: 1,
    diagram_type: "architecture",
    meta: meta(doc),
    ...(authored && doc.layout ? { layout: doc.layout } : {}),
    components: doc.components.map((c) => {
      const box = placed.get(c.id)!;
      const at = authored ? { pos: c.pos, size: c.size, row: c.pos ? undefined : c.row, col: c.pos ? undefined : c.col } : { pos: [Math.round(box[0] - minX + 40), Math.round(box[1] - minY + 90)], size: [Math.round(box[2]), Math.round(box[3])] };
      return clean({ id: c.id, type: c.type, label: c.label, sublabel: c.sublabel, tag: c.tag, sources: sources(c, pinned).sources, ...at });
    }),
    ...(doc.boundaries.length ? { boundaries: doc.boundaries } : {}),
    ...(doc.connections.length ? { connections: doc.connections.map((c) => clean(c)) } : {}),
    ...(doc.cards.length ? { cards: doc.cards } : {}),
  };
}

function workflow(doc: ArchifyWorkflow): Record<string, unknown> {
  const preset = new Map(doc.nodes.flatMap((n) => (n.col !== undefined ? [[n.id, n.col] as const] : [])));
  const { rank } = denseRanks(assignRanks(doc.nodes.map((n) => n.id), doc.edges.map((e) => [e.from, e.to]), preset));
  const pinned = !!doc.meta.repository;
  return {
    schema_version: 2,
    diagram_type: "workflow",
    meta: meta(doc),
    lanes: doc.lanes.map((l) => clean({ id: l.id, label: l.label, variant: l.variant })),
    ...(doc.phases.length ? { phases: doc.phases.map((p) => clean({ ...p, fromCol: Math.min(5, p.fromCol), toCol: Math.min(5, p.toCol) })) } : {}),
    ...(doc.groups.length ? { groups: doc.groups.map((g) => clean({ ...g, fromCol: Math.min(5, g.fromCol), toCol: Math.min(5, g.toCol) })) } : {}),
    ...(doc.mainPath.length ? { mainPath: doc.mainPath } : {}),
    nodes: doc.nodes.map((n) => clean({ id: n.id, lane: n.lane, col: Math.min(5, n.col ?? rank.get(n.id) ?? 0), type: n.type, label: n.label, sublabel: n.sublabel, tag: n.tag, sources: sources(n, pinned).sources })),
    edges: doc.edges.map((e) => clean(e)),
    ...(doc.cards.length ? { cards: doc.cards } : {}),
  };
}

function dataflow(doc: ArchifyDataflow): Record<string, unknown> {
  const preset = new Map(doc.nodes.flatMap((n) => (n.stage !== undefined ? [[n.id, n.stage] as const] : [])));
  const { rank } = denseRanks(assignRanks(doc.nodes.map((n) => n.id), doc.flows.map((f) => [f.from, f.to]), preset));
  const next = new Map<number, number>();
  const stageOf = (n: ArchifyDataflow["nodes"][number]) => n.stage ?? rank.get(n.id) ?? 0;
  const rows = new Map(
    doc.nodes.map((n) => {
      if (n.row !== undefined) return [n.id, n.row] as const;
      const stage = stageOf(n);
      const row = next.get(stage) ?? 0;
      next.set(stage, row + 1);
      return [n.id, row] as const;
    }),
  );
  const stageCount = Math.max(doc.stages.length, ...doc.nodes.map((n) => stageOf(n) + 1));
  const pinned = !!doc.meta.repository;
  return {
    schema_version: 1,
    diagram_type: "dataflow",
    meta: meta(doc),
    stages: Array.from({ length: stageCount }, (_, at) => ({ label: doc.stages[at]?.label ?? `Stage ${at + 1}` })),
    nodes: doc.nodes.map((n) => clean({ id: n.id, type: n.type, label: n.label, sublabel: n.sublabel, tag: n.tag, sources: sources(n, pinned).sources, stage: stageOf(n), row: rows.get(n.id)! })),
    flows: doc.flows.map((f) => clean(f)),
    ...(doc.cards.length ? { cards: doc.cards } : {}),
  };
}

function lifecycle(doc: ArchifyLifecycle): Record<string, unknown> {
  const preset = new Map(doc.states.flatMap((s) => (s.col !== undefined ? [[s.id, s.col] as const] : [])));
  const { rank } = denseRanks(assignRanks(doc.states.map((s) => s.id), doc.transitions.map((t) => [t.from, t.to]), preset));
  const pinned = !!doc.meta.repository;
  return {
    schema_version: 2,
    diagram_type: "lifecycle",
    meta: meta(doc),
    lanes: doc.lanes,
    states: doc.states.map((s) => clean({ id: s.id, type: s.type, label: s.label, sublabel: s.sublabel, tag: s.tag, sources: sources(s, pinned).sources, step: s.step, lane: s.lane, col: Math.min(4, s.col ?? rank.get(s.id) ?? 0) })),
    transitions: doc.transitions.map((t) => clean(t)),
    ...(doc.cards.length ? { cards: doc.cards } : {}),
  };
}

function sequence(doc: ArchifySequence): Record<string, unknown> {
  const y = (at: number) => 170 + at * 32;
  const pinned = !!doc.meta.repository;
  const activations = activationsOf(doc);
  return {
    schema_version: 1,
    diagram_type: "sequence",
    meta: meta(doc),
    participants: doc.participants.map((p) => clean({ id: p.id, type: p.type, label: p.label, sublabel: p.sublabel, sources: sources(p, pinned).sources })),
    ...(doc.phases.length ? { segments: doc.phases.map((p) => ({ from: y(p.from) - 14, to: y(p.to) + 14, label: p.label })) } : {}),
    messages: doc.messages.map((m, at) => clean({ id: m.id, from: m.from, to: m.to, y: y(at), label: m.label, variant: m.variant, note: m.note })),
    ...(activations.length ? { activations: activations.map((a) => ({ participant: a.participant, from: y(a.from) - 10, to: y(a.to) + 10 })) } : {}),
    ...(doc.cards.length ? { cards: doc.cards } : {}),
  };
}

/** The document in archify's own shape, with everything archify requires filled in. */
export function toArchifyJson(doc: ArchifyDocument): Record<string, unknown> {
  switch (doc.diagram_type) {
    case "architecture":
      return architecture(doc);
    case "workflow":
      return workflow(doc);
    case "sequence":
      return sequence(doc);
    case "dataflow":
      return dataflow(doc);
    case "lifecycle":
      return lifecycle(doc);
  }
}

/** Whether `original` already says everything archify requires, and about the same entities as `doc`. */
function complete(original: unknown, doc: ArchifyDocument): boolean {
  if (!original || typeof original !== "object") return false;
  const raw = original as Record<string, unknown>;
  const m = raw.meta as Record<string, unknown> | undefined;
  if (!m || typeof m.output !== "string" || !portableOutput(m.output)) return false;
  const list = (key: string) => (Array.isArray(raw[key]) ? (raw[key] as Record<string, unknown>[]) : []);
  const ids = (key: string, expected: string[]) => {
    const found = list(key).map((e) => e?.id);
    return found.length === expected.length && found.every((id, at) => id === expected[at]);
  };
  const hasSources = (key: string) => list(key).some((e) => e?.sources);
  if (hasSources(doc.diagram_type === "architecture" ? "components" : doc.diagram_type === "sequence" ? "participants" : doc.diagram_type === "lifecycle" ? "states" : "nodes") && !m.repository) return false;
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  switch (doc.diagram_type) {
    case "architecture":
      return ids("components", doc.components.map((c) => c.id)) && list("components").every((c) => Array.isArray(c.pos) || (raw.layout && int(c.row) && int(c.col)));
    case "workflow":
      return ids("nodes", doc.nodes.map((n) => n.id)) && list("lanes").length > 0 && list("nodes").every((n) => typeof n.lane === "string" && int(n.col));
    case "dataflow":
      return ids("nodes", doc.nodes.map((n) => n.id)) && list("stages").length > 0 && list("nodes").every((n) => int(n.stage) && int(n.row));
    case "lifecycle":
      return ids("states", doc.states.map((s) => s.id)) && list("lanes").length > 0 && list("states").every((s) => typeof s.lane === "string" && int(s.col));
    case "sequence":
      return ids("participants", doc.participants.map((p) => p.id)) && list("messages").length === doc.messages.length && list("messages").every((x) => typeof x.y === "number" && x.y >= 160);
  }
}

/** The text of the file to save: the original when it needed nothing, the completed one otherwise. */
export function archifySourceFile(original: string, doc: ArchifyDocument): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(original);
  } catch {
    // Not JSON — the completed copy below is all there is.
  }
  if (complete(parsed, doc)) return original.endsWith("\n") ? original : `${original}\n`;
  return `${JSON.stringify(toArchifyJson(doc), null, 2)}\n`;
}

/**
 * What is stored for a diagram an engine wrote: archify's own document, so the file a repository
 * keeps (`diagrams_save_to_repo`) is one archify's CLI can read — with one exception. An
 * architecture is stored **without positions**: archify wants them, but they are this app's layout,
 * and writing them in would freeze it — a better layout later could never reach a diagram already
 * made. [`archifySourceFile`] writes them, at export, for the one thing that needs them.
 */
export function storedDocument(doc: ArchifyDocument): string {
  if (doc.diagram_type === "architecture") {
    const { meta, components, boundaries, connections, cards } = doc;
    return `${JSON.stringify({ schema_version: 1, diagram_type: "architecture", meta, components, boundaries, connections, cards }, null, 2)}\n`;
  }
  return `${JSON.stringify(toArchifyJson(doc), null, 2)}\n`;
}
