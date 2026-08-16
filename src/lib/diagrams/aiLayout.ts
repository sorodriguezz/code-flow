import { anchors, edge, model, vertex } from "./mxgraph";

/**
 * Turning what an engine described into a diagram.
 *
 * **The engine describes; this places.** `ai::draw_diagram` asks for nodes and edges and forbids
 * coordinates, because models are poor at placing boxes and worse at being consistent about it — a
 * generated diagram whose shapes overlap is one nobody keeps. Everything about *where things go*
 * is decided here, deterministically, so pressing the button twice on the same description gives
 * the same picture.
 *
 * The layout is a plain layered one: rank each node by how far it is from a source, put each rank
 * on its own row, centre the rows. It is not clever and does not need to be — a described diagram
 * is a handful of boxes in a mostly-linear flow, and anything fancier would be guessing at an
 * intent the user is about to correct by hand anyway.
 */

/** What the engine is allowed to say a node is. Anything else is drawn as a process. */
const KINDS = [
  "start",
  "end",
  "process",
  "decision",
  "data",
  "store",
  "actor",
  "external",
] as const;
type Kind = (typeof KINDS)[number];

export interface AiNode {
  id: string;
  label: string;
  kind: Kind;
}

export interface AiEdge {
  from: string;
  to: string;
  label: string;
}

export interface AiGraph {
  nodes: AiNode[];
  edges: AiEdge[];
}

/**
 * Caps, applied at the boundary rather than trusted from the prompt.
 *
 * The prompt asks for 3–25 nodes; this is what happens when an engine ignores it. Truncating beats
 * refusing: a user who asked for something large gets the first part of it and can ask for the
 * rest, where an error gets them nothing and no idea why.
 */
const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_LABEL = 120;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function asString(value: unknown, limit = MAX_LABEL): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/**
 * Reads an engine's answer, or explains what is wrong with it.
 *
 * Returns `{ graph }` or `{ error }` rather than throwing: a model returning something unusable is
 * an ordinary outcome of asking a model, not an exception. The panel shows the message and keeps
 * the instruction so it can be tried again.
 *
 * **Edges to nodes that were never declared are dropped, not rejected.** It is the commonest small
 * mistake in a generated graph, and losing one arrow is a much better answer than losing the
 * diagram.
 */
