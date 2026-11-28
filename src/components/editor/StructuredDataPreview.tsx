import "@xyflow/react/dist/style.css";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, getSmoothStepPath, Position, ReactFlow, ReactFlowProvider,
  useReactFlow, useViewport, type Node, type NodeProps,
} from "@xyflow/react";
import {
  Braces, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ListTree, Network,
  Scan, Search, X, ZoomIn, ZoomOut,
} from "lucide-react";
import {
  dataGraphConnections, dataGraphLayout, findGraphMatches, parseDataGraph, GRAPH_CARD_HEADER, GRAPH_CARD_PREVIEW,
  GRAPH_CARD_ROW, GRAPH_CARD_WIDTH, type DataEntry, type DataGraph, type DataNode, type DataScalar, type PositionedDataNode,
} from "../../lib/structuredDataGraph";
import type { StructuredDataFormat } from "../../lib/structuredDataFormat";
import { csvSeparatorFor, separatorById } from "../../lib/csvDialect";
import { useCsvStore } from "../../state/csvStore";
import { useT } from "../../state/languageStore";
import { iconButtonClass } from "../common/Button";
import { EmptyState } from "../common/EmptyState";
import { fieldClass } from "../common/recipes";

type Card = Node<{
  node: DataNode;
  expanded: boolean;
  selected: boolean;
  highlighted: boolean;
  matchField?: string;
  toggle: (node: DataNode, expanded: boolean) => void;
  inspect: (path: string) => void;
  revealChild: (path: string) => void;
}, "data">;

const CONNECTION_DOT = "pointer-events-none absolute top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full border border-[var(--cf-surface)] bg-[var(--cf-accent)]";

const SCALAR_COLOR: Record<DataScalar["kind"], string> = {
  string: "text-[var(--cf-success)]",
  number: "text-[var(--cf-blue)]",
  boolean: "text-[var(--cf-accent)]",
  null: "text-[var(--cf-text-faint)]",
  alias: "text-[var(--cf-warning)]",
};

function scalarText(value: DataScalar) {
  return value.kind === "string" && value.text === "" ? '""' : value.text;
}

function nodeShape(node: DataNode) {
  if (node.kind === "array") return `[${node.size}]`;
  if (node.kind === "object") return `{${node.size}}`;
  if (node.kind === "element") return "</>";
  return node.entries[0].scalar?.kind ?? "";
}

function CardView({ data }: NodeProps<Card>) {
  const t = useT();
  const { node, expanded, selected, highlighted, matchField, toggle, inspect, revealChild } = data;
  const Icon = node.kind === "array" ? ListTree : Braces;
  const hasChildren = node.entries.some((field) => field.child);
  const remaining = node.size - Math.min(node.entries.length, GRAPH_CARD_PREVIEW);
  const label = expanded ? t("editor.data.collapse") : t("editor.data.expand");
  return (
    <div className={`relative h-full rounded-[10px] border bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-lift)] ${selected || highlighted
      ? "border-[var(--cf-accent)] ring-1 ring-[var(--cf-accent-line)]" : "border-[var(--cf-border)]"}`}>
      {node.parent && <span aria-hidden className={`${CONNECTION_DOT} left-0 -translate-x-1/2`} />}
      {hasChildren && <span aria-hidden className={`${CONNECTION_DOT} right-0 translate-x-1/2`} />}
      <div style={{ height: GRAPH_CARD_HEADER }} className="flex items-center gap-1 rounded-t-[9px] border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2">
        <button
          type="button" onClick={() => inspect(node.path)} title={node.path}
          className="nodrag nopan flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-[var(--cf-hover)]"
        >
          <Icon size={14} className="shrink-0 text-[var(--cf-accent)]" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{node.key || '""'}</span>
          <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text-muted)]">{nodeShape(node)}</span>
        </button>
        {hasChildren && (
          <button
            type="button" title={label} aria-label={label} aria-expanded={expanded}
            onClick={(event) => { event.stopPropagation(); toggle(node, expanded); }}
            className={iconButtonClass({ size: "xs", className: "nodrag nopan" })}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
      </div>
      {node.entries.slice(0, GRAPH_CARD_PREVIEW).map((field) => {
        const rowClass = "flex w-full items-center gap-2 px-3 font-mono text-[11px]";
        const key = node.kind !== "scalar" && <span title={field.key} className="max-w-[54%] shrink-0 truncate text-[var(--cf-text-muted)]">{field.key || '\"\"'}</span>;
        const child = field.child;
        if (child) {
          return (
            <button key={field.path} type="button" style={{ height: GRAPH_CARD_ROW }}
              aria-label={t("editor.data.openField", { key: field.key })}
              onClick={(event) => { event.stopPropagation(); revealChild(child.path); }}
              className={`${rowClass} nodrag nopan text-left hover:bg-[var(--cf-hover)]`}>
              {key}
              <span className="ml-auto shrink-0 text-[var(--cf-accent)]">{nodeShape(child)} <span aria-hidden>›</span></span>
            </button>
          );
        }
        return (
          <div key={field.path} style={{ height: GRAPH_CARD_ROW }} className={`${rowClass} ${matchField === field.path ? "bg-[var(--cf-accent-soft)]" : ""}`}>
            {key}
            {field.scalar && <span className={`ml-auto min-w-0 truncate ${SCALAR_COLOR[field.scalar.kind]}`}>{scalarText(field.scalar)}</span>}
          </div>
        );
      })}
      {node.entries.length === 0 && (
        <div style={{ height: GRAPH_CARD_ROW }} className="flex items-center px-3 text-[11px] text-[var(--cf-text-faint)]">
          {t(node.size ? "editor.data.partial" : "editor.data.emptyGroup")}
        </div>
      )}
      {node.entries.length > 0 && remaining > 0 && (
        <button
          type="button" style={{ height: GRAPH_CARD_ROW }}
          className="nodrag nopan block w-full px-3 text-left text-[11px] text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
          onClick={() => inspect(node.path)}
        >
          {t("editor.data.more", { count: remaining })}
        </button>
      )}
    </div>
  );
}

