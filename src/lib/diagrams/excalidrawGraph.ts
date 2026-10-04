import { convertToExcalidrawElements, ROUNDNESS } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { Arrowhead } from "@excalidraw/excalidraw/element/types";
import { layoutGraph, type AiGraph, type AiNode, type PlacedNode } from "./aiLayout";
import { SHAPES, styleColors, type EdgeKind, type Glyph } from "./shapes";

/**
 * A generated graph as an Excalidraw scene — what "Draw with AI" puts on a whiteboard.
 *
 * The engine answers a whiteboard with the same graph it answers draw.io with, and the graph is
 * placed by the same `layoutGraph`, so the preview the user approved is the arrangement that lands
 * — only the pen differs. That is why this file exists at all rather than a prompt of its own: the
 * shape vocabulary, the caps and the validation stay one thing.
 *
 * **Imported on demand** — by the AI panel, at the moment of applying — because it pulls in
 * Excalidraw itself: `convertToExcalidrawElements` is what measures the labels and binds each arrow
 * to its two boxes, and doing either by hand is how arrows end up attached to nothing.
 *
 * Excalidraw draws three closed shapes, so the forty-odd kinds collapse onto them by silhouette:
 * a decision is a diamond, a start or an actor is an ellipse, and everything boxy is a rectangle —
 * rounded where draw.io's would be. Each keeps its kind's colours.
 */
export function graphToExcalidraw(graph: AiGraph): string {
  const layout = layoutGraph(graph);
  const skeletons: ExcalidrawElementSkeleton[] = [];

  // Groups first: a scene stacks in array order, and a group drawn last would cover its members.
  for (const group of layout.groups) {
    const colours = styleColors(SHAPES[group.node.kind].style);
    skeletons.push({
      type: "rectangle",
      id: group.node.id,
      x: group.x,
      y: group.y,
      width: group.width,
      height: group.height,
      strokeColor: colours.stroke,
      backgroundColor: "transparent",
      strokeStyle: "dashed",
      roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
      label: { text: group.node.label, verticalAlign: "top", fontSize: 16 },
    });
  }

  const placed = new Map<string, PlacedNode>();
  for (const entry of layout.nodes) {
    placed.set(entry.node.id, entry);
    const shape = SHAPES[entry.node.kind];
    const colours = styleColors(shape.style);
    const text = labelOf(entry.node);
    if (shape.glyph === "text") {
      skeletons.push({ type: "text", id: entry.node.id, x: entry.x, y: entry.y, text, fontSize: 16 });
      continue;
    }
    skeletons.push({
      type: TYPE_OF[shape.glyph] ?? "rectangle",
      id: entry.node.id,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      strokeColor: colours.stroke,
      backgroundColor: colours.fill,
      fillStyle: "solid",
      roundness: ROUNDED.has(shape.glyph) ? { type: ROUNDNESS.ADAPTIVE_RADIUS } : null,
      label: entry.node.fields.length
        ? { text, fontSize: 14, textAlign: "left", verticalAlign: "top" }
        : { text, fontSize: 16 },
    });
  }

  for (const link of layout.edges) {
    const from = placed.get(link.from);
    const to = placed.get(link.to);
    if (!from || !to) continue;
    // From the edge of one box to the edge of the other, along the line between their centres.
    // Excalidraw keeps a bound arrow's ends where it was drawn until a box moves, so the ends have
    // to be right from the start rather than left for the binding to settle.
    const start = rim(from, centre(to));
    const end = rim(to, centre(from));
    const ends = ARROWHEADS[link.kind];
    skeletons.push({
      type: "arrow",
      x: start[0],
      y: start[1],
      width: end[0] - start[0],
      height: end[1] - start[1],
      points: [
        [0, 0],
        [end[0] - start[0], end[1] - start[1]],
      ] as unknown as ExcalidrawArrowPoints,
      strokeStyle: DASHED.has(link.kind) ? "dashed" : "solid",
      startArrowhead: ends.start,
      endArrowhead: ends.end,
      start: { id: link.from },
      end: { id: link.to },
      ...(link.label ? { label: { text: link.label, fontSize: 14 } } : {}),
    });
  }

  const elements = convertToExcalidrawElements(skeletons);
  return JSON.stringify({ type: "excalidraw", version: 2, source: "codeflow", elements, appState: {}, files: {} });
}

/** The points of an arrow skeleton, as Excalidraw types them — a branded tuple list. */
type ExcalidrawArrowPoints = Extract<ExcalidrawElementSkeleton, { type: "arrow" | "line" }>["points"];

/** A node's words: its label, and under it the compartment lines a class or a table carries. */
function labelOf(node: AiNode): string {
  return node.fields.length ? `${node.label}\n\n${node.fields.join("\n")}` : node.label;
}

/** The three closed shapes Excalidraw draws, by silhouette. Anything unlisted is a rectangle. */
const TYPE_OF: Partial<Record<Glyph, "rectangle" | "ellipse" | "diamond">> = {
  rhombus: "diamond",
  ellipse: "ellipse",
  circle: "ellipse",
  dot: "ellipse",
  cloud: "ellipse",
  actor: "ellipse",
  person: "ellipse",
};

/** The boxes draw.io would round. */
const ROUNDED = new Set<Glyph>(["round", "card", "note", "compartments", "container", "tab"]);

/** The line kinds drawn broken. */
const DASHED = new Set<EdgeKind>(["dashed", "async", "implementation", "dependency"]);

/** Each line kind's two ends, in Excalidraw's arrowheads — the nearest each one has. */
const ARROWHEADS: Record<EdgeKind, { start: Arrowhead | null; end: Arrowhead | null }> = {
  flow: { start: null, end: "arrow" },
  dashed: { start: null, end: "arrow" },
  async: { start: null, end: "arrow" },
  bidirectional: { start: "arrow", end: "arrow" },
  plain: { start: null, end: null },
  inheritance: { start: null, end: "triangle_outline" },
  implementation: { start: null, end: "triangle_outline" },
  composition: { start: null, end: "diamond" },
  aggregation: { start: null, end: "diamond_outline" },
  dependency: { start: null, end: "arrow" },
  association: { start: null, end: "arrow" },
  message: { start: null, end: "triangle" },
  "one-to-one": { start: "crowfoot_one", end: "crowfoot_one" },
  "one-to-many": { start: "crowfoot_one", end: "crowfoot_many" },
  "many-to-many": { start: "crowfoot_many", end: "crowfoot_many" },
  "zero-or-one": { start: "crowfoot_one", end: "crowfoot_one" },
};

function centre(node: PlacedNode): [number, number] {
  return [node.x + node.width / 2, node.y + node.height / 2];
}

/**
 * Where the line from a box's centre towards a point leaves the box — plus a few pixels, so the
 * arrow starts just off the outline rather than on it, which is how Excalidraw draws a bound end.
 */
function rim(node: PlacedNode, towards: [number, number]): [number, number] {
  const [cx, cy] = centre(node);
  const dx = towards[0] - cx;
  const dy = towards[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const scale = Math.min(
    dx === 0 ? Infinity : node.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : node.height / 2 / Math.abs(dy),
  );
  const length = Math.hypot(dx, dy);
  const gap = 6 / length;
  return [cx + dx * (scale + gap), cy + dy * (scale + gap)];
}
