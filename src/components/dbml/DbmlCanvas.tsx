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
import { layoutDbml, type DbmlLayout, type DbmlMarkKind, type DbmlMarks } from "../../lib/dbml/layout";
import { highlightFor, type DbmlSchema } from "../../lib/dbml/types";
import { ArrowLeftRight, Eraser, ListOrdered, Pencil, Plus, Table2, Trash2 } from "lucide-react";
import type { RefEnd } from "../../lib/dbml/edit";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { useT } from "../../state/languageStore";
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
/** The scale a table found by searching is at least brought to. */
const READABLE_ZOOM = 0.85;

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
 * The review marks: a fourth colour family, and the only one that means a *decision* rather than a
 * property of the schema.
 *
 * It reuses `--cf-warning`, which is also the PK badge's. That is allowed here and is not a repeat
 * of the mistake the legend note above describes: the rule there is that the badges must be
 * distinct **from each other**, because they sit side by side on one row. A mark never appears on a
 * column row — it is a spine down the box's left edge and a dot in its header — so it is never read
 * against a PK badge, and the three semantic colours are the ones a reader already knows.
 */
const MARK_COLOUR: Record<DbmlMarkKind, string> = {
  remove: "var(--cf-danger)",
  review: "var(--cf-warning)",
  keep: "var(--cf-success)",
};

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
  /** Puts one table in the middle of the frame, zooming in far enough to read it. */
  focusTable: (id: string) => void;
  /** Centres the next table matching the search, wrapping at the end. */
  nextMatch: () => void;
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
    /** Dims everything that does not match, and centres on the first hit. Empty means "no search". */
    query?: string;
    /** How many tables the query matched, for a toolbar that wants to say so. */
    onMatchCount?: (count: number) => void;
    /** Review marks, by table id and by ref id. Drawn whether or not the canvas is editable. */
    marks?: DbmlMarks;
    /**
     * Turns the canvas into something you can build a schema on. Omitted by the read-only callers
     * (`DiagramAiPanel`, `editor/DbmlDiagram`), which then get exactly the canvas they had.
     *
     * Optional as a whole rather than a flag plus a pile of handlers, for the same reason
     * `onMoveTable` is: the canvas asks "may I", the answer is the presence of the callback, and a
     * caller that has nothing to write to cannot accidentally be asked to.
     */
    editing?: {
      blocked: boolean;
      /**
       * Sets or clears a review mark. `null` clears.
       *
       * Deliberately *not* gated on `blocked`: every other operation here rewrites DBML and so
       * cannot run against a schema that no longer describes the text, but a mark is written to the
       * sidecar comment and touches no DBML at all. Reviewing a model is exactly the activity you
       * are doing when the document is half-typed, so this is the one control that stays live.
       */
      setMark: (id: string, mark: DbmlMarkKind | null) => void;
      connect: (from: RefEnd, to: RefEnd) => void;
      rename: (from: string, to: string) => void;
      addField: (table: string) => void;
      dropTable: (name: string) => void;
      addTable: () => void;
      addEnum: () => void;
      dropRef: (from: RefEnd, to: RefEnd) => void;
      flipRef: (from: RefEnd, to: RefEnd) => void;
    };
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
    onMatchCount,
    marks = {},
    editing,
    className,
  },
  ref,
) {
  const t = useT();
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<SVGGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  const commitTimer = useRef<number | null>(null);
  const dragRef = useRef<
    | { kind: "canvas"; x: number; y: number; viewX: number; viewY: number; moved: boolean }
    | { kind: "node"; id: string; x: number; y: number; nodeX: number; nodeY: number; moved: boolean }
    // Dragging a relationship out of a column. Carries the diagram-space point it started from so
    // the provisional line has an anchor that survives a pan mid-gesture.
    | { kind: "port"; from: RefEnd; fromId: string; ox: number; oy: number; moved: boolean }
    | null
  >(null);
  /** The table under the pointer, which previews the selection its click would make. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** The *line* under the pointer, by ref id. Its own state because it feeds a different question. */
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);
  /** The row under the pointer, `"<tableId>|<column>"`, so its connect handle can appear. */
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  /** The live end of a relationship being dragged out, in diagram space. */
  const [wire, setWire] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  /** Where a right-click landed and what it landed on. */
  const [menu, setMenu] = useState<
    | { x: number; y: number; on: { kind: "table"; id: string; name: string; mark?: DbmlMarkKind } }
    | {
        x: number;
        y: number;
        on: { kind: "ref"; id: string; from: RefEnd; to: RefEnd; mark?: DbmlMarkKind };
      }
    | { x: number; y: number; on: { kind: "canvas" } }
    | null
  >(null);
  /** The table whose name is being typed over, and the box it sits in. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** The current search hits and which one Enter last landed on. Refs, not state: they drive an
   *  imperative move and nothing on screen reads them. */
  const matchRef = useRef<string[]>([]);
  const matchAt = useRef(0);

  const layout = useMemo(
    () => layoutDbml(schema, { mode, density, pinned: positions }),
    [schema, mode, density, positions],
  );
  const nodeById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );

  /** A client point in the diagram's own coordinates — the inverse of the group's transform. */
  const toDiagram = useCallback((clientX: number, clientY: number) => {
    const box = frameRef.current?.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (clientX - (box?.left ?? 0) - view.x) / view.k,
      y: (clientY - (box?.top ?? 0) - view.y) / view.k,
    };
  }, []);

  /**
   * The column row at a diagram point, or `null`.
   *
   * Arithmetic rather than `elementFromPoint`, because the whole gesture happens under a pointer
   * capture: from the moment the drag starts the browser sends every event to the frame and stops
   * hit-testing the rows underneath, so asking the DOM what is beneath the cursor answers "the
   * frame" for the entire drag. The rows are on a grid this component defines, so the grid is what
   * it reads.
   */
  const rowAt = useCallback(
    (point: { x: number; y: number }): { node: DiagramNode; column: string } | null => {
      for (const node of layout.nodes) {
        if (point.x < node.x || point.x > node.x + node.width) continue;
        if (point.y < node.y + HEADER_H || point.y > node.y + node.height) continue;
        const index = Math.floor((point.y - node.y - HEADER_H) / ROW_H);
        const column = node.visible[index];
        if (column) return { node, column: column.name };
      }
      return null;
    },
    [layout.nodes],
  );

  /** The two ends of a link, as the edit operations name them. */
  const endsOf = useCallback(
    (constraint: string): { from: RefEnd; to: RefEnd } | null => {
      const ref = schema.refs.find((entry) => entry.id === constraint);
      if (!ref) return null;
      const name = (id: string) => nodeById.get(id)?.name ?? id;
      return {
        from: { table: name(ref.from.table), column: ref.from.fields[0] },
        to: { table: name(ref.to.table), column: ref.to.fields[0] },
      };
    },
    [schema.refs, nodeById],
  );

  // Held in refs so the two readouts are not dependencies of every callback that pans or searches.
  const zoomSink = useRef(onZoom);
  zoomSink.current = onZoom;
  const matchSink = useRef(onMatchCount);
  matchSink.current = onMatchCount;

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
    // Offset by the content's own origin — see `DiagramLayout.minX`.
    applyView({
      k: scale,
      x: (frame.clientWidth - layout.width * scale) / 2 - layout.minX * scale,
      y: (frame.clientHeight - layout.height * scale) / 2 - layout.minY * scale,
    });
    commitView();
  }, [applyView, commitView, layout.width, layout.height, layout.minX, layout.minY]);

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

  /**
   * One table, centred.
   *
   * Zoomed to at least `READABLE_ZOOM` on the way, because centring a schema that is scaled to 20%
   * to fit two hundred tables puts the answer in the middle of the window at four pixels tall.
   * Never zooms *out*: if you are already in close, the search is a way of moving, not of leaving.
   */
  const focusTable = useCallback(
    (id: string) => {
      const frame = frameRef.current;
      const node = nodeById.get(id);
      if (!frame || !node) return;
      const k = Math.max(viewRef.current.k, READABLE_ZOOM);
      applyView({
        k,
        x: frame.clientWidth / 2 - (node.x + node.width / 2) * k,
        y: frame.clientHeight / 2 - (node.y + node.height / 2) * k,
      });
      commitView();
    },
    [applyView, commitView, nodeById],
  );

  const nextMatch = useCallback(() => {
    const ids = matchRef.current;
    if (ids.length === 0) return;
    matchAt.current = (matchAt.current + 1) % ids.length;
    focusTable(ids[matchAt.current]);
  }, [focusTable]);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      zoomBy,
      focusTable,
      nextMatch,
      element: () => svgRef.current,
      layout: () => layout,
    }),
    [fit, zoomBy, focusTable, nextMatch, layout],
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

  /**
   * The wheel zooms, on its own, anywhere inside this frame — and nowhere else.
   *
   * A **native** listener rather than React's `onWheel`, and that is the whole point of the effect:
   * React registers wheel handlers as passive, so `preventDefault` inside one is ignored and the
   * pane behind the canvas scrolls away underneath the pointer while the diagram zooms. Bound to
   * the frame element, so the rest of the workbench — the editor, the panels — keeps its ordinary
   * scrolling.
   *
   * Shift pans sideways instead, which is the one thing the wheel used to do that dragging does not
   * already do better.
   */
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.shiftKey) {
        const current = viewRef.current;
        applyView({ ...current, x: current.x - (event.deltaY || event.deltaX), y: current.y });
        scheduleCommit();
        return;
      }
      const box = frame.getBoundingClientRect();
      zoomBy(Math.pow(0.999, event.deltaY), {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [applyView, scheduleCommit, zoomBy]);

  const onPointerDown = (event: React.PointerEvent, node?: DiagramNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    // Stops the press from starting a native text selection over the labels. See the frame's style.
    event.preventDefault();
    // ...which also stops the browser moving focus for us, so it is moved here — for a press on a
    // box as much as on the background. Without it the caret stays in the search field for the rest
    // of the session and every keystroke aimed at the canvas lands in the query.
    frameRef.current?.focus({ preventScroll: true });
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
          moved: false,
        };
    // The press selects, not the release: the highlight should be up before the drag starts, so
    // dragging a box also shows you what it is attached to while you place it.
    if (node) onSelect(node.id);
  };

  /** Begins dragging a relationship out of one column. */
  const startWire = (event: React.PointerEvent, node: DiagramNode, column: string, cy: number) => {
    if (event.button !== 0 || !editing || editing.blocked) return;
    event.stopPropagation();
    event.preventDefault();
    frameRef.current?.setPointerCapture?.(event.pointerId);
    const ox = node.x + node.width;
    const oy = node.y + cy;
    dragRef.current = {
      kind: "port",
      from: { table: node.name, column },
      fromId: node.id,
      ox,
      oy,
      moved: false,
    };
    setWire({ x1: ox, y1: oy, x2: ox, y2: oy });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "port") {
      drag.moved = true;
      const point = toDiagram(event.clientX, event.clientY);
      setWire({ x1: drag.ox, y1: drag.oy, x2: point.x, y2: point.y });
      // The row it would land on lights up, so the drop target is visible before the release.
      const over = rowAt(point);
      setHoveredRow(over ? `${over.node.id}|${over.column}` : null);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.kind === "canvas") {
      if (dx !== 0 || dy !== 0) drag.moved = true;
      applyView({ ...viewRef.current, x: drag.viewX + dx, y: drag.viewY + dy });
      return;
    }
    if (!onMoveTable) return;
    // Divided by the zoom, or a box races the cursor at anything but 100%.
    drag.moved = true;
    onMoveTable(drag.id, Math.round(drag.nodeX + dx / viewRef.current.k), Math.round(drag.nodeY + dy / viewRef.current.k));
  };

  const endDrag = (event?: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag?.kind === "port") {
      dragRef.current = null;
      setWire(null);
      setHoveredRow(null);
      if (!event) return;
      const over = rowAt(toDiagram(event.clientX, event.clientY));
      // Dropping on the column it came from is how you abandon the gesture, so it is not an error.
      if (over && over.node.id !== drag.fromId) {
        editing?.connect(drag.from, { table: over.node.name, column: over.column });
      }
      return;
    }
    if (drag?.kind === "canvas") commitView();
    // A gesture that actually moved almost certainly left the line it started on — and it cannot
    // tell us so itself, because while the pointer is captured the browser stops delivering
    // enter/leave to the elements underneath. Without this the line stays lit for good. A press
    // that did *not* move is left alone: the pointer is still on the line, and clearing there would
    // put the highlight out and give it no way back, for the same reason.
    if (drag?.moved) setHoveredLink(null);
    dragRef.current = null;
  };

  /**
   * What is lit, and why.
   *
   * Three gestures can ask the question and they are ranked, most specific first:
   *
   * 1. **A selected table** wins outright, and stays lit until it is deselected. A selection is a
   *    committed state — the inspector is open on it — and hover is not allowed to fight it. It
   *    used to be the other way round, on the theory that a line is the more specific question; in
   *    use that just meant the picture you had asked for kept dissolving as the pointer crossed the
   *    lines leading to it.
   * 2. **A line under the pointer**, when nothing is selected: exactly the two tables it joins,
   *    itself, and the columns it is made of.
   * 3. **A hovered table**, when neither of the above applies, so the neighbourhood can be previewed
   *    by moving the pointer — which is how you find the table you meant to click.
   */
  const focusKind = !selected && hoveredLink ? "ref" : "table";
  const focusId = selected ?? hoveredLink ?? hovered;
  const highlight = useMemo(
    () => highlightFor(schema, focusId ? { kind: focusKind, id: focusId } : null),
    [focusKind, focusId, schema],
  );

  /** The tables the query hits, in the order they are laid out — which is the order `nextMatch`
   *  walks, so pressing Enter moves left to right rather than at random. */
  const matchIds = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    return layout.nodes
      .filter(
        (node) =>
          node.name.toLowerCase().includes(needle) ||
          node.columns.some((column) => column.name.toLowerCase().includes(needle)),
      )
      .map((node) => node.id);
  }, [layout.nodes, query]);
  const matches = useMemo(() => (matchIds ? new Set(matchIds) : null), [matchIds]);

  /**
   * The boxes in painting order: receded first, selected last.
   *
   * SVG has no `z-index` — document order is the only thing that decides what covers what — so a
   * canvas whose boxes may overlap has to sort them itself. Drawing them in layout order meant the
   * one on top was whichever the layout engine happened to emit last, so selecting a table could
   * leave it *behind* an unrelated one: the thing you had just asked to look at was the thing
   * partly hidden.
   *
   * Four ranks rather than two, because "in front" has more than one degree here: the selection
   * outranks its neighbourhood, the neighbourhood outranks tables that are merely present, and
   * anything receded goes to the back where it belongs. `sort` is stable, so tables of equal rank
   * keep the order the layout gave them and nothing shuffles as the pointer moves across the
   * canvas.
   */
  const painted = useMemo(() => {
    const rank = (id: string) => {
      if (selected === id) return 3;
      if (highlight?.tables.has(id)) return 2;
      const receded =
        (highlight !== null && !highlight.tables.has(id)) || (matches !== null && !matches.has(id));
      return receded ? 0 : 1;
    };
    return [...layout.nodes].sort((a, b) => rank(a.id) - rank(b.id));
  }, [layout.nodes, selected, highlight, matches]);

  /**
   * Centres on the first hit as the query changes — and only when the *set of hits* changes.
   *
   * Keyed on the ids rather than on the array, because the layout is rebuilt on every keystroke of
   * the document as well as of the query: reacting to the array's identity would re-centre the
   * canvas once per character typed in the editor, which is the diagram walking away under the
   * reader for no reason at all.
   */
  const matchKey = matchIds?.join("\u0000") ?? "";
  useEffect(() => {
    const ids = matchKey ? matchKey.split("\u0000") : [];
    matchRef.current = ids;
    matchAt.current = 0;
    matchSink.current?.(ids.length);
    if (ids.length > 0) focusTable(ids[0]);
    // `focusTable` is stable per layout; re-running on it alone would re-centre on every relayout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey]);

  return (
    <div
      ref={frameRef}
      className={`relative min-h-0 select-none overflow-hidden bg-[var(--cf-bg)] outline-none ${className ?? ""}`}
      // Focusable, but not in the tab order. A press moves focus here, which is the only way the
      // search box above ever gives it up: without this the caret stays in the field for the rest
      // of the session, and every keystroke meant for the canvas goes into the query.
      tabIndex={-1}
      onPointerDown={(event) => {
        onPointerDown(event);
        // A press on the background clears the selection, which is the only way back to seeing the
        // whole schema at full contrast once a table has been clicked.
        onSelect(null);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={() => endDrag()}
      onContextMenu={
        editing
          ? (event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, on: { kind: "canvas" } });
            }
          : undefined
      }
      onPointerLeave={() => {
        setHovered(null);
        setHoveredLink(null);
        setHoveredRow(null);
      }}
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
              stdDeviation="9"
              floodColor="var(--cf-accent)"
              floodOpacity="0.5"
              style={{ floodColor: "var(--cf-accent)", floodOpacity: 0.5 }}
            />
          </filter>
          {/* The neighbourhood's halo, and it is deliberately *far* below the one above rather than
              a step down from it.

              Both haloes are the same hue, so the only thing separating "the table I clicked" from
              "the five it joins" is how much light each throws. At a quarter of the selection's
              strength — instead of the two thirds this used to be — the neighbours still read as a
              lit set, but the eye lands on the selection first and without effort. The rest of what
              marks a neighbour is untouched: it keeps the accent border, the lit header band and
              the wash on its joined columns, which is what stops the smaller halo from reading as
              "not selected either". */}
          <filter id="cf-dbml-glow-soft" x="-45%" y="-45%" width="190%" height="190%">
            <feDropShadow
              dx="0"
              dy="0"
              stdDeviation="4"
              floodColor="var(--cf-accent)"
              floodOpacity="0.12"
              style={{ floodColor: "var(--cf-accent)", floodOpacity: 0.12 }}
            />
          </filter>
        </defs>
        <g
          ref={canvasRef}
          id={DBML_CANVAS_ID}
          transform={`translate(${view.x} ${view.y}) scale(${view.k})`}
        >
          <rect
            x={layout.minX - 2400}
            y={layout.minY - 2400}
            width={layout.width + 4800}
            height={layout.height + 4800}
            fill="url(#cf-dbml-dots)"
            pointerEvents="none"
          />

          {/* `TableGroup` boundaries, drawn first so every table and line sits on top of them.
              Deliberately *not* in the accent: a group is a note about the model rather than part of
              its structure, and the accent on this canvas means "relationship". */}
          {layout.groups.map((box) => (
            <g key={`group-${box.id}`} pointerEvents="none">
              {box.rects.map((rect, at) => (
                <rect
                  key={at}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  rx={14}
                  fill="var(--cf-text-muted)"
                  fillOpacity={0.05}
                  stroke="var(--cf-text-muted)"
                  strokeOpacity={0.3}
                  strokeWidth={1}
                  strokeDasharray="7 5"
                />
              ))}
              {box.labels.map((at, index) => (
                <text
                  key={index}
                  x={at.x}
                  y={at.y}
                  fontSize={10}
                  fontFamily={MONO}
                  fontWeight={600}
                  fill="var(--cf-text-muted)"
                >
                  {box.name}
                </text>
              ))}
            </g>
          ))}

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
            // A marked relationship is drawn in its mark's colour rather than the accent, and a
            // removal candidate is dashed as well — at the zoom where a whole model fits, colour
            // alone is a few pixels of hue on a hairline and the dash is what carries.
            const mark = marks[link.constraint];
            const stroke = mark ? MARK_COLOUR[mark] : "var(--cf-accent)";
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
                  onContextMenu={
                    editing
                      ? (event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const ends = endsOf(link.constraint);
                          if (ends) {
                            setMenu({
                              x: event.clientX,
                              y: event.clientY,
                              on: {
                                kind: "ref",
                                id: link.constraint,
                                mark: marks[link.constraint],
                                ...ends,
                              },
                            });
                          }
                        }
                      : undefined
                  }
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
                    stroke={stroke}
                    strokeWidth={lit ? 2 : 1.4}
                    strokeLinecap="round"
                    strokeDasharray={mark === "remove" ? "5 4" : undefined}
                  />
                  {/* Dots rather than an arrowhead: the direction is already in the badges and the
                      cardinality, and a head large enough to see at 40% zoom is a blob at 200%. */}
                  <circle cx={ends.x1} cy={ends.y1} r={lit ? 3.4 : 2.6} fill={stroke} />
                  <circle cx={ends.x2} cy={ends.y2} r={lit ? 3.4 : 2.6} fill={stroke} />
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

          {painted.map((node) => (
            <SchemaBox
              key={node.id}
              node={node}
              isEnum={layout.enumIds.has(node.id)}
              mark={marks[node.id]}
              selected={selected === node.id}
              connect={
                editing && !editing.blocked
                  ? {
                      hoveredRow,
                      hint: t("dbml.connectHint"),
                      onHoverRow: setHoveredRow,
                      onStart: (column, cy, event) => startWire(event, node, column, cy),
                    }
                  : undefined
              }
              onContextMenu={
                editing
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelect(node.id);
                      setMenu({
                        x: event.clientX,
                        y: event.clientY,
                        on: { kind: "table", id: node.id, name: node.name, mark: marks[node.id] },
                      });
                    }
                  : undefined
              }
              onRename={
                editing && !editing.blocked
                  ? () => setRenaming({ id: node.id, name: node.name })
                  : undefined
              }
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

          {/* The relationship being dragged out, drawn last so it is over every box it crosses.
              A straight line rather than the curve the settled ones get: this one is following a
              cursor, and a spline whose control points chase the pointer reads as lag. */}
          {wire && (
            <g pointerEvents="none">
              <line
                x1={wire.x1}
                y1={wire.y1}
                x2={wire.x2}
                y2={wire.y2}
                stroke="var(--cf-accent)"
                strokeWidth={1.8}
                strokeDasharray="4 3"
                strokeLinecap="round"
              />
              <circle cx={wire.x1} cy={wire.y1} r={3.4} fill="var(--cf-accent)" />
              <circle cx={wire.x2} cy={wire.y2} r={3.4} fill="var(--cf-accent)" />
            </g>
          )}
        </g>
      </svg>

      {/* Renaming happens in an HTML input over the box rather than in the SVG. `foreignObject` is
          the SVG-native answer and it is the wrong one here: it inherits the panned group's
          transform, so the field would scale with the zoom and be four pixels tall at 15%. This is
          positioned *from* the transform instead, so it is always the size a text field should be. */}
      {renaming && nodeById.get(renaming.id) && (
        <input
          autoFocus
          defaultValue={renaming.name}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next && next !== renaming.name) editing?.rename(renaming.name, next);
            setRenaming(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setRenaming(null);
          }}
          style={{
            left: view.x + (nodeById.get(renaming.id)?.x ?? 0) * view.k,
            top: view.y + (nodeById.get(renaming.id)?.y ?? 0) * view.k,
            width: Math.max(120, (nodeById.get(renaming.id)?.width ?? 0) * view.k),
          }}
          className="absolute z-20 rounded-md border border-[var(--cf-accent)] bg-[var(--cf-surface-raised)] px-1.5 py-[3px] font-mono text-[12px] font-semibold text-[var(--cf-text)] shadow-[var(--cf-shadow)] outline-none"
        />
      )}

      {menu && editing && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={menuItems(menu.on, editing, t, setRenaming)}
        />
      )}
    </div>
  );
});

