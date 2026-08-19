import { memo, useMemo } from "react";
import { layoutGraph, traits, type AiEdge, type AiGraph, type Layout, type PlacedNode } from "../../lib/diagrams/aiLayout";
import { SHAPES, labelBelow, styleColors, type EdgeKind, type Glyph } from "../../lib/diagrams/shapes";

/**
 * A generated diagram, drawn small, before it is put on the canvas.
 *
 * **This is the thing being decided on.** The panel used to answer "what did it come up with?" with
 * a list of labels, which says what the boxes are called and nothing at all about what was drawn —
 * whether the flow branches, whether the four services really ended up inside the VPC, whether the
 * arrow everyone cares about points the right way. Those are the questions an Add-to-canvas button
 * is asking, and a sentence of comma-separated words cannot answer any of them.
 *
 * **It renders `layoutGraph`'s own output**, not an approximation of it. The picture here and the
 * shapes that land in draw.io come out of one function, so a preview that looks wrong *is* wrong —
 * which is the only property that makes a preview worth having. What it cannot promise is fidelity
 * of *shape*: draw.io draws an `mxgraph.networks.firewall` from a stencil this app does not embed,
 * so a handful of kinds are drawn here as the plain box they are shaped like. Arrangement,
 * grouping, colour and text are exact.
 *
 * A second draw.io was the obvious alternative and is not one: the editor is a 61 MB iframe with
 * its own load, and running a second instance to preview an edit to the first is a lot of machinery
 * for a thumbnail — as well as a second live editor able to write to a document the user has not
 * agreed to change yet.
 */
export const DiagramPreview = memo(function DiagramPreview({
  graph,
  className,
  zoom,
}: {
  graph: AiGraph;
  className?: string;
  /**
   * Draw at this many pixels per diagram unit, instead of scaling to fit the box.
   *
   * Fitting is the right default — the shape of the thing is what a preview is for — but a diagram
   * of twenty nodes fitted into a 340-pixel panel has labels three pixels tall, and the labels are
   * what say whether the engine understood the question. Given a zoom the SVG takes its natural
   * size and the caller scrolls it.
   */
  zoom?: number;
}) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  if (layout.nodes.length === 0) return null;

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="xMidYMid meet"
      width={zoom ? Math.round(layout.width * zoom) : undefined}
      height={zoom ? Math.round(layout.height * zoom) : undefined}
      className={className}
      role="img"
    >
      <defs>
        {/* `context-stroke` keeps a marker the colour of the line that carries it, so one set of
            definitions serves every edge instead of one set per colour. */}
        <marker id="cf-dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
        <marker id="cf-dg-hollow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L12,6 L0,12 z" fill="var(--cf-surface)" stroke="context-stroke" strokeWidth="1.4" />
        </marker>
        <marker id="cf-dg-diamond" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,5 L7,0 L14,5 L7,10 z" fill="context-stroke" />
        </marker>
        <marker id="cf-dg-diamond-open" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,5 L7,0 L14,5 L7,10 z" fill="var(--cf-surface)" stroke="context-stroke" strokeWidth="1.4" />
        </marker>
        <marker id="cf-dg-crow" viewBox="0 0 10 12" refX="9" refY="6" markerWidth="7" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L10,6 M0,6 L10,6 M0,12 L10,6" fill="none" stroke="context-stroke" strokeWidth="1.4" />
        </marker>
      </defs>

      {layout.groups.map((group) => {
        const colors = styleColors(SHAPES[group.node.kind].style);
        return (
          <g key={`g-${group.node.id}`}>
            <rect
              x={group.x}
              y={group.y}
              width={group.width}
              height={group.height}
              rx={10}
              fill="none"
              stroke={colors.stroke}
              strokeWidth={2}
              strokeDasharray="10 6"
            />
            <text
              x={group.x + 12}
              y={group.y + 22}
              fontSize={15}
              fontWeight={600}
              fill={colors.stroke}
            >
              {clip(group.node.label, group.width / 8)}
            </text>
          </g>
        );
      })}

      {/* Under the shapes on purpose: a back edge is drawn centre to centre, and the half of it
          that would cross its own endpoints is exactly the half a box should cover. */}
      <g>
        {layout.edges.map((link, at) => (
          <Edge key={`e-${at}`} link={link} layout={layout} />
        ))}
      </g>

      {layout.nodes.map((placed) => (
        <Node key={`n-${placed.node.id}`} placed={placed} />
      ))}
    </svg>
  );
});

