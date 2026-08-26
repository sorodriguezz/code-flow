import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Download,
  FileCode2,
  // Aliased: the raster export needs the DOM's own `Image`, and an unaliased icon of that name
  // would shadow it in this module.
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Maximize2,
  Network,
  RefreshCw,
  Search,
  Shrink,
  Table2,
  Unlink,
  View,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ToolbarButton, formatCount } from "./dbChrome";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { apiSaveBinaryFile, apiSaveFile } from "../../lib/tauri/apiCommands";
import {
  diagramStats,
  layoutDiagram,
  toMermaid,
  type DiagramLayout,
  type DiagramNode,
} from "../../lib/db/erLayout";
import { clip, edgePath, rasterize, standaloneSvg } from "../../lib/diagramSvg";
import { schemaToDbml } from "../../lib/dbml/fromSchema";
import { FORMAT_DBML } from "../../lib/diagrams/doc";
import { useDbStore, type DbDiagramTab } from "../../state/dbStore";
import { ensureDiagramsStoreLoaded, useDiagramsStore } from "../../state/diagramsStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/**
 * A schema, drawn.
 *
 * The question this answers is the one no tree can: *how does this fit together*. A schema explorer
 * tells you a table exists and what its columns are; it cannot tell you that four tables all hang
 * off `customer`, that two of them have no primary key, or that one is connected to nothing at all.
 * Those are the facts you want before writing a join, and they are all shape.
 *
 * Rendered as **one SVG**, not as positioned HTML boxes. Three things follow from that and none of
 * them are cosmetic: pan and zoom are a single `transform` rather than a scroll container fighting
 * a coordinate system; the export is the same tree the screen shows, so what is saved is what was
 * seen; and a schema of two hundred tables stays one paint instead of two hundred layout passes.
 *
 * Nothing here writes. It is the one panel in the workspace that cannot change the database, which
 * is why it can be opened on production without a second thought.
 */

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 2.5;

/** The id of the panned/zoomed group, so the export can put it back to 1:1. See `standaloneSvg`. */
const CANVAS_ID = "cf-er-canvas";

/** Which set of tables the panel is lighting up, when a stat chip has been clicked. */
type Highlight = "none" | "noPrimaryKey" | "isolated";