const NODE_TYPES = { data: CardView };
const PAGE_SIZE = 60;

function FieldValue({ field, onInspect }: { field: DataEntry; onInspect: (path: string) => void }) {
  const t = useT();
  if (field.child) {
    const child = field.child;
    return (
      <button type="button" aria-label={t("editor.data.openField", { key: field.key })} onClick={() => onInspect(child.path)} className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[12px] text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]">
        {nodeShape(child)} <ChevronRight size={12} />
      </button>
    );
  }
  if (!field.scalar) return null;
  return <code className={`min-w-0 flex-1 whitespace-pre-wrap break-all text-[11.5px] ${SCALAR_COLOR[field.scalar.kind]}`}>{scalarText(field.scalar)}</code>;
}

function Inspector({ node, matchField, onClose, onInspect }: {
  node: DataNode;
  matchField?: string;
  onClose: () => void;
  onInspect: (path: string) => void;
}) {
  const t = useT();
  const [page, setPage] = useState(() => Math.max(0, Math.floor(node.entries.findIndex((entry) => entry.path === matchField) / PAGE_SIZE)));
  const lastPage = Math.max(0, Math.ceil(node.entries.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const rows = node.entries.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const matchedRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    matchedRow.current?.scrollIntoView({ block: "nearest" });
  }, [matchField, currentPage]);
  return (
    <aside aria-label={t("editor.data.details")} className="absolute bottom-3 right-3 z-10 flex max-h-[55%] w-[min(320px,calc(100%-1.5rem))] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)] @min-[740px]:top-3 @min-[740px]:max-h-none">
      <div className="flex min-w-0 items-start gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold" title={node.key}>{node.key || '""'}</p>
          <p className="mt-0.5 break-all font-mono text-[11px] text-[var(--cf-text-muted)]">{node.path}</p>
        </div>
        <button type="button" title={t("common.close")} aria-label={t("common.close")} className={iconButtonClass({ size: "xs" })} onClick={onClose}><X size={14} /></button>
      </div>
      <div className="min-h-0 flex-1 divide-y divide-[var(--cf-border)] overflow-auto px-3">
        {rows.length ? rows.map((field) => (
          <div key={field.path} ref={matchField === field.path ? matchedRow : undefined}
            className={`flex items-start gap-2 py-2 ${matchField === field.path ? "bg-[var(--cf-accent-soft)]" : ""}`}>
            {node.kind !== "scalar" && <span className="max-w-[47%] shrink-0 break-all font-mono text-[11.5px] text-[var(--cf-text-muted)]">{field.key || '\"\"'}</span>}
            <FieldValue field={field} onInspect={onInspect} />
          </div>
        )) : <p className="py-3 text-[12px] text-[var(--cf-text-muted)]">{t(node.size ? "editor.data.partial" : "editor.data.emptyGroup")}</p>}
      </div>
      {lastPage > 0 && (
        <div className="flex items-center justify-end gap-1 border-t border-[var(--cf-border)] px-3 py-1.5 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          <button type="button" aria-label={t("editor.data.previousPage")} disabled={currentPage === 0} className={iconButtonClass({ size: "xs" })} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></button>
          <span>{currentPage + 1} / {lastPage + 1}</span>
          <button type="button" aria-label={t("editor.data.nextPage")} disabled={currentPage === lastPage} className={iconButtonClass({ size: "xs" })} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></button>
        </div>
      )}
    </aside>
  );
}