/**
 * What the right button offers, by what it landed on.
 *
 * Outside the component because it is a pure function of the three arguments, and because a menu
 * that is rebuilt on every pan frame is a menu that closes itself mid-gesture.
 *
 * Every entry is disabled rather than absent while the document does not parse — see the note on
 * `applyEdit` in the workbench for why editing stops there — so the menu is the same shape whether
 * or not the schema is currently valid.
 */
/**
 * The three marks plus a way out, as menu rows.
 *
 * First in the menu, above the edits, because on a model being reviewed this is the thing you press
 * thirty times and "delete this table" is the thing you press once at the end. The mark already on
 * the thing is offered as "clear" rather than repeated as a no-op row.
 */
function markItems(
  id: string,
  current: DbmlMarkKind | undefined,
  editing: NonNullable<React.ComponentProps<typeof DbmlCanvas>["editing"]>,
  t: (key: Parameters<ReturnType<typeof useT>>[0]) => string,
): MenuItem[] {
  const rows: MenuItem[] = (["remove", "review", "keep"] as const)
    .filter((kind) => kind !== current)
    .map((kind) => ({
      label: t(`dbml.mark.${kind}` as "dbml.mark.remove"),
      leading: (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: MARK_COLOUR[kind] }}
        />
      ),
      onClick: () => editing.setMark(id, kind),
    }));
  if (current) {
    rows.push({ label: t("dbml.mark.clear"), icon: Eraser, onClick: () => editing.setMark(id, null) });
  }
  return rows;
}