export function parseAiGraph(raw: string): { graph: AiGraph } | { error: "empty" | "json" | "nodes" } {
  const text = raw.trim();
  if (!text) return { error: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "json" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "json" };

  const rawNodes = (parsed as { nodes?: unknown }).nodes;
  const rawEdges = (parsed as { edges?: unknown }).edges;
  if (!Array.isArray(rawNodes)) return { error: "nodes" };

  const nodes: AiNode[] = [];
  const seen = new Set<string>();
  for (const entry of rawNodes.slice(0, MAX_NODES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = asString((entry as { id?: unknown }).id, 64);
    if (!id || seen.has(id)) continue;
    const kindRaw = asString((entry as { kind?: unknown }).kind, 32).toLowerCase();
    seen.add(id);
    nodes.push({
      id,
      // Falls back to the id so a node with no label is still identifiable rather than an empty box.
      label: asString((entry as { label?: unknown }).label) || id,
      kind: (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : "process",
    });
  }
  if (nodes.length === 0) return { error: "nodes" };

  const edges: AiEdge[] = [];
  if (Array.isArray(rawEdges)) {
    for (const entry of rawEdges.slice(0, MAX_EDGES)) {
      if (typeof entry !== "object" || entry === null) continue;
      const from = asString((entry as { from?: unknown }).from, 64);
      const to = asString((entry as { to?: unknown }).to, 64);
      // Both ends must exist, and a self-loop is dropped: mxGraph draws one, but a described graph
      // that contains one is a model mistake rather than an intent.
      if (!from || !to || from === to || !seen.has(from) || !seen.has(to)) continue;
      edges.push({ from, to, label: asString((entry as { label?: unknown }).label) });
    }
  }

  return { graph: { nodes, edges } };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const ROW_GAP = 120;
const COL_GAP = 60;
const TOP = 60;

/** Box size per kind. A decision needs width for its diamond; an actor is a stick figure. */
function sizeOf(kind: Kind): { width: number; height: number } {
  switch (kind) {
    case "decision":
      return { width: 170, height: 90 };
    case "start":
    case "end":
      return { width: 140, height: 50 };
    case "actor":
      return { width: 40, height: 70 };
    case "store":
      return { width: 150, height: 80 };
    default:
      return { width: 170, height: 60 };
  }
}

/** The palette is draw.io's own default fills, so a generated diagram looks like a drawn one
 *  rather than like output. */
function styleOf(kind: Kind): string {
  switch (kind) {
    case "start":
      return "ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;";
    case "end":
      return "ellipse;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#999999;";
    case "decision":
      return "rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;";
    case "data":
      return "shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;fillColor=#dae8fc;strokeColor=#6c8ebf;";
    case "store":
      return "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=#e1d5e7;strokeColor=#9673a6;";
    case "actor":
      return "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;";
    case "external":
      return "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#999999;";
    default:
      return "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;";
  }
}

/**
 * How far each node sits from a source, as a row number.
 *
 * Longest path rather than shortest, so a node waits for everything that feeds it — which is what
 * makes the arrows point consistently downwards instead of jumping back up a row.
 *
 * **Cycles are handled by exhaustion, not by detection.** A described graph can easily contain a
 * loop ("retry → check → retry"), and the honest options are to find the cycles or to stop
 * relaxing after a bounded number of passes. The second is four lines and its failure mode is a
 * back-edge drawn upwards, which is what a cycle looks like in a flowchart anyway.
 */
function ranks(graph: AiGraph): Map<string, number> {
  const rank = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let moved = false;
    for (const link of graph.edges) {
      const from = rank.get(link.from) ?? 0;
      const to = rank.get(link.to) ?? 0;
      if (to < from + 1) {
        rank.set(link.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return rank;
}

/**
 * A described graph as an mxGraph document.
 *
 * Ids are prefixed so a `merge` into an existing diagram cannot collide with a shape already on the
 * canvas — draw.io's merge matches on id, and a generated `n1` landing on a hand-drawn `n1` would
 * silently replace it.
 */
export function graphToMxGraph(graph: AiGraph, idPrefix: string): string {
  const rank = ranks(graph);

  // Rows, in rank order, each holding its nodes in the order they were described — which is the
  // only ordering information the engine gave, and respecting it keeps a described sequence
  // left-to-right on the page.
  const rows = new Map<number, AiNode[]>();
  for (const node of graph.nodes) {
    const at = rank.get(node.id) ?? 0;
    const row = rows.get(at);
    if (row) row.push(node);
    else rows.set(at, [node]);
  }

  const widest = Math.max(
    ...[...rows.values()].map((row) =>
      row.reduce((total, node) => total + sizeOf(node.kind).width + COL_GAP, -COL_GAP),
    ),
  );

  const cells: string[] = [];
  const placed = new Map<string, true>();
  for (const [at, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const rowWidth = row.reduce(
      (total, node) => total + sizeOf(node.kind).width + COL_GAP,
      -COL_GAP,
    );
    let x = Math.round((widest - rowWidth) / 2) + 40;
    const y = TOP + at * ROW_GAP;
    for (const node of row) {
      const { width, height } = sizeOf(node.kind);
      cells.push(
        vertex({
          id: `${idPrefix}${node.id}`,
          value: node.label,
          style: styleOf(node.kind),
          x,
          y,
          width,
          height,
        }),
      );
      placed.set(node.id, true);
      x += width + COL_GAP;
    }
  }

  graph.edges.forEach((link, index) => {
    if (!placed.has(link.from) || !placed.has(link.to)) return;
    /**
     * An edge that goes *down* a row leaves the bottom and arrives at the top.
     *
     * Without this the router picks its own sides, and a fan-in — four servers into one database —
     * comes out as horizontal lines that pass straight through the sibling boxes between them.
     * Anchoring only the downward edges is deliberate: a back edge (a retry loop) has no natural
     * side, and forcing one on it draws a line through everything it passes.
     */
    const down = (rank.get(link.to) ?? 0) > (rank.get(link.from) ?? 0);
    cells.push(
      edge({
        id: `${idPrefix}e${index}`,
        source: `${idPrefix}${link.from}`,
        target: `${idPrefix}${link.to}`,
        value: link.label,
        style: down
          ? `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;${anchors({ x: 0.5, y: 1 }, { x: 0.5, y: 0 })}`
          : undefined,
      }),
    );
  });

  return model(cells);
}

/**
 * The labels of a document, as context for the next generation.
 *
 * **Labels, not the document.** mxGraph XML is mostly geometry and style — thousands of characters
 * that tell a model nothing it can use and cost tokens all the same. What is worth sending is what
 * the boxes say, and this is a regex over `value="…"` rather than an XML parse because that is all
 * it needs to be for a hint.
 *
 * Values arrive escaped, since that is how `vertex` and the editor both write them; unescaping is
 * what makes "Entrada &amp; salida" reach the engine as a phrase rather than as markup.
 */
export function documentOutline(doc: string, limit = 4000): string {
  const labels: string[] = [];
  for (const match of doc.matchAll(/value="([^"]+)"/g)) {
    const text = unescapeXml(match[1]).trim();
    if (text) labels.push(text);
    if (labels.join(", ").length > limit) break;
  }
  return labels.join(", ").slice(0, limit);
}

/** The inverse of `escapeXml`, for reading a label back out of a document. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Last, or an escaped `&amp;lt;` would be decoded twice.
    .replace(/&amp;/g, "&");
}