function GraphZoom() {
  const t = useT();
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const icon = iconButtonClass({ size: "xs" });
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" aria-label={t("flows.zoomOut")} title={t("flows.zoomOut")} onClick={() => void flow.zoomOut({ duration: 120 })} className={icon}><ZoomOut size={14} /></button>
      <span className="w-9 text-center text-[11px] tabular-nums text-[var(--cf-text-muted)]">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label={t("flows.zoomIn")} title={t("flows.zoomIn")} onClick={() => void flow.zoomIn({ duration: 120 })} className={icon}><ZoomIn size={14} /></button>
      <button type="button" aria-label={t("flows.fit")} title={t("flows.fit")} onClick={() => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 160 })} className={icon}><Scan size={14} /></button>
    </div>
  );
}

function GraphConnections({ positioned }: { positioned: readonly PositionedDataNode[] }) {
  const { x, y, zoom } = useViewport();
  const paths = useMemo(() => dataGraphConnections(positioned).map(({ id, ...coordinates }) => {
    const [path] = getSmoothStepPath({ ...coordinates, sourcePosition: Position.Right, targetPosition: Position.Left });
    return <path key={id} d={path} />;
  }), [positioned]);

  // The canvas may be hidden by the editor or cull offscreen cards. Draw from their layout in
  // one viewport-sized SVG so the connections never depend on when those cards are measured.
  return (
    <svg aria-hidden data-structured-connections="" className="pointer-events-none absolute inset-0 z-0 h-full w-full"
      fill="none" stroke="var(--cf-accent)" strokeOpacity={0.72} strokeWidth={1.6} strokeLinecap="round">
      <g transform={`translate(${x} ${y}) scale(${zoom})`}>{paths}</g>
    </svg>
  );
}