/** Roughly how many characters fit, since SVG has no wrapping and measuring costs a reflow. */
function clip(text: string, chars: number): string {
  const limit = Math.max(4, Math.floor(chars));
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Which marker an edge kind wears, and whether it is drawn as a dashed line. */
const EDGE_MARKS: Record<EdgeKind, { end: string | null; start?: string; dash?: boolean }> = {
  flow: { end: "cf-dg-arrow" },
  dashed: { end: "cf-dg-arrow", dash: true },
  async: { end: "cf-dg-arrow", dash: true },
  bidirectional: { end: "cf-dg-arrow", start: "cf-dg-arrow" },
  plain: { end: null },
  inheritance: { end: "cf-dg-hollow" },
  implementation: { end: "cf-dg-hollow", dash: true },
  composition: { end: "cf-dg-diamond" },
  aggregation: { end: "cf-dg-diamond-open" },
  dependency: { end: "cf-dg-arrow", dash: true },
  association: { end: "cf-dg-arrow" },
  message: { end: "cf-dg-arrow" },
  "one-to-one": { end: null },
  "one-to-many": { end: "cf-dg-crow" },
  "many-to-many": { end: "cf-dg-crow", start: "cf-dg-crow" },
  "zero-or-one": { end: null },
};

function Edge({ link, layout }: { link: AiEdge; layout: Layout }) {
  const from = layout.nodes.find((entry) => entry.node.id === link.from);
  const to = layout.nodes.find((entry) => entry.node.id === link.to);
  if (!from || !to) return null;

  const forward = to.rank > from.rank;
  const mark = EDGE_MARKS[link.kind];
  const points = forward
    ? layout.direction === "down"
      ? elbow(
          { x: from.x + from.width / 2, y: from.y + from.height },
          { x: to.x + to.width / 2, y: to.y },
          "v",
        )
      : elbow(
          { x: from.x + from.width, y: from.y + from.height / 2 },
          { x: to.x, y: to.y + to.height / 2 },
          "h",
        )
    : back(from, to, layout.direction);

  const mid = points[Math.floor(points.length / 2)];
  return (
    <g>
      <polyline
        points={points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none"
        stroke="var(--cf-text-muted)"
        strokeWidth={2}
        strokeDasharray={mark.dash ? "8 5" : undefined}
        markerEnd={mark.end ? `url(#${mark.end})` : undefined}
        markerStart={mark.start ? `url(#${mark.start})` : undefined}
      />
      {link.label && (
        <text
          x={mid.x}
          y={mid.y - 5}
          fontSize={13}
          textAnchor="middle"
          fill="var(--cf-text-muted)"
          // A halo in the preview's own background colour, so a label crossing a line or a
          // container's title stays readable instead of printing on top of it.
          style={{ paintOrder: "stroke", stroke: "var(--cf-surface)", strokeWidth: 5 }}
        >
          {clip(link.label, 18)}
        </text>
      )}
    </g>
  );
}

/**
 * A back edge — the retry loop, the "and round again" — routed out to the side and up.
 *
 * Straight from centre to centre was the first version and it draws a diagonal across the middle of
 * the diagram, through whatever happens to be between the two ends. Neither route is what draw.io's
 * own orthogonal router will finally pick (that is the one thing about a generated diagram this
 * preview cannot promise, because the router decides at render time), so the choice is between two
 * approximations — and going round the outside is both the tidier one and the one an orthogonal
 * router actually tends to produce.
 */
function back(
  from: PlacedNode,
  to: PlacedNode,
  direction: Layout["direction"],
): { x: number; y: number }[] {
  if (direction === "down") {
    const lane = Math.min(from.x, to.x) - 28;
    const a = from.y + from.height / 2;
    const b = to.y + to.height / 2;
    return [{ x: from.x, y: a }, { x: lane, y: a }, { x: lane, y: b }, { x: to.x, y: b }];
  }
  const lane = Math.min(from.y, to.y) - 28;
  const a = from.x + from.width / 2;
  const b = to.x + to.width / 2;
  return [{ x: a, y: from.y }, { x: a, y: lane }, { x: b, y: lane }, { x: b, y: to.y }];
}

/** The three-segment route mxGraph's orthogonal router draws for a forward edge. */
function elbow(a: { x: number; y: number }, b: { x: number; y: number }, axis: "v" | "h") {
  if (axis === "v") {
    if (a.x === b.x) return [a, b];
    const mid = (a.y + b.y) / 2;
    return [a, { x: a.x, y: mid }, { x: b.x, y: mid }, b];
  }
  if (a.y === b.y) return [a, b];
  const mid = (a.x + b.x) / 2;
  return [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
}

function Node({ placed }: { placed: PlacedNode }) {
  const { node, x, y, width, height } = placed;
  const shape = SHAPES[node.kind];
  const colors = styleColors(shape.style);
  const { compartments, grow } = traits(node.kind);
  const fields = grow ? node.fields : [];
  // Icon-shaped kinds write their name underneath, which is what draw.io does with them — and the
  // only way a 40-pixel stick figure gets to be called anything longer than "Clie…".
  const below = labelBelow(shape.style);
  const ink = below
    ? "var(--cf-text)"
    : colors.font !== "currentColor"
      ? colors.font
      : colors.fill === "transparent"
        ? "var(--cf-text)"
        : "#1f2430";

  // A compartment shape puts its name in a band at the top; everything else centres it.
  const titleY = below ? y + height + 17 : compartments || fields.length > 0 ? y + 20 : y + height / 2 + 5;

  return (
    <g>
      <Glyph shape={shape.glyph} x={x} y={y} width={width} height={height} fill={colors.fill} stroke={colors.stroke} />
      {node.kind !== "initial" && node.kind !== "final" && node.kind !== "fork" && (
        <text
          x={x + width / 2}
          y={titleY}
          fontSize={14}
          fontWeight={compartments ? 700 : 500}
          textAnchor="middle"
          fill={ink}
        >
          {/* A label written underneath is not bounded by the shape, so it is allowed a sentence's
              worth of room rather than the four characters an icon's own width would permit. */}
          {clip(node.label, Math.max(width, 150) / 7.4)}
        </text>
      )}
      {fields.length > 0 && (
        <>
          {compartments && (
            <line x1={x} y1={y + 28} x2={x + width} y2={y + 28} stroke={colors.stroke} strokeWidth={1} />
          )}
          {fields.map((field, at) => (
            <text
              key={at}
              x={x + 9}
              y={y + (compartments ? 46 : 38) + at * 16}
              fontSize={12}
              fill={ink}
              opacity={0.85}
            >
              {clip(field, (width - 18) / 6.4)}
            </text>
          ))}
        </>
      )}
    </g>
  );
}

/**
 * The outline of a kind.
 *
 * Not a stencil library — a dozen primitives that cover eighty kinds, because what this picture has
 * to answer is "is that a decision, a database or a person?" and a diamond, a cylinder and a stick
 * figure answer it. The kinds draw.io renders from a stencil (`mxgraph.networks.*`, the AWS icons)
 * fall back to their bounding box, which is what they look like from across the room anyway.
 */
function Glyph({
  shape,
  x,
  y,
  width,
  height,
  fill,
  stroke,
}: {
  shape: Glyph;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
}) {
  const common = { fill, stroke, strokeWidth: 2 } as const;
  const right = x + width;
  const bottom = y + height;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const inset = Math.min(width, height) * 0.22;

  switch (shape) {
    case "round":
      return <rect x={x} y={y} width={width} height={height} rx={10} {...common} />;
    case "ellipse":
      return <ellipse cx={cx} cy={cy} rx={width / 2} ry={height / 2} {...common} />;
    case "circle":
    case "dot":
      return (
        <circle
          cx={cx}
          cy={cy}
          r={Math.min(width, height) / 2}
          fill={shape === "dot" ? stroke : fill}
          stroke={stroke}
          strokeWidth={2}
        />
      );
    case "rhombus":
      return <polygon points={`${cx},${y} ${right},${cy} ${cx},${bottom} ${x},${cy}`} {...common} />;
    case "parallelogram":
      return (
        <polygon
          points={`${x + inset},${y} ${right},${y} ${right - inset},${bottom} ${x},${bottom}`}
          {...common}
        />
      );
    case "hexagon":
      return (
        <polygon
          points={`${x + inset},${y} ${right - inset},${y} ${right},${cy} ${right - inset},${bottom} ${x + inset},${bottom} ${x},${cy}`}
          {...common}
        />
      );
    case "trapezoid":
      return (
        <polygon
          points={`${x},${y} ${right},${y} ${right - inset},${bottom} ${x + inset},${bottom}`}
          {...common}
        />
      );
    case "cylinder": {
      const lip = Math.min(height * 0.18, 16);
      return (
        <path
          d={`M${x},${y + lip} A${width / 2},${lip} 0 0 1 ${right},${y + lip} L${right},${bottom - lip} A${width / 2},${lip} 0 0 1 ${x},${bottom - lip} Z M${x},${y + lip} A${width / 2},${lip} 0 0 0 ${right},${y + lip}`}
          {...common}
        />
      );
    }
    case "cylinder-h": {
      const lip = Math.min(width * 0.14, 16);
      return (
        <path
          d={`M${x + lip},${y} A${lip},${height / 2} 0 0 0 ${x + lip},${bottom} L${right - lip},${bottom} A${lip},${height / 2} 0 0 0 ${right - lip},${y} Z M${right - lip},${y} A${lip},${height / 2} 0 0 0 ${right - lip},${bottom}`}
          {...common}
        />
      );
    }
    case "document":
      return (
        <path
          d={`M${x},${y} L${right},${y} L${right},${bottom - 14} Q${cx + width / 4},${bottom - 30} ${cx},${bottom - 14} Q${cx - width / 4},${bottom + 2} ${x},${bottom - 14} Z`}
          {...common}
        />
      );
    case "note": {
      const fold = Math.min(width, height) * 0.28;
      return (
        <path
          d={`M${x},${y} L${right - fold},${y} L${right},${y + fold} L${right},${bottom} L${x},${bottom} Z M${right - fold},${y} L${right - fold},${y + fold} L${right},${y + fold}`}
          {...common}
        />
      );
    }
    case "card": {
      const cut = Math.min(width, height) * 0.24;
      return (
        <polygon
          points={`${x + cut},${y} ${right},${y} ${right},${bottom} ${x},${bottom} ${x},${y + cut}`}
          {...common}
        />
      );
    }
    case "cloud":
      return (
        <path
          d={`M${x + width * 0.25},${bottom - height * 0.1} a${width * 0.16},${height * 0.2} 0 0 1 ${-width * 0.05},${-height * 0.38} a${width * 0.2},${height * 0.26} 0 0 1 ${width * 0.28},${-height * 0.2} a${width * 0.2},${height * 0.24} 0 0 1 ${width * 0.36},${height * 0.06} a${width * 0.16},${height * 0.24} 0 0 1 ${width * 0.02},${height * 0.52} Z`}
          {...common}
        />
      );
    case "actor": {
      const head = Math.min(width, height) * 0.28;
      return (
        <g fill="none" stroke={stroke} strokeWidth={2.5} strokeLinecap="round">
          <circle cx={cx} cy={y + head} r={head} fill={fill} />
          <path
            d={`M${cx},${y + head * 2} L${cx},${y + height * 0.68} M${x},${y + height * 0.42} L${right},${y + height * 0.42} M${cx},${y + height * 0.68} L${x},${bottom} M${cx},${y + height * 0.68} L${right},${bottom}`}
          />
        </g>
      );
    }
    case "person": {
      const head = Math.min(width, height) * 0.2;
      return (
        <g>
          <rect x={x} y={y + head * 1.7} width={width} height={height - head * 1.7} rx={12} {...common} />
          <circle cx={cx} cy={y + head} r={head} fill={fill} stroke={stroke} strokeWidth={2} />
        </g>
      );
    }
    case "bar":
      return <rect x={x} y={y} width={width} height={height} fill={stroke} />;
    case "tab": {
      const tab = Math.min(width * 0.42, 80);
      const lip = 16;
      return (
        <path
          d={`M${x},${y + lip} L${x},${y} L${x + tab},${y} L${x + tab},${y + lip} L${right},${y + lip} L${right},${bottom} L${x},${bottom} Z`}
          {...common}
        />
      );
    }
    case "text":
      return null;
    case "compartments":
    case "container":
    case "rect":
    default:
      return <rect x={x} y={y} width={width} height={height} {...common} />;
  }
}
