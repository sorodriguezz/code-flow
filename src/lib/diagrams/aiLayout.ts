import {
  EDGE_STYLES,
  SHAPES,
  resolveEdgeKind,
  resolveKind,
  type EdgeKind,
  type Kind,
  type Shape,
} from "./shapes";
import { anchors, edge, model, vertex } from "./mxgraph";

/**
 * Turning what an engine described into a diagram.
 *
 * **The engine describes; this places.** `ai::draw_diagram` asks for nodes and edges and forbids
 * coordinates, because models are poor at placing boxes and worse at being consistent about it — a
 * generated diagram whose shapes overlap is one nobody keeps. Everything about *where things go* is
 * decided here, deterministically, so pressing the button twice on the same description gives the
 * same picture.
 *
 * **What the engine chooses is which shape, out of a catalogue** (`shapes.ts`) — and that is the
 * other half of the split. It used to choose between eight, which is why every generated diagram
 * came out as blue rectangles regardless of what draw.io could actually draw; it now chooses a name
 * from a list of eighty verified ones, with `resolveKind` catching the synonyms. A model asked for
 * a *word from a list* gets it right; a model asked for an mxGraph style string invents one, and an
 * invented style string renders as a plain rectangle rather than as an error.
 *
 * The layout is a **banded layered** one: rank each node by how far it is from a source, put each
 * rank on its own row, and give every group its own band across the cross axis so a container can
 * be drawn round its members without two containers ever overlapping. It is not clever and does not
 * need to be — a described diagram is a handful of boxes in a mostly-linear flow, and anything
 * fancier would be guessing at an intent the user is about to correct by hand anyway.
 */

export type { Kind, EdgeKind } from "./shapes";

/** Which way the flow runs. `down` is a flowchart; `right` is how an architecture usually reads. */
export type Direction = "down" | "right";

export interface AiNode {
  id: string;
  label: string;
  kind: Kind;
  /** The id of a container node this one sits inside, or `null`. One level only — see `layoutGraph`. */
  group: string | null;
  /** Compartment lines for a `class`/`entity`-shaped node: attributes, columns, methods. */
  fields: string[];
}

export interface AiEdge {
  from: string;
  to: string;
  label: string;
  kind: EdgeKind;
}

export interface AiGraph {
  nodes: AiNode[];
  edges: AiEdge[];
  direction: Direction;
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
const MAX_FIELDS = 20;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function asString(value: unknown, limit = MAX_LABEL): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** Anything a model might write for "left to right". Everything else is a top-down flowchart. */
function asDirection(value: unknown): Direction {
  const raw = asString(value, 32).toLowerCase();
  return ["right", "lr", "horizontal", "left-to-right", "left to right", "derecha", "horizontal"].includes(raw)
    ? "right"
    : "down";
}

function asFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, MAX_FIELDS)) {
    const text = asString(entry);
    if (text) out.push(text);
  }
  return out;
}

/**
 * Reads an engine's answer, or explains what is wrong with it.
 *
 * Returns `{ graph }` or `{ error }` rather than throwing: a model returning something unusable is
 * an ordinary outcome of asking a model, not an exception. The panel shows the message and keeps
 * the instruction so it can be tried again.
 *
 * **Nothing here rejects a node for its `kind`.** An unrecognised one resolves to the nearest shape
 * (`resolveKind`), and in the last resort to a process box — the shape is a detail of a diagram the
 * user is about to edit by hand, and refusing the whole answer over one unfamiliar word would be
 * throwing away the twenty nodes that were right.
 *
 * **Edges to nodes that were never declared are dropped, not rejected**, for the same reason: it is
 * the commonest small mistake in a generated graph, and losing one arrow is a much better answer
 * than losing the diagram.
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
    seen.add(id);
    const group = asString((entry as { group?: unknown }).group, 64);
    nodes.push({
      id,
      // Falls back to the id so a node with no label is still identifiable rather than an empty box.
      label: asString((entry as { label?: unknown }).label) || id,
      kind: resolveKind(asString((entry as { kind?: unknown }).kind, 48)),
      group: group && group !== id ? group : null,
      fields: asFields((entry as { fields?: unknown }).fields),
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
      edges.push({
        from,
        to,
        label: asString((entry as { label?: unknown }).label),
        kind: resolveEdgeKind(asString((entry as { kind?: unknown }).kind, 48)),
      });
    }
  }

  return {
    graph: { nodes, edges, direction: asDirection((parsed as { direction?: unknown }).direction) },
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Between two ranks, along the direction of flow. */
const RANK_GAP = 70;
/** Between two siblings on the same rank. */
const SIBLING_GAP = 55;
/** Between two group bands. */
const BAND_GAP = 44;
/** Breathing room a container leaves around its members… */
const GROUP_PAD = 22;
/** …and the extra it takes at the top for its own title. */
const GROUP_HEADER = 30;
const MARGIN = 40;
/** How wide a growable box is allowed to get before the label wraps instead. */
const MAX_NODE_WIDTH = 320;
/** Rough advance width of the 12px label font, and the height of one compartment line. */
const CHAR_WIDTH = 7;
const FIELD_LINE = 16;