function menuItems(
  on:
    | { kind: "table"; id: string; name: string; mark?: DbmlMarkKind }
    | { kind: "ref"; id: string; from: RefEnd; to: RefEnd; mark?: DbmlMarkKind }
    | { kind: "canvas" },
  editing: NonNullable<React.ComponentProps<typeof DbmlCanvas>["editing"]>,
  t: (key: Parameters<ReturnType<typeof useT>>[0]) => string,
  setRenaming: (next: { id: string; name: string }) => void,
): MenuItem[] {
  const off = editing.blocked;
  if (on.kind === "table") {
    return [
      ...markItems(on.id, on.mark, editing, t),
      {
        label: t("dbml.inspector.addField"),
        icon: Plus,
        disabled: off,
        separated: true,
        onClick: () => editing.addField(on.name),
      },
      {
        label: t("dbml.inspector.rename"),
        icon: Pencil,
        disabled: off,
        onClick: () => setRenaming({ id: on.id, name: on.name }),
      },
      {
        label: t("dbml.dropTable"),
        icon: Trash2,
        danger: true,
        separated: true,
        disabled: off,
        onClick: () => editing.dropTable(on.name),
      },
    ];
  }
  if (on.kind === "ref") {
    return [
      ...markItems(on.id, on.mark, editing, t),
      {
        label: t("dbml.flipRelation"),
        icon: ArrowLeftRight,
        disabled: off,
        separated: true,
        onClick: () => editing.flipRef(on.from, on.to),
      },
      {
        label: t("dbml.inspector.dropRelation"),
        icon: Trash2,
        danger: true,
        separated: true,
        disabled: off,
        onClick: () => editing.dropRef(on.from, on.to),
      },
    ];
  }
  return [
    { label: t("dbml.addTable"), icon: Table2, disabled: off, onClick: editing.addTable },
    { label: t("dbml.addEnum"), icon: ListOrdered, disabled: off, onClick: editing.addEnum },
  ];
}

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
  mark,
  selected,
  related,
  dimmed,
  joinedColumns,
  draggable,
  connect,
  onContextMenu,
  onRename,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onOpen,
}: {
  node: DiagramNode;
  isEnum: boolean;
  /** The review mark on this table, if it has one. */
  mark?: DbmlMarkKind;
  selected: boolean;
  related: boolean;
  dimmed: boolean;
  joinedColumns: Set<string> | null;
  draggable: boolean;
  /** Present when relationships can be drawn out of this box's rows. */
  connect?: {
    hoveredRow: string | null;
    hint: string;
    onHoverRow: (key: string | null) => void;
    onStart: (column: string, cy: number, event: React.PointerEvent) => void;
  };
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Double-click on the header band. Distinct from `onOpen`, which is the body's. */
  onRename?: () => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onOpen: () => void;
}) {
  const accent = isEnum ? ENUM_COLOUR : "var(--cf-accent)";
  const lit = selected || related;
  /** Held rather than inlined: the strikethrough has to be exactly as wide as the drawn name. */
  const title = clip(
    node.schema ? `${node.schema}.${node.name}` : node.name,
    node.width - 56,
    12 * MONO_ADVANCE,
  );
  // The band brightens with the selection, so a lit table is legible as lit from its header alone —
  // which is the part still visible when the boxes are packed tight enough to overlap their glows.
  //
  // The three values are close together on purpose, and they are what carries the neighbourhood now
  // that its halo is a quarter of the selection's (see `cf-dbml-glow-soft`). A neighbour has to stay
  // legible as *lit* at a glance; what it must not do is compete for the first look. So the marks
  // that say "in the set" stay strong and the mark that says "look here" — the halo — is the one
  // that separates them.
  const bandOpacity = selected ? 0.22 : related ? 0.115 : 0.09;

  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      filter={selected ? "url(#cf-dbml-glow)" : related ? "url(#cf-dbml-glow-soft)" : undefined}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
      onDoubleClick={onOpen}
      style={{ cursor: draggable ? "move" : "pointer" }}
    >
      {/* The card itself: opaque, and *outside* the fade below.

          Boxes overlap — the layout allows it, and dragging one onto another is a thing people do —
          so a card has to hide what is under it. Fading the whole group, which is what this used to
          do, made every receded table translucent: two overlapping boxes showed both sets of column
          names through each other, and the result reads as a rendering fault rather than as focus.
          The backing stays at full alpha and only what is *printed on it* recedes. */}
      <rect width={node.width} height={node.height} rx={12} fill="var(--cf-surface)" />

      <g
        // Receding, not vanishing. The selection is *marked* — an accent border, a halo, lit lines,
        // the joined columns washed — and the dim is only there to push the rest behind that. Taken
        // further it stops reading as focus and starts reading as a diagram that failed to load.
        //
        // A removal candidate recedes a little even when nothing is selected: it is still part of
        // the model, and it is on its way out of it. Not as far as `dimmed`, which means "not what
        // you asked about" and has to stay distinguishable from "marked".
        opacity={dimmed ? 0.45 : mark === "remove" ? 0.82 : 1}
      >
      <rect
        width={node.width}
        height={node.height}
        rx={12}
        fill="none"
        stroke={lit ? accent : "var(--cf-border)"}
        strokeWidth={selected ? 1.8 : related ? 1.15 : 1}
      />

      {/* The header band. Two rectangles because SVG has no per-corner radius: the rounded one
          gives the top two corners, the square one fills the join to the first row.

          Double-clicking it renames the table, while double-clicking the body still jumps to the
          declaration. Splitting the gesture by *where* rather than giving rename its own button is
          what keeps the box a box: the name is the thing on the header, so the header is where you
          go to change it — the same reasoning as the inspector's title. */}
      <rect
        width={node.width}
        height={HEADER_H}
        rx={12}
        fill={accent}
        fillOpacity={bandOpacity}
        onDoubleClick={
          onRename
            ? (event) => {
                event.stopPropagation();
                onRename();
              }
            : undefined
        }
        style={onRename ? { cursor: "text" } : undefined}
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

      {/* The mark, as a spine down the left edge.
          Inset from the corners rather than drawn as a full-height bar, because the box is rounded
          and a bar at x=0 pokes out of the radius at both ends. A spine is the one mark that stays
          legible at the zoom where thirty tables fit on screen — at that size a header dot is two
          pixels and the strikethrough is gone, but a coloured edge still reads as a column of
          decisions down the diagram. */}
      {mark && (
        <rect
          x={1.5}
          y={10}
          width={3.5}
          height={Math.max(0, node.height - 20)}
          rx={1.75}
          fill={MARK_COLOUR[mark]}
        />
      )}

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

      {/* The name, in the text colour rather than in the accent.
          The accent is chrome — the band, the border, the lines, the glyph — and the name is
          content. Setting it in the accent made the title's legibility a function of which accent
          was picked: a bright one over its own 20%-opacity band is a pale word on a pale strip, and
          on Amber it glowed rather than read. `--cf-text` is contrast-checked against the surface
          in both themes by definition, so the title is readable whatever the accent is, and the box
          still reads as themed from everything around the word.

          Not `color-mix` toward the accent, which would keep a trace of the hue: the export
          resolver in `diagramSvg` substitutes `var(--…)` and nothing else, so a mixed colour would
          survive on screen and reach the PNG as a function the `<img>` renderer cannot evaluate. */}
      <text
        x={PAD_X + 14}
        y={21.5}
        fontSize={12}
        fontFamily={MONO}
        fontWeight={600}
        fill="var(--cf-text)"
      >
        {title}
      </text>

      {/* Struck through when it is going. The one mark that needs no legend: everybody already
          knows what a line through a name means, and it survives being read in a screenshot by
          somebody who has never opened this app. */}
      {mark === "remove" && (
        <line
          x1={PAD_X + 13}
          y1={17.5}
          x2={PAD_X + 15 + title.length * 12 * MONO_ADVANCE}
          y2={17.5}
          stroke={MARK_COLOUR.remove}
          strokeWidth={1.4}
          strokeLinecap="round"
        />
      )}
      {/* The same mark again, as a dot beside the column count. The spine says *that* the table is
          marked from across the diagram; this says *which* mark at the zoom where you are reading
          the columns, without spending a word on it. */}
      {mark && (
        <circle cx={node.width - PAD_X - 17} cy={17} r={3.5} fill={MARK_COLOUR[mark]}>
          <title>{mark}</title>
        </circle>
      )}

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
          connect={
            connect && !isEnum
              ? {
                  lit: connect.hoveredRow === `${node.id}|${column.name}`,
                  hint: connect.hint,
                  onEnter: () => connect.onHoverRow(`${node.id}|${column.name}`),
                  onLeave: () => connect.onHoverRow(null),
                  onStart: (event) =>
                    connect.onStart(column.name, HEADER_H + index * ROW_H + ROW_H / 2, event),
                }
              : undefined
          }
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
  connect,
}: {
  column: DbDiagramColumn;
  y: number;
  width: number;
  first: boolean;
  isEnum: boolean;
  joined: boolean;
  /** Present when a relationship can be dragged out of this row. */
  connect?: {
    lit: boolean;
    hint: string;
    onEnter: () => void;
    onLeave: () => void;
    onStart: (event: React.PointerEvent) => void;
  };
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
    <g
      onPointerEnter={connect?.onEnter}
      onPointerLeave={connect?.onLeave}
    >
      {joined && (
        <rect y={y} width={width} height={ROW_H} fill="var(--cf-accent)" fillOpacity={0.1} />
      )}
      {/* The row lit as a drop target while a relationship is being dragged over it. Same wash as
          a joined column, because it is about to become one. */}
      {connect?.lit && (
        <rect y={y} width={width} height={ROW_H} fill="var(--cf-accent)" fillOpacity={0.16} />
      )}
      {!first && (
        <line y1={y} x2={width} y2={y} stroke="var(--cf-border)" strokeOpacity={0.9} />
      )}

      {/* The grab handle for a new relationship, on the right edge where the lines already leave.
          Only under the pointer: a dot on every row of every table is forty dots of furniture on a
          diagram whose whole problem is that it is busy. The invisible disc around it is the actual
          target — 4.5px is not something anybody hits at 60% zoom. */}
      {connect && (
        <g
          onPointerDown={connect.onStart}
          style={{ cursor: "crosshair" }}
        >
          <circle
            cx={width}
            cy={y + ROW_H / 2}
            r={9}
            fill="transparent"
            pointerEvents="all"
          >
            <title>{connect.hint}</title>
          </circle>
          <circle
            cx={width}
            cy={y + ROW_H / 2}
            r={4.5}
            fill="var(--cf-surface)"
            stroke="var(--cf-accent)"
            strokeWidth={1.6}
            opacity={connect.lit ? 1 : 0}
            pointerEvents="none"
          />
        </g>
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
