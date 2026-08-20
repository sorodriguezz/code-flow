import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clip, edgeEnds, edgePath } from "../../lib/diagramSvg";
import { layoutDbml, type DbmlLayout } from "../../lib/dbml/layout";
import { highlightFor, type DbmlSchema } from "../../lib/dbml/types";
import type { DbDiagramColumn } from "../../types/database";
import type { DiagramColumnMode, DiagramDensity, DiagramNode } from "../../lib/db/erLayout";

/**
 * A DBML schema, drawn.
 *
 * Cards on a dotted ground, set in a monospace, each one a header band over a stack of rows, each
 * row a column name with its type in a pill and whatever badges it earns — PK, FK, unique — lined
 * up in the gutter.
 *
 * **The chrome follows the app's accent; the badges do not.** Header bands, relationship lines, the
 * selection glow, the wash on a joined column and the cardinality markers all resolve to
 * `--cf-accent`, so a schema restyles itself when the accent changes and reads correctly in either
 * theme without a hard-coded background anywhere. The three badges are the exception, and the
 * reasoning is written out where they are declared, below.
 *
 * Three things make it a *document* canvas rather than a picture of a database, and they are the
 * whole of this component:
 *
 * **The boxes can be dragged, and the drag is part of the document.** `onMoveTable` writes the
 * position into the DBML's layout comment (see `lib/dbml/layout.ts`), so an arrangement survives a
 * reload, a duplicate and an export. Omitting the callback makes the canvas read-only, which is what
 * the editor's `.dbml` file preview passes.
 *
 * **Selecting a table lights up what it is joined to, and hovering a line lights up its two ends.**
 * Pressing a box pushes back everything that is not that table, its neighbours, or the lines
 * between them — and marks the actual *columns* the keys are made of on both sides. Putting the
 * pointer on a single line narrows that to just the pair it joins. Those are the two questions a
 * schema diagram exists to answer, and tracing a curve by eye across forty boxes answers neither.
 *
 * **Nothing is re-laid-out while you drag.** The layout engine runs in a `useMemo` over the schema
 * and the pinned positions; the pan and zoom are written straight to the group's `transform` and
 * only synced back to React when the gesture ends.
 */

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 2.5;

/** The id of the panned group, so `standaloneSvg` can put the export back to 1:1. */
export const DBML_CANVAS_ID = "cf-dbml-canvas";

/**
 * The badge legend: three fixed hues that are not the accent.
 *
 * Everything else on this canvas follows `--cf-accent` — headers, lines, glow, selection — and that
 * is the point. The badges cannot, and the reason is that they sit *next to each other on one row*,
 * so the property they have to have is being distinct from **each other**. Deriving one of them
 * from the accent broke that twice over: on the default indigo the FK badge and the unique badge
 * came out 75/765 apart, which is the same colour to any eye reading a row of them, and on the Amber
 * accent the FK badge and the PK badge were byte-identical. A legend has fixed colours.
 *
 * Each is a token with a light and a dark value (see `index.css`), so a hue that has to read as text
 * on a pale card is not the same hue that has to read as text on a dark one.
 */
const KEY_COLOUR = "var(--cf-warning)";
const LINK_COLOUR = "var(--cf-blue)";
const ENUM_COLOUR = "var(--cf-violet)";

/**
 * The face the cards are set in.
 *
 * Monospace, like the document they are drawn from: a column list is a list of identifiers, and the
 * thing that makes forty of them scannable is that `created_at` and `updated_at` are the same width.
 * Named here rather than inherited because the export detaches from the page's stylesheet, and a
 * schema measured in a monospace and re-drawn in a serif overruns every box it has.
 */
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
/** One character of `MONO`, per point of font size. Monospace advance is 0.6em almost everywhere. */
const MONO_ADVANCE = 0.6;

/** Row furniture, in the same units `DBML_METRICS` measured the boxes with. */
const PAD_X = 11;
const BADGE_H = 13;
const BADGE_GAP = 3;
const HEADER_H = 34;
const ROW_H = 22;