export function DiagramPanel({ tab }: { tab: DbDiagramTab }) {
  const t = useT();
  const store = useDbStore.getState();
  /**
   * Everything about how this canvas is being *read* — the column mode, the density, the boxes
   * dragged by hand, the selection, the search and the highlight — on the tab record.
   *
   * `DatabaseView` renders one `DiagramPanel` for every diagram tab, so held locally these were one
   * set of controls shared by all of them. The worst of it was `pinned`: tables dragged into place
   * on one schema were applied by id to whatever schema was opened next, and reading a second
   * diagram silently rearranged the first one's layout.
   *
   * The pan/zoom below deliberately stays local — it is re-fitted on every relayout and is driven
   * imperatively through `viewRef`, not by React state.
   */
  const { mode, density, pinned, selected, query, highlight } = tab.ui;
  const setUi = useDbStore((s) => s.setDiagramUi);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  /** Where the export menu was opened from, or `null` when it is closed. */
  const [exportAt, setExportAt] = useState<{ x: number; y: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  /**
   * The pan/zoom, again, as a ref — and the group it is written to.
   *
   * `view` state is only ever read to *render* the transform. Everything that moves the canvas reads
   * and writes `viewRef` and pushes the result straight onto the `<g>` with `setAttribute`, then
   * commits the ref into state once the gesture stops. A wheel or a drag therefore costs one
   * attribute write per event instead of a React render that reconciles every path and every table
   * box on the canvas — ~10,000 SVG elements on a large schema, at trackpad event rates.
   *
   * This is safe because React only touches a DOM attribute when the *prop* changed since the last
   * render: a re-render that happens mid-gesture for some other reason (a selection, a search) sees
   * the same stale transform string it rendered last time and leaves the attribute — and therefore
   * our imperative value — alone. The commit at the end of the gesture is what puts the two back in
   * agreement. Nothing else reads `view`: the export deliberately resets the transform.
   */
  const viewRef = useRef(view);
  const canvasRef = useRef<SVGGElement>(null);
  /** The pending "gesture is over, sync React" timer — wheel has no pointerup to hang it on. */
  const commitTimer = useRef<number | null>(null);
  /** What a drag is currently moving: the canvas, or one table. */
  const dragRef = useRef<
    | { kind: "canvas"; x: number; y: number; viewX: number; viewY: number }
    | { kind: "node"; id: string; x: number; y: number; nodeX: number; nodeY: number }
    | null
  >(null);

  // A tab restored from the last session arrives empty on purpose — see `rehydrateTab`. This is the
  // "looked at" that fills it in.
  useEffect(() => {
    if (!tab.diagram && !tab.loading && !tab.error) void store.loadDiagram(tab.id);
  }, [tab.id, tab.diagram, tab.loading, tab.error]);

  const layout = useMemo<DiagramLayout>(
    () =>
      tab.diagram
        ? layoutDiagram(tab.diagram, mode, pinned, density)
        : { nodes: [], links: [], minX: 0, minY: 0, width: 0, height: 0 },
    [tab.diagram, mode, pinned, density],
  );
  const stats = useMemo(() => (tab.diagram ? diagramStats(tab.diagram) : null), [tab.diagram]);
  /** The nodes by id, because every link has to find both of its ends. Two `.find()` scans per link
   * is 900 × 300 × 2 array walks on a large schema — a quarter of a million comparisons — and they
   * used to be redone on every render, which during a pan meant every frame. */
  const nodeById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );

  /** Writes the transform to the canvas group without going through React. */
  const applyView = (next: { x: number; y: number; k: number }) => {
    viewRef.current = next;
    canvasRef.current?.setAttribute(
      "transform",
      `translate(${next.x} ${next.y}) scale(${next.k})`,
    );
  };

  /** The gesture has settled: let React's idea of the transform catch up with the DOM's. */
  const commitView = () => {
    if (commitTimer.current !== null) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    setView(viewRef.current);
  };

  /** For gestures with no end event — the wheel. Long enough that a fling commits once, not once
   * per notch, and short enough that nothing observes the two out of step. */
  const scheduleCommit = () => {
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(commitView, 160);
  };

  useEffect(
    () => () => {
      if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    },
    [],
  );

  const fit = () => {
    const frame = frameRef.current;
    if (!frame || layout.width === 0) return;
    const k = Math.min(
      (frame.clientWidth - 24) / layout.width,
      (frame.clientHeight - 24) / layout.height,
      1,
    );
    const scale = Math.max(ZOOM_MIN, k);
    // Offset by the content's own origin: a box dragged left of it makes `minX` negative, and
    // centring the *size* alone would leave the diagram sitting that far off to one side.
    applyView({
      k: scale,
      x: (frame.clientWidth - layout.width * scale) / 2 - layout.minX * scale,
      y: (frame.clientHeight - layout.height * scale) / 2 - layout.minY * scale,
    });
    commitView();
  };

  // Fits once per fresh diagram, not on every layout change: re-fitting after a drag or a column
  // toggle would yank the canvas out from under the hand that just moved it. Density is the one
  // exception — the whole point of packing the tables closer is to see more of them at once, and a
  // compaction you then have to zoom out to notice has done half its job.
  useLayoutEffect(() => {
    if (tab.diagram) fit();
  }, [tab.diagram, density]);

  const zoomBy = (factor: number, origin?: { x: number; y: number }) => {
    const current = viewRef.current;
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current.k * factor));
    const frame = frameRef.current;
    const point = origin ?? {
      x: (frame?.clientWidth ?? 0) / 2,
      y: (frame?.clientHeight ?? 0) / 2,
    };
    // Keeps whatever is under `point` under `point`: zooming towards the cursor rather than
    // towards the origin is the difference between navigating a diagram and hunting for it.
    applyView({
      k,
      x: point.x - ((point.x - current.x) / current.k) * k,
      y: point.y - ((point.y - current.y) / current.k) * k,
    });
    scheduleCommit();
  };

  const onWheel = (e: React.WheelEvent) => {
    const frame = frameRef.current;
    if (!frame) return;
    if (e.ctrlKey || e.metaKey) {
      const box = frame.getBoundingClientRect();
      zoomBy(Math.pow(0.999, e.deltaY), { x: e.clientX - box.left, y: e.clientY - box.top });
      return;
    }
    // A plain wheel pans, because on a trackpad a plain wheel *is* a two-finger scroll and having
    // that zoom makes the canvas impossible to read.
    const current = viewRef.current;
    applyView({ ...current, x: current.x - e.deltaX, y: current.y - e.deltaY });
    scheduleCommit();
  };

  const onPointerDown = (e: React.PointerEvent, node?: DiagramNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Captured on the frame, which is where the move and up handlers are — and which, unlike the
    // `<text>` or `<rect>` the press actually landed on, is still here at the end of the drag.
    frameRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = node
      ? { kind: "node", id: node.id, x: e.clientX, y: e.clientY, nodeX: node.x, nodeY: node.y }
      : {
          kind: "canvas",
          x: e.clientX,
          y: e.clientY,
          viewX: viewRef.current.x,
          viewY: viewRef.current.y,
        };
    if (node) setUi(tab.id, { selected: node.id });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.kind === "canvas") {
      applyView({ ...viewRef.current, x: drag.viewX + dx, y: drag.viewY + dy });
    } else {
      // Divided by the zoom, so a box follows the cursor at every scale instead of racing it.
      //
      // The other pinned boxes are read from the store rather than from the closed-over `pinned`:
      // pointer moves arrive faster than this component re-renders, so the value in scope can be a
      // frame or two behind, and spreading a stale copy would resurrect positions the user has
      // already moved. `setDiagramUi` takes a patch rather than an updater, so this is where the
      // freshness has to come from. (The dragged box itself is safe either way — its position is
      // recomputed absolutely from `drag.nodeX + dx`, never accumulated.)
      const current = useDbStore
        .getState()
        .tabs.find((entry) => entry.id === tab.id);
      const base = current?.kind === "diagram" ? current.ui.pinned : pinned;
      setUi(tab.id, {
        pinned: {
          ...base,
          [drag.id]: { x: drag.nodeX + dx / viewRef.current.k, y: drag.nodeY + dy / viewRef.current.k },
        },
      });
    }
  };

  const endDrag = () => {
    // Only a canvas drag moved the transform behind React's back; a node drag went through state.
    if (dragRef.current?.kind === "canvas") commitView();
    dragRef.current = null;
  };

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

  const flagged = useMemo(() => {
    if (highlight === "none" || !stats) return null;
    return new Set(highlight === "noPrimaryKey" ? stats.withoutPrimaryKey : stats.isolated);
  }, [highlight, stats]);

  /** Everything one click on a table should light up: itself and whatever it touches. */
  const related = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    for (const link of layout.links) {
      if (link.from === selected) set.add(link.to);
      if (link.to === selected) set.add(link.from);
    }
    return set;
  }, [selected, layout.links]);

  const copyMermaid = () => {
    if (!tab.diagram) return;
    void navigator.clipboard.writeText(toMermaid(tab.diagram));
    useToastStore.getState().pushToast(t("db.copied"), "success");
  };

  const announce = (path: string | null) => {
    if (path) useToastStore.getState().pushToast(t("db.exported", { path }), "success");
  };

  const saveSvg = async () => {
    const svg = svgRef.current;
    if (!svg) return;
    announce(await apiSaveFile(`${tab.name}.svg`, standaloneSvg(svg, layout, CANVAS_ID)).catch(() => null));
  };

  const savePng = async () => {
    const svg = svgRef.current;
    if (!svg || layout.width === 0) return;
    const png = await rasterize(standaloneSvg(svg, layout, CANVAS_ID), layout).catch(() => null);
    if (png === null) {
      useToastStore.getState().pushToast(t("db.diagram.rasterFailed"), "error");
      return;
    }
    announce(await apiSaveBinaryFile(`${tab.name}.png`, png).catch(() => null));
  };

  const saveMermaid = async () => {
    if (!tab.diagram) return;
    announce(await apiSaveFile(`${tab.name}.mmd`, toMermaid(tab.diagram)).catch(() => null));
  };

  const saveDbml = async () => {
    if (!tab.diagram) return;
    announce(
      await apiSaveFile(`${tab.name}.dbml`, schemaToDbml(tab.diagram, tab.name)).catch(() => null),
    );
  };

  /**
   * The live schema, filed as an editable diagram.
   *
   * The other three exports produce a file and stop; this one crosses into the Diagrams workspace,
   * which is what makes the pair of features worth having — read what is actually deployed, then
   * *work on it*: rename a column, add a table, generate the migration, diff it against the
   * original. None of which can be done to a picture.
   *
   * It deliberately does not navigate. The user is looking at a database and asked for a copy of
   * its schema, not to be moved somewhere else; the toast says where it went, and the diagram is
   * the one open on the next visit to that workspace.
   */
  const toDiagrams = async () => {
    if (!tab.diagram) return;
    await ensureDiagramsStoreLoaded();
    const store = useDiagramsStore.getState();
    if (store.workspaceId === null) {
      useToastStore.getState().pushToast(t("db.diagram.toDiagramsNoWorkspace"), "error");
      return;
    }
    const id = await store.createDiagram(null, tab.name, FORMAT_DBML);
    if (!id) return;
    // `createDiagram` leaves the new row as the open draft, so the document goes in through the
    // ordinary edit path and is written by the same debounced save as any other. `flush` is what
    // makes it durable now rather than in a second's time — the user may never open the workspace.
    useDiagramsStore.getState().editDoc(schemaToDbml(tab.diagram, tab.name));
    await useDiagramsStore.getState().flush();
    useToastStore.getState().pushToast(t("db.diagram.toDiagramsDone", { title: tab.name }), "success");
  };

  /** The three shapes the same picture is worth having: one that scales, one that pastes anywhere,
   * and one that is still readable as text in a pull request. */
  const exportItems: MenuItem[] = [
    { label: t("db.diagram.saveSvg"), icon: Download, onClick: () => void saveSvg() },
    { label: t("db.diagram.savePng"), icon: ImageIcon, onClick: () => void savePng() },
    { label: t("db.diagram.saveMermaid"), icon: FileCode2, onClick: () => void saveMermaid() },
    { label: t("db.diagram.saveDbml"), icon: FileCode2, onClick: () => void saveDbml() },
    { label: t("db.diagram.toDiagrams"), icon: Network, onClick: () => void toDiagrams() },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        <Network size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="max-w-[220px] truncate text-[12px] font-medium text-[var(--cf-text)]">
          {tab.name}
        </span>

        {stats && (
          <div className="flex flex-wrap items-center gap-1">
            <Chip icon={Table2} label={t("db.diagram.tablesN", { n: formatCount(stats.tables) })} />
            {stats.views > 0 && (
              <Chip icon={View} label={t("db.diagram.viewsN", { n: formatCount(stats.views) })} />
            )}
            <Chip
              icon={Network}
              label={t("db.diagram.relationsN", { n: formatCount(stats.relations) })}
              title={
                stats.inferred > 0
                  ? t("db.diagram.inferredN", { n: formatCount(stats.inferred) })
                  : undefined
              }
            />
            {/* The two chips that are findings rather than counts: they are clickable, because a
                number you can't act on is trivia. Clicking lights up exactly the tables counted. */}
            {stats.withoutPrimaryKey.length > 0 && (
              <Chip
                icon={KeyRound}
                tone="warning"
                active={highlight === "noPrimaryKey"}
                label={t("db.diagram.noPkN", {
                  n: formatCount(stats.withoutPrimaryKey.length),
                })}
                title={t("db.diagram.noPkHint")}
                onClick={() =>
                  setUi(tab.id, { highlight: highlight === "noPrimaryKey" ? "none" : "noPrimaryKey" })
                }
              />
            )}
            {stats.isolated.length > 0 && (
              <Chip
                icon={Unlink}
                active={highlight === "isolated"}
                label={t("db.diagram.isolatedN", { n: formatCount(stats.isolated.length) })}
                title={t("db.diagram.isolatedHint")}
                onClick={() =>
                  setUi(tab.id, { highlight: highlight === "isolated" ? "none" : "isolated" })
                }
              />
            )}
          </div>
        )}

        <div className="relative ml-auto">
          <Search
            size={11}
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
          />
          <input
            value={query}
            onChange={(e) => setUi(tab.id, { query: e.target.value })}
            placeholder={t("db.diagram.findPlaceholder")}
            className="w-[150px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] py-[3px] pl-5 pr-5 text-[11.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
          />
          {query && (
            <button
              onClick={() => setUi(tab.id, { query: "" })}
              aria-label={t("db.clearSearch")}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Keys-only is the default for a reason: at the zoom where a schema fits on screen, a
              hundred `varchar` rows are noise and the keys are the whole message.

              Lit means the filter is *on* — keys only. It used to light up on `all`, which read as
              "the key icon is active, so I am looking at keys" while the card showed every column:
              the button said the opposite of what the canvas did. The title still describes the
              click, not the state, which is the other half of getting a toggle right. */}
          <ToolbarButton
            onClick={() => setUi(tab.id, { mode: mode === "keys" ? "all" : "keys" })}
            active={mode === "keys"}
            title={mode === "keys" ? t("db.diagram.showAllColumns") : t("db.diagram.showKeysOnly")}
          >
            <KeyRound size={12} />
          </ToolbarButton>
          {/* The gaps are not the point — see `layoutDiagram`. Compact takes the tables nothing
              points at out of the flow and wraps the layers that have grown into strips, which is
              what turns a canvas of mostly whitespace back into a diagram. */}
          <ToolbarButton
            onClick={() => setUi(tab.id, { density: density === "compact" ? "roomy" : "compact" })}
            active={density === "compact"}
            title={density === "compact" ? t("db.diagram.spreadOut") : t("db.diagram.packTogether")}
          >
            <Shrink size={12} />
          </ToolbarButton>
          <ToolbarButton onClick={() => zoomBy(1.2)} title={t("db.diagram.zoomIn")}>
            <ZoomIn size={12} />
          </ToolbarButton>
          <ToolbarButton onClick={() => zoomBy(1 / 1.2)} title={t("db.diagram.zoomOut")}>
            <ZoomOut size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              setUi(tab.id, { pinned: {} });
              fit();
            }}
            title={t("db.diagram.fit")}
          >
            <Maximize2 size={12} />
          </ToolbarButton>
          <ToolbarButton onClick={copyMermaid} disabled={!tab.diagram} title={t("db.diagram.copyMermaid")}>
            <Copy size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setExportAt({ x: rect.right - 180, y: rect.bottom + 2 });
            }}
            disabled={!tab.diagram}
            title={t("db.diagram.export")}
          >
            <Download size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => void store.loadDiagram(tab.id)}
            disabled={tab.loading}
            title={t("db.refresh")}
          >
            <RefreshCw size={12} />
          </ToolbarButton>
        </div>
      </div>

      {tab.diagram && tab.diagram.notes.length > 0 && (
        <div className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">
          <AlertTriangle size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0">{tab.diagram.notes.join(" ")}</span>
        </div>
      )}

      <div
        ref={frameRef}
        onWheel={onWheel}
        onPointerDown={(e) => {
          setUi(tab.id, { selected: null });
          onPointerDown(e);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-[var(--cf-bg)] active:cursor-grabbing"
      >
        {tab.loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-[var(--cf-bg)]/70 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("db.diagram.reading")}
          </div>
        )}
        {tab.error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
            <p className="max-w-lg whitespace-pre-wrap break-words rounded-md border border-[var(--cf-danger)] bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] p-3 text-[12px] text-[var(--cf-danger)]">
              {tab.error}
            </p>
          </div>
        )}
        {!tab.loading && !tab.error && layout.nodes.length === 0 && (
          <p className="flex h-full items-center justify-center text-[12px] text-[var(--cf-text-muted)]">
            {t("db.diagram.empty")}
          </p>
        )}

        <svg ref={svgRef} className="h-full w-full" role="img" aria-label={tab.name}>
          <defs>
            <marker
              id="cf-er-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--cf-accent)" />
            </marker>
          </defs>
          <g
            ref={canvasRef}
            id={CANVAS_ID}
            transform={`translate(${view.x} ${view.y}) scale(${view.k})`}
          >
            {layout.links.map((link) => {
              const from = nodeById.get(link.from);
              const to = nodeById.get(link.to);
              if (!from || !to) return null;
              const dim = related !== null && !(related.has(link.from) && related.has(link.to));
              return (
                <path
                  key={link.id}
                  d={edgePath(from, to, link.fromColumn, link.toColumn)}
                  fill="none"
                  stroke="var(--cf-accent)"
                  strokeWidth={dim ? 1 : 1.4}
                  strokeOpacity={dim ? 0.14 : 0.6}
                  strokeDasharray={link.inferred ? "5 4" : undefined}
                  markerEnd="url(#cf-er-arrow)"
                >
                  <title>
                    {`${link.from}.${link.fromColumn} → ${link.to}.${link.toColumn}\n${link.constraint}`}
                  </title>
                </path>
              );
            })}

            {layout.nodes.map((node) => (
              <TableBox
                key={node.id}
                node={node}
                selected={selected === node.id}
                dimmed={
                  (related !== null && !related.has(node.id)) ||
                  (matches !== null && !matches.has(node.id))
                }
                flagged={flagged?.has(node.id) ?? false}
                flagTone={highlight}
                onPointerDown={(e) => onPointerDown(e, node)}
                // Double-click opens the rows: the diagram is where you work out which table you
                // want, and the next thing you want is what is in it.
                onOpen={() =>
                  !node.external &&
                  store.openData(
                    tab.connectionId,
                    {
                      kind: node.kind,
                      database: tab.node.database,
                      schema: node.schema,
                      name: node.name,
                    },
                    node.name,
                  )
                }
              />
            ))}
          </g>
        </svg>
      </div>

      {exportAt && (
        <ContextMenu
          x={exportAt.x}
          y={exportAt.y}
          items={exportItems}
          onClose={() => setExportAt(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One table
// ---------------------------------------------------------------------------

function TableBox({
  node,
  selected,
  dimmed,
  flagged,
  flagTone,
  onPointerDown,
  onOpen,
}: {
  node: DiagramNode;
  selected: boolean;
  dimmed: boolean;
  flagged: boolean;
  flagTone: Highlight;
  onPointerDown: (e: React.PointerEvent) => void;
  onOpen: () => void;
}) {
  const accent = node.external
    ? "var(--cf-text-muted)"
    : node.kind === "view"
      ? "var(--cf-text-muted)"
      : "var(--cf-accent)";
  const border = flagged
    ? flagTone === "noPrimaryKey"
      ? "var(--cf-warning)"
      : "var(--cf-accent)"
    : selected
      ? "var(--cf-accent)"
      : "var(--cf-border)";

  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      opacity={dimmed ? 0.22 : 1}
      onPointerDown={onPointerDown}
      onDoubleClick={onOpen}
      style={{ cursor: "move" }}
    >
      <rect
        width={node.width}
        height={node.height}
        rx={7}
        fill="var(--cf-surface)"
        stroke={border}
        strokeWidth={selected || flagged ? 1.8 : 1}
      />
      <rect width={node.width} height={26} rx={7} fill={accent} fillOpacity={node.external ? 0.08 : 0.14} />
      {/* Squares off the bottom corners of the header, which `rx` would otherwise round into the
          first column row. */}
      <rect y={19} width={node.width} height={7} fill={accent} fillOpacity={node.external ? 0.08 : 0.14} />

      <text x={9} y={17} fontSize={11.5} fontWeight={600} fill="var(--cf-text)">
        {clip(node.name, node.width - 60)}
      </text>
      {node.rowEstimate !== null && node.rowEstimate > 0 && (
        <text
          x={node.width - 8}
          y={17}
          fontSize={9.5}
          textAnchor="end"
          fill="var(--cf-text-muted)"
        >
          {`~${formatCount(node.rowEstimate)}`}
        </text>
      )}
      {node.external && (
        <text x={node.width - 8} y={17} fontSize={9} textAnchor="end" fill="var(--cf-text-muted)">
          ↗
        </text>
      )}

      {node.visible.map((column, index) => {
        const y = 26 + index * 18;
        const marker = column.primary_key ? "PK" : column.foreign_key ? "FK" : "";
        return (
          <g key={column.name}>
            {index > 0 && (
              <line x1={0} y1={y} x2={node.width} y2={y} stroke="var(--cf-border)" strokeOpacity={0.5} />
            )}
            {marker && (
              <text
                x={9}
                y={y + 12.5}
                fontSize={8}
                fontWeight={700}
                fill={column.primary_key ? "var(--cf-warning)" : "var(--cf-accent)"}
              >
                {marker}
              </text>
            )}
            <text
              x={marker ? 26 : 9}
              y={y + 12.5}
              fontSize={10.5}
              fill="var(--cf-text)"
              fontStyle={column.nullable ? "italic" : undefined}
            >
              {clip(column.name, node.width * 0.55)}
            </text>
            <text
              x={node.width - 8}
              y={y + 12.5}
              fontSize={9.5}
              textAnchor="end"
              fill="var(--cf-text-muted)"
            >
              {clip(column.data_type, node.width * 0.38)}
            </text>
          </g>
        );
      })}

      {node.hidden > 0 && (
        <text
          x={9}
          y={node.height - 5}
          fontSize={9.5}
          fill="var(--cf-text-muted)"
          fontStyle="italic"
        >
          {`+${node.hidden} more`}
        </text>
      )}
    </g>
  );
}

function Chip({
  icon: Icon,
  label,
  title,
  tone,
  active,
  onClick,
}: {
  icon: typeof Table2;
  label: string;
  title?: string;
  tone?: "warning";
  active?: boolean;
  onClick?: () => void;
}) {
  const color = tone === "warning" ? "var(--cf-warning)" : "var(--cf-text-muted)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={!onClick}
      style={{ color: active ? "var(--cf-accent)" : color }}
      className={`flex items-center gap-1 rounded-md border px-1.5 py-[2px] text-[10.5px] tabular-nums ${
        active
          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
          : "border-[var(--cf-border)]"
      } ${onClick ? "hover:border-[var(--cf-accent)]" : "cursor-default"}`}
    >
      <Icon size={10} />
      {label}
    </button>
  );
}