export interface PlacedNode {
  node: AiNode;
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
}

export interface PlacedGroup {
  node: AiNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A described graph, placed.
 *
 * Exported so the panel's preview and the mxGraph writer are the *same* layout rather than two that
 * agree by inspection: a thumbnail that shows a different arrangement from the one that lands on
 * the canvas is worse than no thumbnail, because it is the picture the decision was made on.
 */
export interface Layout {
  nodes: PlacedNode[];
  groups: PlacedGroup[];
  edges: AiEdge[];
  width: number;
  height: number;
  direction: Direction;
}

/**
 * A kind's optional flags, read through the `Shape` interface.
 *
 * `SHAPES` is `as const`, so indexing it gives one of eighty *literal* object types and the optional
 * keys only exist on the entries that set them. Widening to `Shape` here is what lets the rest of
 * this file ask `traits(kind).grow` instead of `"grow" in shape && shape.grow` at five call sites.
 */
export function traits(kind: Kind): { grow: boolean; compartments: boolean; container: boolean } {
  const shape: Shape = SHAPES[kind];
  return {
    grow: shape.grow === true,
    compartments: shape.compartments === true,
    container: shape.container === true,
  };
}

/** How big a box has to be to hold what it says. */
function measure(node: AiNode): { width: number; height: number } {
  const shape: Shape = SHAPES[node.kind];
  const { grow, compartments } = traits(node.kind);
  let width = shape.width;
  let height = shape.height;
  // Fields on a fixed-aspect icon are dropped rather than drawn: there is nowhere in a 78-pixel
  // AWS glyph to put six column names, and stretching it to fit them is how an icon stops being
  // recognisable. `labelFor` makes the same call, from the same test.
  const lines = grow ? node.fields : [];
  if (grow) {
    const widest = Math.max(node.label.length, ...lines.map((line) => line.length), 0);
    width = Math.max(width, Math.min(MAX_NODE_WIDTH, widest * CHAR_WIDTH + 28));
    // Two lines of label fit in the base height; a third and a fourth have to be paid for, or a
    // long label in a fixed box is drawn straight through the shape's own outline.
    const wrapped = Math.ceil((node.label.length * CHAR_WIDTH) / Math.max(1, width - 24));
    if (wrapped > 2) height += (wrapped - 2) * 18;
  }
  if (lines.length > 0) height += lines.length * FIELD_LINE + (compartments ? 12 : 4);
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * The edges with the cycles taken out — a depth-first pass, dropping every edge that points back at
 * a node still on the stack.
 *
 * **The ranking below cannot see a cycle**, and this is what stands between it and one. A described
 * graph contains loops constantly ("retry → check → retry", "queue → worker → queue"), and a
 * longest-path relaxation over a loop just keeps pushing: each pass finds the cycle one longer than
 * the last, so it runs until the pass limit and every node in the loop ends up ranked by *how many
 * nodes the graph has* rather than by where it sits. The visible result was a worker drawn below
 * the database it writes to, twenty rows down, with the whole diagram reading backwards from there.
 * Bounding the passes stopped it looping; it did not stop it being wrong.
 *
 * The back edge is only removed from the *ranking*. It is still drawn — as an arrow pointing
 * against the flow, which is exactly what a retry loop looks like in a flowchart.
 */
function withoutBackEdges(nodes: AiNode[], edges: AiEdge[]): AiEdge[] {
  const outgoing = new Map<string, AiEdge[]>();
  for (const link of edges) {
    const list = outgoing.get(link.from);
    if (list) list.push(link);
    else outgoing.set(link.from, [link]);
  }
  const OPEN = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const back = new Set<AiEdge>();
  const visit = (id: string) => {
    state.set(id, OPEN);
    for (const link of outgoing.get(id) ?? []) {
      const at = state.get(link.to);
      if (at === OPEN) back.add(link);
      else if (at === undefined) visit(link.to);
    }
    state.set(id, DONE);
  };
  // Every node, not just the sources: a graph whose only entry point is inside a cycle has no
  // source at all, and skipping it would leave the cycle unbroken.
  for (const node of nodes) if (!state.has(node.id)) visit(node.id);
  return back.size === 0 ? edges : edges.filter((link) => !back.has(link));
}

/**
 * How far each node sits from a source, as a row number.
 *
 * Longest path rather than shortest, so a node waits for everything that feeds it — which is what
 * makes the arrows point consistently along the flow instead of jumping back a row. `edges` has
 * already had its cycles removed by `withoutBackEdges`; the pass limit below is what remains of the
 * older, weaker guard, kept because it costs nothing and a bounded loop is a bounded loop.
 */
function ranks(nodes: AiNode[], edges: AiEdge[]): Map<string, number> {
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const link of edges) {
      const from = rank.get(link.from);
      const to = rank.get(link.to);
      if (from === undefined || to === undefined) continue;
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
 * Places a described graph.
 *
 * **Groups are bands, not bounding boxes computed after the fact.** Every container gets its own
 * strip across the cross axis and its members are laid out inside that strip, which is what makes
 * "draw a box round these four" safe: two containers can never overlap, because they never share a
 * column. The alternative — place everything, then fit a rectangle around each group — produces
 * interlocking boxes the moment two groups have members on the same row, and an interlocking
 * container in draw.io is not a cosmetic problem: dragging one moves the other's shapes.
 *
 * **One level of nesting only.** A container that names a `group` itself is treated as top-level,
 * and a member pointing at something that isn't a container (or at nothing) is treated as
 * ungrouped. Both are model mistakes with an obvious safe reading, and the alternative is a
 * recursive layout for a feature whose whole job is to draw a box round four boxes.
 */
export function layoutGraph(graph: AiGraph): Layout {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const isContainer = (node: AiNode) => traits(node.kind).container;

  /** Containers that actually contain something. An empty one is a box round nothing. */
  const used = new Set(
    graph.nodes
      .filter((node) => !isContainer(node) && node.group)
      .map((node) => node.group as string)
      .filter((id) => {
        const target = byId.get(id);
        return target !== undefined && isContainer(target);
      }),
  );
  const containers = graph.nodes.filter((node) => isContainer(node) && used.has(node.id));
  const content = graph.nodes.filter((node) => !isContainer(node));
  const groupOf = (node: AiNode) => (node.group && used.has(node.group) ? node.group : "");

  const rank = ranks(content, withoutBackEdges(content, graph.edges));
  const size = new Map(content.map((node) => [node.id, measure(node)] as const));
  /** Along the flow, and across it. Swapping these two here is the whole of `direction`. */
  const mainOf = (id: string) =>
    graph.direction === "down" ? (size.get(id)?.height ?? 0) : (size.get(id)?.width ?? 0);
  const crossOf = (id: string) =>
    graph.direction === "down" ? (size.get(id)?.width ?? 0) : (size.get(id)?.height ?? 0);

  // Rank extents are global so the rows line up across every band — a container whose contents sat
  // half a row above its neighbour's would read as two diagrams side by side.
  const rankMain = new Map<number, number>();
  for (const node of content) {
    const at = rank.get(node.id) ?? 0;
    rankMain.set(at, Math.max(rankMain.get(at) ?? 0, mainOf(node.id)));
  }
  const rankStart = new Map<number, number>();
  let main = MARGIN + (containers.length > 0 ? GROUP_HEADER : 0);
  for (const at of [...rankMain.keys()].sort((a, b) => a - b)) {
    rankStart.set(at, main);
    main += (rankMain.get(at) ?? 0) + RANK_GAP;
  }

  // Bands, in the order their first member was described — which is the only ordering the engine
  // gave, and respecting it keeps a described left-to-right reading left-to-right on the page.
  const bandOrder: string[] = [];
  const bandNodes = new Map<string, AiNode[]>();
  for (const node of content) {
    const key = groupOf(node);
    let bucket = bandNodes.get(key);
    if (!bucket) {
      bucket = [];
      bandNodes.set(key, bucket);
      bandOrder.push(key);
    }
    bucket.push(node);
  }

  const placed: PlacedNode[] = [];
  const groups: PlacedGroup[] = [];
  let cross = MARGIN;

  for (const key of bandOrder) {
    const members = bandNodes.get(key) ?? [];
    const pad = key ? GROUP_PAD : 0;
    /** The band's rows, each in described order. */
    const rows = new Map<number, AiNode[]>();
    for (const node of members) {
      const at = rank.get(node.id) ?? 0;
      const row = rows.get(at);
      if (row) row.push(node);
      else rows.set(at, [node]);
    }
    const rowCross = (row: AiNode[]) =>
      row.reduce((total, node) => total + crossOf(node.id) + SIBLING_GAP, -SIBLING_GAP);
    const bandCross = Math.max(0, ...[...rows.values()].map(rowCross));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [at, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      // Centred within the band, so a row of one under a row of four is under its middle.
      let offset = cross + pad + Math.round((bandCross - rowCross(row)) / 2);
      const start = rankStart.get(at) ?? MARGIN;
      for (const node of row) {
        const box = size.get(node.id) ?? { width: 0, height: 0 };
        const x = graph.direction === "down" ? offset : start;
        const y = graph.direction === "down" ? start : offset;
        placed.push({ node, x, y, width: box.width, height: box.height, rank: at });
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + box.width);
        maxY = Math.max(maxY, y + box.height);
        offset += crossOf(node.id) + SIBLING_GAP;
      }
    }

    if (key && minX !== Infinity) {
      const container = byId.get(key);
      // The header is taken off the top in *screen* space whichever way the flow runs: both the
      // swimlane and the plain group style put their title on top, and a box whose title sat on its
      // left in a left-to-right diagram would be the one shape nobody could read.
      if (container) {
        groups.push({
          node: container,
          x: minX - GROUP_PAD,
          y: minY - GROUP_PAD - GROUP_HEADER,
          width: maxX - minX + GROUP_PAD * 2,
          height: maxY - minY + GROUP_PAD * 2 + GROUP_HEADER,
        });
      }
    }

    cross += bandCross + pad * 2 + BAND_GAP;
  }

  const right = Math.max(
    0,
    ...placed.map((entry) => entry.x + entry.width),
    ...groups.map((entry) => entry.x + entry.width),
  );
  const bottom = Math.max(
    0,
    ...placed.map((entry) => entry.y + entry.height),
    ...groups.map((entry) => entry.y + entry.height),
  );

  return {
    nodes: placed,
    groups,
    // Edges between two nodes that were placed. A container is not placed as a node, so an arrow
    // drawn to one is dropped rather than left dangling at a cell that has no geometry.
    edges: graph.edges.filter(
      (link) =>
        placed.some((entry) => entry.node.id === link.from) &&
        placed.some((entry) => entry.node.id === link.to),
    ),
    width: right + MARGIN,
    height: bottom + MARGIN,
    direction: graph.direction,
  };
}

// ---------------------------------------------------------------------------
// mxGraph
// ---------------------------------------------------------------------------

/** Escapes text that is about to become part of an *HTML* label, before `vertex` escapes it again
 *  for the XML attribute it lives in. Both passes are needed: the attribute decodes once, and what
 *  is left has to still be the markup draw.io should render. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A node's label, with its compartments if it has any.
 *
 * draw.io's own class shape is a `swimlane` with one child cell per attribute, which is the right
 * answer for a diagram somebody is going to edit compartment by compartment and much too much
 * machinery for one that is about to be. An HTML label — bold name, rule, left-aligned lines —
 * renders identically at this size, is one cell instead of nine, and survives the user dragging the
 * box somewhere else.
 */
function labelFor(node: AiNode): string {
  const { grow, compartments } = traits(node.kind);
  // The plain path returns the label untouched, so a node without fields writes exactly the markup
  // it did before any of this existed.
  if (node.fields.length === 0 || !grow) return node.label;
  const rows = node.fields.map(escapeHtmlText).join("<br/>");
  return compartments
    ? `<b>${escapeHtmlText(node.label)}</b><hr size="1"/><div style="text-align:left">${rows}</div>`
    : // Fields on a shape that has no compartments — a model attaching columns to a cylinder, say.
      // Smaller and beneath, rather than thrown away: they are content the user asked for, and the
      // shape they were hung on is the part that was a guess.
      `${escapeHtmlText(node.label)}<br/><span style="font-size:10px">${rows}</span>`;
}

/**
 * A described graph as an mxGraph document.
 *
 * Ids are prefixed so a `merge` into an existing diagram cannot collide with a shape already on the
 * canvas — draw.io's merge matches on id, and a generated `n1` landing on a hand-drawn `n1` would
 * silently replace it.
 *
 * **Containers are emitted first and their members are parented to them**, with geometry relative
 * to the container's own origin, which is what mxGraph means by a child cell. Drawing the box and
 * leaving the shapes on the layer would look the same and behave differently in the one way that
 * matters: dragging the container would leave its contents behind.
 */
export function graphToMxGraph(graph: AiGraph, idPrefix: string): string {
  const layout = layoutGraph(graph);
  const cells: string[] = [];

  const groupAt = new Map(layout.groups.map((entry) => [entry.node.id, entry]));
  for (const entry of layout.groups) {
    cells.push(
      vertex({
        id: `${idPrefix}${entry.node.id}`,
        value: entry.node.label,
        style: SHAPES[entry.node.kind].style,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
      }),
    );
  }

  for (const entry of layout.nodes) {
    const parent = entry.node.group ? groupAt.get(entry.node.group) : undefined;
    cells.push(
      vertex({
        id: `${idPrefix}${entry.node.id}`,
        value: labelFor(entry.node),
        style: SHAPES[entry.node.kind].style,
        x: parent ? entry.x - parent.x : entry.x,
        y: parent ? entry.y - parent.y : entry.y,
        width: entry.width,
        height: entry.height,
        parent: parent ? `${idPrefix}${parent.node.id}` : undefined,
      }),
    );
  }

  const rankOf = new Map(layout.nodes.map((entry) => [entry.node.id, entry.rank]));
  layout.edges.forEach((link, index) => {
    /**
     * An edge that goes *forward* along the flow leaves one face and arrives at the opposite one.
     *
     * Without this the router picks its own sides, and a fan-in — four servers into one database —
     * comes out as lines that pass straight through the sibling boxes between them. Anchoring only
     * the forward edges is deliberate: a back edge (a retry loop) has no natural side, and forcing
     * one on it draws a line through everything it passes.
     */
    const forward = (rankOf.get(link.to) ?? 0) > (rankOf.get(link.from) ?? 0);
    const route = forward
      ? layout.direction === "down"
        ? anchors({ x: 0.5, y: 1 }, { x: 0.5, y: 0 })
        : anchors({ x: 1, y: 0.5 }, { x: 0, y: 0.5 })
      : "";
    cells.push(
      edge({
        id: `${idPrefix}e${index}`,
        source: `${idPrefix}${link.from}`,
        target: `${idPrefix}${link.to}`,
        value: link.label,
        style: `edgeStyle=orthogonalEdgeStyle;${EDGE_STYLES[link.kind]}${route}`,
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
    // Compartment labels arrive as HTML; the tags are markup this hint has no use for, and left in
    // they would spend a third of the budget on `<div style="text-align:left">`.
    const text = unescapeXml(match[1]).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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