export interface DbmlCanvasHandle {
  /** Scales and centres the whole schema in the frame. */
  fit: () => void;
  zoomBy: (factor: number) => void;
  /** The live `<svg>`, for the export and the thumbnail. `null` before the first paint. */
  element: () => SVGSVGElement | null;
  /** The laid-out diagram, which the export needs for its viewBox. */
  layout: () => DbmlLayout;
}

export const DbmlCanvas = forwardRef<
  DbmlCanvasHandle,
  {
    schema: DbmlSchema;
    /** Boxes the user has dragged, by table id. */
    positions: Record<string, { x: number; y: number }>;
    /** Omit for a read-only canvas — the boxes then sit wherever the layout engine puts them. */
    onMoveTable?: (id: string, x: number, y: number) => void;
    /** The table whose neighbourhood is lit up, or `null`. Controlled: the inspector reads it too. */
    selected: string | null;
    onSelect: (id: string | null) => void;
    /** Double-click. Used to jump to the table's declaration in the editor. */
    onOpen?: (id: string) => void;
    /** The live zoom, for a toolbar that wants to print it. Fires on pan and zoom alike. */
    onZoom?: (scale: number) => void;
    mode: DiagramColumnMode;
    density: DiagramDensity;
    /** Dims everything that does not match. Empty means "no search". */
    query?: string;
    className?: string;
  }