function GraphCanvas({ graph }: { graph: DataGraph }) {
  const t = useT();
  const flow = useReactFlow<Card>();
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [inspection, setInspection] = useState<string>();
  const [navigation, setNavigation] = useState<{ path: string; zoomIn: boolean }>();
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const [initialized, setInitialized] = useState(false);
  const matches = useMemo(() => findGraphMatches(graph, query), [graph, query]);
  const activeIndex = matches.length ? matchIndex % matches.length : 0;
  const match = matches[activeIndex];
  const reveal = navigation?.path ?? match?.node;
  const zoomToReveal = navigation?.zoomIn ?? !!match;
  const positioned = useMemo(() => dataGraphLayout(graph, toggled, reveal), [graph, toggled, reveal]);
  const selected = inspection ? graph.nodes.get(inspection) : undefined;

  const clearSearch = () => { setQuery(""); setMatchIndex(0); };
  const focusField = (path: string) => {
    setInspection(path);
    setNavigation({ path, zoomIn: true });
  };
  const toggleBranch = (node: DataNode, expanded: boolean) => {
    if (expanded && reveal && (reveal.startsWith(node.path + ".") || reveal.startsWith(node.path + "["))) {
      if (match) clearSearch();
    }
    setNavigation({ path: node.path, zoomIn: false });
    setToggled((previous) => new Map(previous).set(node.path, !expanded));
  };
  const stepMatch = (direction: number, open = false) => {
    if (!matches.length) return;
    const next = (activeIndex + direction + matches.length) % matches.length;
    setMatchIndex(next);
    setNavigation(undefined);
    setInspection(open || inspection ? matches[next].node : undefined);
  };

  const nodes: Card[] = positioned.map(({ node, expanded, x, y, height }) => ({
    id: node.path, type: "data", position: { x, y }, width: GRAPH_CARD_WIDTH, height,
    data: {
      node, expanded, selected: inspection === node.path, highlighted: match?.node === node.path,
      matchField: match?.node === node.path ? match.field : undefined, toggle: toggleBranch,
      inspect: setInspection, revealChild: focusField,
    },
  }));
  const focused = positioned.find((item) => item.node.path === reveal);
  const x = focused?.x;
  const y = focused ? focused.y + focused.height / 2 : undefined;
  useEffect(() => {
    if (!initialized || x === undefined || y === undefined) return;
    void flow.setCenter(x + GRAPH_CARD_WIDTH / 2, y, { zoom: zoomToReveal ? Math.max(0.75, flow.getZoom()) : flow.getZoom(), duration: 160 });
  }, [initialized, flow, reveal, x, y, zoomToReveal]);

  return (
    <section aria-label={t("editor.viewDataGraph")} className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--cf-sunken)]">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="relative min-w-[88px] max-w-[270px] flex-1">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]" />
            <input type="search" aria-label={t("editor.data.search")} placeholder={t("editor.data.search")}
              value={query} onChange={(event) => {
                setQuery(event.target.value);
                setMatchIndex(0);
                setNavigation(undefined);
                setInspection(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  stepMatch(event.shiftKey ? -1 : inspection ? 1 : 0, true);
                }
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  clearSearch();
                }
              }}
              className={fieldClass({ size: "sm", className: "w-full pl-7" })}
            />
          </div>
          {query.trim() && (
            <div className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              <span aria-live="polite" title={t("editor.data.matches")}>{matches.length ? `${activeIndex + 1}/${matches.length}` : "0"}</span>
              <button type="button" aria-label={t("editor.data.previousMatch")} disabled={matches.length < 2} onClick={() => stepMatch(-1)} className={iconButtonClass({ size: "xs" })}><ChevronLeft size={13} /></button>
              <button type="button" aria-label={t("editor.data.nextMatch")} disabled={matches.length < 2} onClick={() => stepMatch(1)} className={iconButtonClass({ size: "xs" })}><ChevronRight size={13} /></button>
            </div>
          )}
        </div>
        <GraphZoom />
      </div>
      {graph.truncated && <p role="status" className="shrink-0 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-warning)]">{t("editor.data.partial")}</p>}
      <div className="relative min-h-0 flex-1 @container">
        <ReactFlow<Card>
          nodes={nodes} nodeTypes={NODE_TYPES}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
          nodesFocusable={false} deleteKeyCode={null}
          selectionKeyCode={null} multiSelectionKeyCode={null} panActivationKeyCode={null}
          zoomActivationKeyCode={null} minZoom={0.08} maxZoom={2.5}
          fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          onInit={() => setInitialized(true)}
          onPaneClick={() => setInspection(undefined)}
          onNodeClick={(_, node) => setInspection(node.id)}
          onlyRenderVisibleElements proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} color="var(--cf-border-strong)" gap={19} size={1} />
          <GraphConnections positioned={positioned} />
        </ReactFlow>
        {selected && (
          <Inspector key={selected.path + (match?.field ?? "")} node={selected}
            matchField={match?.node === selected.path ? match.field : undefined}
            onClose={() => setInspection(undefined)} onInspect={focusField}
          />
        )}
      </div>
    </section>
  );
}

export default function StructuredDataPreview({ format, content, originalContent, path, fileKey }: {
  format: StructuredDataFormat;
  content: string;
  originalContent: string;
  path: string;
  fileKey?: string;
}) {
  const t = useT();
  const choice = useCsvStore((s) => s.separator);
  const override = useCsvStore((s) => fileKey ? s.fileSeparators[fileKey] : undefined);
  const delimiter = useMemo(() => {
    if (format !== "csv") return undefined;
    const separator = csvSeparatorFor(path, originalContent || content, { rainbow: true, separator: choice, override });
    return separator ? separatorById(separator).char : undefined;
  }, [format, path, originalContent, content, choice, override]);
  const result = useMemo(
    () => parseDataGraph(format, content, path.split(/[\\/]/).pop() ?? path, delimiter),
    [format, content, path, delimiter],
  );

  if (result.kind === "empty") return <EmptyState icon={Network} title={t("editor.data.empty")} />;
  if (result.kind === "too_large") return <EmptyState icon={CircleAlert} title={t("editor.data.tooLarge")} subtitle={t("editor.data.tooLargeHint")} />;
  if (result.kind === "invalid") {
    return <EmptyState icon={CircleAlert} title={t("editor.data.invalid", { format: format.toUpperCase() })} subtitle={result.message} />;
  }
  return <ReactFlowProvider><GraphCanvas graph={result.graph} /></ReactFlowProvider>;
}
