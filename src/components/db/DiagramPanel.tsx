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
  type DiagramColumnMode,
  type DiagramDensity,
  type DiagramLayout,
  type DiagramNode,
} from "../../lib/db/erLayout";
import { useDbStore, type DbDiagramTab } from "../../state/dbStore";
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

/** Which set of tables the panel is lighting up, when a stat chip has been clicked. */
type Highlight = "none" | "noPrimaryKey" | "isolated";

export function DiagramPanel({ tab }: { tab: DbDiagramTab }) {
  const t = useT();
  const store = useDbStore.getState();
  const [mode, setMode] = useState<DiagramColumnMode>("keys");
  const [density, setDensity] = useState<DiagramDensity>("roomy");
  const [pinned, setPinned] = useState<Record<string, { x: number; y: number }>>({});
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<Highlight>("none");
  /** Where the export menu was opened from, or `null` when it is closed. */
  const [exportAt, setExportAt] = useState<{ x: number; y: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
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
        : { nodes: [], links: [], width: 0, height: 0 },
    [tab.diagram, mode, pinned, density],
  );
  const stats = useMemo(() => (tab.diagram ? diagramStats(tab.diagram) : null), [tab.diagram]);

  const fit = () => {
    const frame = frameRef.current;
    if (!frame || layout.width === 0) return;
    const k = Math.min(
      (frame.clientWidth - 24) / layout.width,
      (frame.clientHeight - 24) / layout.height,
      1,
    );
    const scale = Math.max(ZOOM_MIN, k);
    setView({
      k: scale,
      x: (frame.clientWidth - layout.width * scale) / 2,
      y: (frame.clientHeight - layout.height * scale) / 2,
    });
  };

  // Fits once per fresh diagram, not on every layout change: re-fitting after a drag or a column
  // toggle would yank the canvas out from under the hand that just moved it. Density is the one
  // exception — the whole point of packing the tables closer is to see more of them at once, and a
  // compaction you then have to zoom out to notice has done half its job.
  useLayoutEffect(() => {
    if (tab.diagram) fit();
  }, [tab.diagram, density]);

  const zoomBy = (factor: number, origin?: { x: number; y: number }) => {
    setView((current) => {
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current.k * factor));
      const frame = frameRef.current;
      const point = origin ?? {
        x: (frame?.clientWidth ?? 0) / 2,
        y: (frame?.clientHeight ?? 0) / 2,
      };
      // Keeps whatever is under `point` under `point`: zooming towards the cursor rather than
      // towards the origin is the difference between navigating a diagram and hunting for it.
      return {
        k,
        x: point.x - ((point.x - current.x) / current.k) * k,
        y: point.y - ((point.y - current.y) / current.k) * k,
      };
    });
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
    setView((current) => ({ ...current, x: current.x - e.deltaX, y: current.y - e.deltaY }));
  };

  const onPointerDown = (e: React.PointerEvent, node?: DiagramNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Captured on the frame, which is where the move and up handlers are — and which, unlike the
    // `<text>` or `<rect>` the press actually landed on, is still here at the end of the drag.
    frameRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = node
      ? { kind: "node", id: node.id, x: e.clientX, y: e.clientY, nodeX: node.x, nodeY: node.y }
      : { kind: "canvas", x: e.clientX, y: e.clientY, viewX: view.x, viewY: view.y };
    if (node) setSelected(node.id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.kind === "canvas") {
      setView((current) => ({ ...current, x: drag.viewX + dx, y: drag.viewY + dy }));
    } else {
      // Divided by the zoom, so a box follows the cursor at every scale instead of racing it.
      setPinned((current) => ({
        ...current,
        [drag.id]: { x: drag.nodeX + dx / view.k, y: drag.nodeY + dy / view.k },
      }));
    }
  };

  const endDrag = () => {
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
    announce(await apiSaveFile(`${tab.name}.svg`, standaloneSvg(svg, layout)).catch(() => null));
  };

  const savePng = async () => {
    const svg = svgRef.current;
    if (!svg || layout.width === 0) return;
    const png = await rasterize(standaloneSvg(svg, layout), layout).catch(() => null);
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

  /** The three shapes the same picture is worth having: one that scales, one that pastes anywhere,
   * and one that is still readable as text in a pull request. */
  const exportItems: MenuItem[] = [
    { label: t("db.diagram.saveSvg"), icon: Download, onClick: () => void saveSvg() },
    { label: t("db.diagram.savePng"), icon: ImageIcon, onClick: () => void savePng() },
    { label: t("db.diagram.saveMermaid"), icon: FileCode2, onClick: () => void saveMermaid() },
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
                  setHighlight((current) => (current === "noPrimaryKey" ? "none" : "noPrimaryKey"))
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
                  setHighlight((current) => (current === "isolated" ? "none" : "isolated"))
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("db.diagram.findPlaceholder")}
            className="w-[150px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] py-[3px] pl-5 pr-5 text-[11.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
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
            onClick={() => setMode((current) => (current === "keys" ? "all" : "keys"))}
            active={mode === "keys"}
            title={mode === "keys" ? t("db.diagram.showAllColumns") : t("db.diagram.showKeysOnly")}
          >
            <KeyRound size={12} />
          </ToolbarButton>
          {/* The gaps are not the point — see `layoutDiagram`. Compact takes the tables nothing
              points at out of the flow and wraps the layers that have grown into strips, which is
              what turns a canvas of mostly whitespace back into a diagram. */}
          <ToolbarButton
            onClick={() => setDensity((current) => (current === "compact" ? "roomy" : "compact"))}
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
              setPinned({});
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
          setSelected(null);
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
          <g id="cf-er-canvas" transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {layout.links.map((link) => {
              const from = layout.nodes.find((node) => node.id === link.from);
              const to = layout.nodes.find((node) => node.id === link.to);
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

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The line between two tables, anchored on the columns the key is actually made of.
 *
 * Anchoring on the *column row* rather than the box is what makes a composite key readable: two
 * lines between the same pair of tables leave from two different rows and arrive at two different
 * rows, instead of overlapping into one thick line that says nothing about which column is which.
 *
 * A cubic with horizontal control points, so the curve leaves and arrives perpendicular to the box
 * edge — an arrow that meets a box at a slant reads as pointing past it.
 */
function edgePath(
  from: DiagramNode,
  to: DiagramNode,
  fromColumn: string,
  toColumn: string,
): string {
  const fromY = from.y + (from.rowY[fromColumn] ?? from.height / 2);
  const toY = to.y + (to.rowY[toColumn] ?? to.height / 2);

  if (from.id === to.id) {
    // A self-reference (`employee.manager_id → employee`) loops out of the right edge and back.
    const x = from.x + from.width;
    return `M ${x} ${fromY} C ${x + 46} ${fromY}, ${x + 46} ${toY}, ${x} ${toY}`;
  }

  const fromRight = from.x + from.width / 2 <= to.x + to.width / 2;
  const x1 = fromRight ? from.x + from.width : from.x;
  const x2 = fromRight ? to.x : to.x + to.width;
  const reach = Math.max(30, Math.abs(x2 - x1) * 0.45);
  const c1 = fromRight ? x1 + reach : x1 - reach;
  const c2 = fromRight ? x2 - reach : x2 + reach;
  return `M ${x1} ${fromY} C ${c1} ${fromY}, ${c2} ${toY}, ${x2} ${toY}`;
}

/** Truncates to what fits `width` pixels at the sizes the boxes use. */
function clip(text: string, width: number): string {
  const max = Math.max(3, Math.floor(width / 5.9));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The rendered diagram as a file that opens anywhere.
 *
 * The screen's SVG is themed with CSS custom properties, which mean nothing outside this window —
 * an export that kept them would open as black text on a black background, or as nothing at all. So
 * every `var(--cf-…)` is resolved against the live theme on the way out, and the viewBox is set to
 * the whole diagram rather than to the current pan, because a saved picture should be the schema,
 * not the part of it that happened to be scrolled into view.
 */
function standaloneSvg(source: SVGSVGElement, layout: DiagramLayout): string {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const styles = getComputedStyle(document.documentElement);
  const resolve = (value: string) =>
    value.replace(/var\((--[a-z0-9-]+)\)/gi, (_match, name: string) =>
      (styles.getPropertyValue(name) || "#888").trim(),
    );

  for (const element of clone.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.value.includes("var(--")) {
        element.setAttribute(attribute.name, resolve(attribute.value));
      }
    }
  }

  // Undo the pan/zoom: the file is the whole diagram at 1:1.
  clone.querySelector("#cf-er-canvas")?.setAttribute("transform", "translate(0 0)");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // On screen the text inherits its face from the page. Detached from the page it would fall back to
  // whatever the viewer calls default — usually a serif, always wider than the boxes were measured
  // for, so names that fit here would overrun there. Named explicitly, and the raster export goes
  // through the same string, so the PNG matches the SVG.
  clone.setAttribute("font-family", getComputedStyle(source).fontFamily || "system-ui, sans-serif");
  clone.setAttribute("width", String(Math.ceil(layout.width)));
  clone.setAttribute("height", String(Math.ceil(layout.height)));
  clone.setAttribute("viewBox", `0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}`);
  clone.removeAttribute("class");

  // An opaque background, prepended so it sits behind everything: an SVG with a transparent ground
  // opens as dark-on-dark in any viewer whose own page is dark.
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", resolve("var(--cf-bg)"));
  clone.insertBefore(background, clone.firstChild);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
}

/** Above this many pixels a canvas stops being allocated and starts returning a blank one, which
 * would save a transparent rectangle where the schema should be. */
const MAX_RASTER_PIXELS = 24e6;
const MAX_RASTER_EDGE = 8192;

/**
 * The same picture as pixels, Base64-encoded and ready for `apiSaveBinaryFile`.
 *
 * Drawn at 2× so it stays sharp in a document or a ticket, but scaled back down for a schema large
 * enough to hit a canvas limit — a smaller PNG is worth having and a blank one is not. Routed
 * through the *standalone* SVG rather than the live one on purpose: every `var(--cf-…)` has already
 * been resolved there, and an image element gets no stylesheet to resolve them against, so
 * rasterising what is on screen would produce a picture drawn entirely in the fallback grey.
 */
function rasterize(svgText: string, layout: DiagramLayout): Promise<string> {
  const scale = Math.min(
    2,
    MAX_RASTER_EDGE / Math.max(layout.width, layout.height),
    Math.sqrt(MAX_RASTER_PIXELS / (layout.width * layout.height)),
  );

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(layout.width * scale));
      canvas.height = Math.max(1, Math.ceil(layout.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("no 2d context"));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // `toDataURL` hands back `data:image/png;base64,…`; the command wants the payload alone.
      const encoded = canvas.toDataURL("image/png").split(",")[1];
      if (encoded) resolve(encoded);
      else reject(new Error("empty raster"));
    };
    image.onerror = () => reject(new Error("the diagram could not be rasterised"));
    image.src = svgDataUri(svgText);
  });
}

/** Base64 rather than percent-encoding, because a schema is full of characters — the `↗` on an
 * external stub, an accented column name — that a URI-encoded `data:` payload gets wrong often
 * enough to matter. Chunked, since spreading a megabyte of bytes into one call overflows the stack. */
function svgDataUri(svgText: string): string {
  const bytes = new TextEncoder().encode(svgText);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