>(function DbmlCanvas(
  {
    schema,
    positions,
    onMoveTable,
    selected,
    onSelect,
    onOpen,
    onZoom,
    mode,
    density,
    query = "",
    className,
  },
  ref,
) {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<SVGGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  const commitTimer = useRef<number | null>(null);
  const dragRef = useRef<
    | { kind: "canvas"; x: number; y: number; viewX: number; viewY: number }
    | { kind: "node"; id: string; x: number; y: number; nodeX: number; nodeY: number; moved: boolean }
    | null
  >(null);
  /** The table under the pointer, which previews the selection its click would make. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** The *line* under the pointer, by ref id. Its own state because it outranks both of the above. */
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);

  const layout = useMemo(
    () => layoutDbml(schema, { mode, density, pinned: positions }),
    [schema, mode, density, positions],
  );
  const nodeById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );

  // Held in a ref so the zoom readout is not a dependency of every callback that pans.
  const zoomSink = useRef(onZoom);
  zoomSink.current = onZoom;

  const applyView = useCallback((next: { x: number; y: number; k: number }) => {
    const changed = viewRef.current.k !== next.k;
    viewRef.current = next;
    canvasRef.current?.setAttribute("transform", `translate(${next.x} ${next.y}) scale(${next.k})`);
    if (changed) zoomSink.current?.(next.k);
  }, []);

  const commitView = useCallback(() => {
    if (commitTimer.current !== null) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    setView(viewRef.current);
  }, []);

  const scheduleCommit = useCallback(() => {
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(commitView, 160);
  }, [commitView]);

  useEffect(
    () => () => {
      if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    },
    [],
  );

  const fit = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || layout.width === 0) return;
    const scale = Math.max(
      ZOOM_MIN,
      Math.min((frame.clientWidth - 24) / layout.width, (frame.clientHeight - 24) / layout.height, 1),
    );
    applyView({
      k: scale,
      x: (frame.clientWidth - layout.width * scale) / 2,
      y: (frame.clientHeight - layout.height * scale) / 2,
    });
    commitView();
  }, [applyView, commitView, layout.width, layout.height]);

  const zoomBy = useCallback(
    (factor: number, origin?: { x: number; y: number }) => {
      const current = viewRef.current;
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current.k * factor));
      const frame = frameRef.current;
      const point = origin ?? { x: (frame?.clientWidth ?? 0) / 2, y: (frame?.clientHeight ?? 0) / 2 };
      applyView({
        k,
        x: point.x - ((point.x - current.x) / current.k) * k,
        y: point.y - ((point.y - current.y) / current.k) * k,
      });
      scheduleCommit();
    },
    [applyView, scheduleCommit],
  );

  useImperativeHandle(
    ref,
    () => ({ fit, zoomBy, element: () => svgRef.current, layout: () => layout }),
    [fit, zoomBy, layout],
  );

  /**
   * Fits once, when the canvas first has something to fit — and on a density change, because
   * packing the boxes closer is pointless if you then have to zoom out to notice.
   *
   * Deliberately **not** on every layout change: the schema is being typed, and re-fitting on each
   * keystroke would move the diagram under the reader's eyes once per character.
   */
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || layout.nodes.length === 0) return;
    fitted.current = true;
    fit();
  }, [fit, layout.nodes.length]);
  useLayoutEffect(() => {
    if (fitted.current) fit();
    // `fit` is deliberately absent: this is about density, not about the layout it also depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [density]);

  const onWheel = (event: React.WheelEvent) => {
    const frame = frameRef.current;
    if (!frame) return;
    if (event.ctrlKey || event.metaKey) {
      const box = frame.getBoundingClientRect();
      zoomBy(Math.pow(0.999, event.deltaY), {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
      return;
    }
    const current = viewRef.current;
    applyView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
    scheduleCommit();
  };

  const onPointerDown = (event: React.PointerEvent, node?: DiagramNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    // Stops the press from starting a native text selection over the labels. See the frame's style.
    event.preventDefault();
    frameRef.current?.setPointerCapture?.(event.pointerId);
    dragRef.current = node
      ? {
          kind: "node",
          id: node.id,
          x: event.clientX,
          y: event.clientY,
          nodeX: node.x,
          nodeY: node.y,
          moved: false,
        }
      : {
          kind: "canvas",
          x: event.clientX,
          y: event.clientY,
          viewX: viewRef.current.x,
          viewY: viewRef.current.y,
        };
    // The press selects, not the release: the highlight should be up before the drag starts, so
    // dragging a box also shows you what it is attached to while you place it.
    if (node) onSelect(node.id);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.kind === "canvas") {
      applyView({ ...viewRef.current, x: drag.viewX + dx, y: drag.viewY + dy });
      return;
    }
    if (!onMoveTable) return;
    // Divided by the zoom, or a box races the cursor at anything but 100%.
    drag.moved = true;
    onMoveTable(drag.id, Math.round(drag.nodeX + dx / viewRef.current.k), Math.round(drag.nodeY + dy / viewRef.current.k));
  };

  const endDrag = () => {
    if (dragRef.current?.kind === "canvas") commitView();
    dragRef.current = null;
  };

  /**
   * What is lit, and why.
   *
   * Three gestures can ask the question and they are ranked, most specific first:
   *
   * 1. **A line under the pointer** lights exactly the two tables it joins, itself, and the columns
   *    it is made of. It outranks a selected table deliberately: once a table is selected you are
   *    looking at five lines leaving it, and "which one is this" is a question only the line can
   *    answer. Nothing is dimmed permanently by it — let go and the selection comes back.
   * 2. **A selected table** lights its whole neighbourhood, and stays lit.
   * 3. **A hovered table** does the same but only while nothing is selected, so the neighbourhood
   *    can be previewed by moving the pointer — which is how you find the table you meant to click.
   */
  const focusKind = hoveredLink ? "ref" : "table";
  const focusId = hoveredLink ?? selected ?? hovered;
  const highlight = useMemo(
    () => highlightFor(schema, focusId ? { kind: focusKind, id: focusId } : null),
    [focusKind, focusId, schema],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    return new Set(
      layout.nodes
        .filter(
          (node) =>
            node.name.toLowerCase().includes(needle) ||
            node.columns.some((column) => column.name.toLowerCase().includes(needle)),
        )
        .map((node) => node.id),
    );
  }, [layout.nodes, query]);

  return (
    <div
      ref={frameRef}
      className={`relative min-h-0 select-none overflow-hidden bg-[var(--cf-bg)] ${className ?? ""}`}
      onWheel={onWheel}
      onPointerDown={(event) => {
        onPointerDown(event);
        setHoveredLink(null);
        // A press on the background clears the selection, which is the only way back to seeing the
        // whole schema at full contrast once a table has been clicked.
        onSelect(null);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // `select-none` on the class *and* the property here, and a `preventDefault` on the press
      // below. Any one of the three left out and dragging a box runs the browser's own text
      // selection across the SVG instead: every label in the schema comes back wearing the system
      // highlight, the whole canvas turns the selection colour, and it stays that way after the
      // drag ends because nothing ever clears it.
      style={{
        cursor: dragRef.current?.kind === "canvas" ? "grabbing" : "default",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      <svg ref={svgRef} className="h-full w-full" role="img">
        <defs>
          {/* The ground. Inside the panned group, so it moves and scales with the schema — a grid
              that stays still while the diagram slides over it reads as a texture on the glass. */}
          <pattern id="cf-dbml-dots" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="var(--cf-text-muted)" fillOpacity="0.16" />
          </pattern>
          {/* What "selected" looks like: the box lit from behind in the app's accent. A real blur
              rather than a stack of ever-larger rectangles, because the whole point is that it does
              not read as another border.

              The colour is set twice on purpose. As a `style` it is a CSS property, which is the
              form every engine resolves `var()` in; as an attribute it is the SVG 2 presentation
              attribute, which is what an engine that ignores the property falls back to. Either one
              alone leaves a browser somewhere drawing a black halo. */}
          <filter id="cf-dbml-glow" x="-45%" y="-45%" width="190%" height="190%">
            {/* The colour goes in `style` rather than in a `flood-color` attribute: as a CSS
                property it is a variable every engine resolves, and `standaloneSvg` resolves the
                `style` attribute on the way out like any other. */}
            <feDropShadow
              dx="0"
              dy="0"
              stdDeviation="8"
              floodColor="var(--cf-accent)"
              floodOpacity="0.42"
              style={{ floodColor: "var(--cf-accent)", floodOpacity: 0.42 }}
            />
          </filter>
          <filter id="cf-dbml-glow-soft" x="-45%" y="-45%" width="190%" height="190%">
            <feDropShadow
              dx="0"
              dy="0"
              stdDeviation="6"
              floodColor="var(--cf-accent)"
              floodOpacity="0.26"
              style={{ floodColor: "var(--cf-accent)", floodOpacity: 0.26 }}
            />
          </filter>
        </defs>
        <g
          ref={canvasRef}
          id={DBML_CANVAS_ID}
          transform={`translate(${view.x} ${view.y}) scale(${view.k})`}
        >
          <rect
            x={-2400}
            y={-2400}
            width={layout.width + 4800}
            height={layout.height + 4800}
            fill="url(#cf-dbml-dots)"
            pointerEvents="none"
          />

          {layout.links.map((link) => {
            const from = nodeById.get(link.from);
            const to = nodeById.get(link.to);
            if (!from || !to) return null;
            // `link.constraint` carries the ref's own id — see `toSchemaDiagram` — which is what
            // makes "is this line part of the selection" an exact question rather than a guess
            // from its endpoints.
            const lit = highlight ? highlight.refs.has(link.constraint) : false;
            const dim = highlight !== null && !lit;
            const ends = edgeEnds(from, to, link.fromColumn, link.toColumn);
            const opacity = dim ? 0.16 : lit ? 0.95 : 0.42;
            const d = edgePath(from, to, link.fromColumn, link.toColumn);
            return (
              <g key={link.id}>
                {/* The part you can actually hit. A 1.4px curve is not a pointer target at any
                    zoom, so the hover rides an invisible stroke ten times its width — drawn before
                    the nodes, which means a table always wins where the two overlap. */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  pointerEvents="stroke"
                  style={{ cursor: "pointer" }}
                  onPointerEnter={() => setHoveredLink(link.constraint)}
                  onPointerLeave={() =>
                    setHoveredLink((current) =>
                      current === link.constraint ? null : current,
                    )
                  }
                >
                  <title>{`${link.from}.${link.fromColumn} → ${link.to}.${link.toColumn}`}</title>
                </path>
                <g opacity={opacity} pointerEvents="none">
                  <path
                    d={d}
                    fill="none"
                    stroke="var(--cf-accent)"
                    strokeWidth={lit ? 2 : 1.4}
                    strokeLinecap="round"
                  />
                  {/* Dots rather than an arrowhead: the direction is already in the badges and the
                      cardinality, and a head large enough to see at 40% zoom is a blob at 200%. */}
                  <circle cx={ends.x1} cy={ends.y1} r={lit ? 3.4 : 2.6} fill="var(--cf-accent)" />
                  <circle cx={ends.x2} cy={ends.y2} r={lit ? 3.4 : 2.6} fill="var(--cf-accent)" />
                </g>
              </g>
            );
          })}

          {/* The cardinalities, drawn after the lines so they sit on top of them, and only for the
              lit ones: a `1` and an `N` at both ends of every line in a forty-table schema is
              noise, while on the three lines you just selected it is the answer. */}
          {highlight !== null &&
            layout.links.map((link) => {
              if (!highlight.refs.has(link.constraint)) return null;
              const from = nodeById.get(link.from);
              const to = nodeById.get(link.to);
              const ref = schema.refs.find((entry) => entry.id === link.constraint);
              if (!from || !to || !ref) return null;
              return (
                <g key={`card-${link.id}`} pointerEvents="none">
                  <Cardinality
                    node={from}
                    other={to}
                    column={link.fromColumn}
                    label={ref.from.relation === "*" ? "N" : "1"}
                  />
                  <Cardinality
                    node={to}
                    other={from}
                    column={link.toColumn}
                    label={ref.to.relation === "*" ? "N" : "1"}
                  />
                </g>
              );
            })}

          {layout.nodes.map((node) => (
            <SchemaBox
              key={node.id}
              node={node}
              isEnum={layout.enumIds.has(node.id)}
              selected={selected === node.id}
              related={highlight !== null && highlight.tables.has(node.id) && selected !== node.id}
              dimmed={
                (highlight !== null && !highlight.tables.has(node.id)) ||
                (matches !== null && !matches.has(node.id))
              }
              joinedColumns={highlight?.columns ?? null}
              draggable={onMoveTable !== undefined}
              onPointerDown={(event) => onPointerDown(event, node)}
              onPointerEnter={() => setHovered(node.id)}
              onPointerLeave={() => setHovered((current) => (current === node.id ? null : current))}
              onOpen={() => onOpen?.(node.id)}
            />
          ))}
        </g>
      </svg>
    </div>
  );
});

/**
 * The `1` or `N` at one end of a lit line, sat just off the box it belongs to.
 *
 * Placed on the side the line actually leaves from, decided by the same comparison `edgePath` uses
 * — box centres — because reading it off the wrong edge puts the marker on the far side of the
 * table from its own line, which is worse than not drawing it.
 */
function Cardinality({
  node,
  other,
  column,
  label,
}: {
  node: DiagramNode;
  other: DiagramNode;
  column: string;
  label: string;
}) {
  const y = node.y + (node.rowY[column] ?? node.height / 2);
  const leavesRight = node.x + node.width / 2 <= other.x + other.width / 2;
  const x = leavesRight ? node.x + node.width + 17 : node.x - 17;
  return (
    <>
      <rect
        x={x - 8}
        y={y - 7}
        width={16}
        height={14}
        rx={4}
        fill="var(--cf-surface)"
        stroke="var(--cf-accent)"
        strokeOpacity={0.6}
        strokeWidth={1.1}
      />
      <text
        x={x}
        y={y + 3.4}
        fontSize={9}
        fontWeight={700}
        textAnchor="middle"
        fill="var(--cf-accent)"
      >
        {label}
      </text>
    </>
  );
}

/**
 * One table or enum: a header band over a stack of rows.
 *
 * Memoised on its own props: a pan re-renders the parent every frame it commits, and a schema of
 * two hundred boxes cannot afford to re-render all of them for a transform that did not touch any.
 */
const SchemaBox = memo(function SchemaBox({
  node,
  isEnum,
  selected,
  related,
  dimmed,
  joinedColumns,
  draggable,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onOpen,
}: {
  node: DiagramNode;
  isEnum: boolean;
  selected: boolean;
  related: boolean;
  dimmed: boolean;
  joinedColumns: Set<string> | null;
  draggable: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onOpen: () => void;
}) {
  const accent = isEnum ? ENUM_COLOUR : "var(--cf-accent)";
  const lit = selected || related;
  // The band brightens with the selection, so a lit table is legible as lit from its header alone —
  // which is the part still visible when the boxes are packed tight enough to overlap their glows.
  const bandOpacity = selected ? 0.2 : related ? 0.15 : 0.09;

  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      // Receding, not vanishing. The selection is *marked* — an accent border, a halo, lit lines,
      // the joined columns washed — and the dim is only there to push the rest behind that. Taken
      // further it stops reading as focus and starts reading as a diagram that failed to load.
      opacity={dimmed ? 0.45 : 1}
      filter={selected ? "url(#cf-dbml-glow)" : related ? "url(#cf-dbml-glow-soft)" : undefined}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onOpen}
      style={{ cursor: draggable ? "move" : "pointer" }}
    >
      <rect
        width={node.width}
        height={node.height}
        rx={12}
        fill="var(--cf-surface)"
        stroke={lit ? accent : "var(--cf-border)"}
        strokeWidth={selected ? 1.8 : related ? 1.4 : 1}
      />

      {/* The header band. Two rectangles because SVG has no per-corner radius: the rounded one
          gives the top two corners, the square one fills the join to the first row. */}
      <rect
        width={node.width}
        height={HEADER_H}
        rx={12}
        fill={accent}
        fillOpacity={bandOpacity}
      />
      <rect
        y={HEADER_H - 12}
        width={node.width}
        height={12}
        fill={accent}
        fillOpacity={bandOpacity}
      />
      <line
        y1={HEADER_H}
        x2={node.width}
        y2={HEADER_H}
        stroke={accent}
        strokeOpacity={0.22}
        strokeWidth={1}
      />

      {/* The glyph: a table for a table, three stacked bars for an enum. Small enough to read as
          punctuation on the name rather than as an icon competing with it. */}
      {isEnum ? (
        <g stroke={accent} strokeWidth={1.1} strokeLinecap="round" opacity={0.75}>
          <path d={`M${PAD_X} 13 H${PAD_X + 9} M${PAD_X} 17 H${PAD_X + 9} M${PAD_X} 21 H${PAD_X + 6}`} />
        </g>
      ) : (
        <g stroke={accent} strokeWidth={1.1} fill="none" opacity={0.75}>
          <rect x={PAD_X} y={12.5} width={9} height={9} rx={1.8} />
          <path d={`M${PAD_X} 15.7 H${PAD_X + 9} M${PAD_X + 4.5} 15.7 V${21.5}`} />
        </g>
      )}

      <text
        x={PAD_X + 14}
        y={21.5}
        fontSize={12}
        fontFamily={MONO}
        fontWeight={600}
        fill={accent}
      >
        {clip(
          node.schema ? `${node.schema}.${node.name}` : node.name,
          node.width - 56,
          12 * MONO_ADVANCE,
        )}
      </text>
      <text
        x={node.width - PAD_X}
        y={21.5}
        fontSize={9.5}
        fontWeight={600}
        textAnchor="end"
        fill="var(--cf-text-muted)"
      >
        {node.visible.length + node.hidden}
      </text>

      {node.visible.map((column, index) => (
        <Row
          key={column.name}
          column={column}
          y={HEADER_H + index * ROW_H}
          width={node.width}
          first={index === 0}
          isEnum={isEnum}
          // The column the selected relationship is actually made of, on both sides of it. Without
          // this a highlighted pair of tables still leaves you counting rows to find the join.
          joined={joinedColumns?.has(`${node.id}|${column.name}`) ?? false}
        />
      ))}

      {node.hidden > 0 && (
        <text
          x={PAD_X}
          y={node.height - 6}
          fontSize={9.5}
          fill="var(--cf-text-muted)"
          fontStyle="italic"
        >
          {`+${node.hidden}`}
        </text>
      )}
    </g>
  );
});

/**
 * One column: its name, its type in a pill, and the badges it earned.
 *
 * The badges are laid out from the right edge inwards, because that is the only edge every row
 * shares — packing them from the left would make a table's gutter ragged, which is exactly the
 * thing that stops a column of types being scannable.
 */
function Row({
  column,
  y,
  width,
  first,
  isEnum,
  joined,
}: {
  column: DbDiagramColumn;
  y: number;
  width: number;
  first: boolean;
  isEnum: boolean;
  joined: boolean;
}) {
  const badgeY = y + (ROW_H - BADGE_H) / 2;
  const marks: { label: string; colour: string; width: number }[] = [];
  if (column.primary_key) marks.push({ label: "PK", colour: KEY_COLOUR, width: 20 });
  if (column.foreign_key) marks.push({ label: "FK", colour: LINK_COLOUR, width: 20 });
  if (column.unique) marks.push({ label: "U", colour: ENUM_COLOUR, width: 14 });

  // Right to left: the badges first, then whatever is left over is the type pill's.
  let right = width - PAD_X;
  const placed = marks
    .slice()
    .reverse()
    .map((mark) => {
      right -= mark.width;
      const x = right;
      right -= BADGE_GAP;
      return { ...mark, x };
    });

  const typeText = column.data_type ? clip(column.data_type, 108, 9 * MONO_ADVANCE) : "";
  const typeWidth = typeText ? typeText.length * 9 * MONO_ADVANCE + 11 : 0;
  const typeX = right - typeWidth;
  const nameX = PAD_X + (column.primary_key ? 13 : 0);

  return (
    <g>
      {joined && (
        <rect y={y} width={width} height={ROW_H} fill="var(--cf-accent)" fillOpacity={0.1} />
      )}
      {!first && (
        <line y1={y} x2={width} y2={y} stroke="var(--cf-border)" strokeOpacity={0.9} />
      )}

      {column.primary_key && (
        <g
          transform={`translate(${PAD_X} ${y + ROW_H / 2 - 4})`}
          fill="none"
          stroke={KEY_COLOUR}
          strokeOpacity={0.85}
          strokeWidth={1.15}
          strokeLinecap="round"
        >
          <circle cx={2.6} cy={3} r={2.2} />
          <path d="M4.7 3.6 L9.2 3.6 M7.4 3.6 L7.4 5.6 M9 3.6 L9 5.2" />
        </g>
      )}

      <text
        x={nameX}
        y={y + ROW_H / 2 + 3.6}
        fontSize={11}
        fontFamily={MONO}
        fill="var(--cf-text)"
        fontWeight={joined ? 600 : 400}
        fontStyle={!isEnum && column.nullable ? "italic" : undefined}
      >
        {clip(column.name, Math.max(24, typeX - nameX - 8), 11 * MONO_ADVANCE)}
      </text>

      {typeText && (
        <>
          <rect
            x={typeX}
            y={badgeY}
            width={typeWidth}
            height={BADGE_H}
            rx={3.5}
            fill="var(--cf-text-muted)"
            fillOpacity={0.13}
          />
          <text
            x={typeX + typeWidth / 2}
            y={badgeY + 9.4}
            fontSize={9}
            fontFamily={MONO}
            textAnchor="middle"
            fill="var(--cf-text-muted)"
          >
            {typeText}
          </text>
        </>
      )}

      {placed.map((mark) => (
        <g key={mark.label}>
          {/* Tinted with a hairline of its own hue rather than flooded with it. Three saturated
              chips per row, times every row, times every table, was more colour than the schema
              underneath could carry — the badges ended up shouting over the thing they annotate.
              The hue is unchanged and so is what it means; only the amount of it is. This is also
              the same chip the type pill next door already was, which is why a row now reads as one
              run of chips instead of one grey one and three loud ones. */}
          <rect
            x={mark.x}
            y={badgeY}
            width={mark.width}
            height={BADGE_H}
            rx={3.5}
            fill={mark.colour}
            fillOpacity={0.18}
            stroke={mark.colour}
            strokeOpacity={0.4}
            strokeWidth={0.75}
          />
          <text
            x={mark.x + mark.width / 2}
            y={badgeY + 9.4}
            fontSize={8}
            fontWeight={700}
            textAnchor="middle"
            fill={mark.colour}
          >
            {mark.label}
          </text>
        </g>
      ))}
    </g>
  );
}
