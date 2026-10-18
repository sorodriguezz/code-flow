import "@xyflow/react/dist/style.css";
import "./codemap.css";

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ArrowRightLeft, ChevronRight, FileCode2, FileQuestion, Folder, FolderTree, GitFork, LoaderCircle, Network, RefreshCw, Repeat, Search, Users, Waypoints, Workflow, X } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { Segmented } from "../common/Segmented";
import { buttonClass, iconButtonClass } from "../common/Button";
import { AiSparkles } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { ArchifyTopicDialog, type TopicKind } from "../diagrams/ArchifyTopicDialog";
import { chipClass, fieldClass, rowClass, sectionLabelClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useAiRunStore, isCancellation, newRunId } from "../../state/aiRunStore";
import { notify } from "../../state/notificationStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { layoutMap } from "../../lib/codemap/layout";
import { parseArchify } from "../../lib/diagrams/archify/ir";
import { storedDocument } from "../../lib/diagrams/archify/sourceFile";
import { FORMAT_ARCHIFY } from "../../lib/diagrams/doc";
import { serializeTags } from "../../lib/notes/tags";
import { diagramsArchifyProject, diagramsCreateDiagram, type ArchifyKind } from "../../lib/tauri/diagramsCommands";
import {
  codemapFind,
  codemapGlobal,
  codemapGraph,
  codemapHealth,
  codemapKeySymbols,
  codemapOutline,
  codemapUsages,
  type FileOutline,
  type FileStanding,
  type MapBuild,
  type MapGraph,
  type MapNode,
  type SymbolHit,
  type UsageReport,
} from "../../lib/tauri/codemapCommands";

/**
 * «Mapa»: the repository as its folders and the imports between them, from the same map the agents
 * read (`codemap`). One level at a time — a folder opens into its subfolders and files — with a side
 * panel that answers the two questions the map is for: what does this file declare, and who uses
 * that. Every declaration opens in the editor at its line.
 *
 * Read-only by design: nothing here is dragged, connected or deleted, so React Flow's keys are all
 * off (a kept-alive canvas listening for Backspace once ate keystrokes meant for another view — see
 * Flujos' `KEYS_OFF_SCREEN`).
 */

/** The folder each repository was last looked at in, while the app runs. */
const FOCUS = new Map<string, string>();

/** Whole project, or one folder at a time — per repository, while the app runs. */
type Mode = "global" | "folders";
const MODE = new Map<string, Mode>();

/** One colour per top-level folder in the global view, fixed hues so neighbours tell apart whatever
 *  the accent; the largest regions take the first ones. A file at the root stays neutral. */
const GROUP_COLORS = [
  "var(--cf-blue)",
  "var(--cf-teal)",
  "var(--cf-violet)",
  "var(--cf-warning)",
  "var(--cf-success)",
  "var(--cf-ref-tag)",
  "var(--cf-danger)",
  "var(--cf-accent)",
];

function groupColors(nodes: MapNode[]): Map<string, string> {
  const sizes = new Map<string, number>();
  for (const node of nodes) if (node.group) sizes.set(node.group, (sizes.get(node.group) ?? 0) + node.files);
  const ordered = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return new Map(ordered.map(([group], i) => [group, GROUP_COLORS[i % GROUP_COLORS.length]]));
}

/** Nodes drawn at once. A folder of 166 stores laid out whole is a wall of unreadable cards at the
 *  zoom that fits it; the rest are one click away in the side panel's list. The minimap is what
 *  makes this many navigable — zoomed in to read, the rest is a drag on it away. */
const MAX_NODES = 60;

/** From this many nodes the canvas no longer reads whole at a glance, and the minimap shows. */
const MINIMAP_FROM = 13;

/** The nodes worth drawing first: folders, then what the most files depend on. */
function drawable(graph: MapGraph): { shown: MapNode[]; hidden: MapNode[] } {
  const ranked = [...graph.nodes].sort((a, b) => Number(b.folder) - Number(a.folder) || b.importedBy - a.importedBy || a.id.localeCompare(b.id));
  return { shown: ranked.slice(0, MAX_NODES), hidden: ranked.slice(MAX_NODES) };
}

type Panel =
  | { kind: "home" }
  | { kind: "rest" }
  | { kind: "file"; path: string; highlight?: number }
  | { kind: "search"; query: string }
  | { kind: "health"; list: HealthList }
  | { kind: "usages"; name: string; path: string | null };

/** The three lists the map's health section opens. */
type HealthList = "orphans" | "mostUsed" | "mostDependent";

interface MapNodeData extends Record<string, unknown> {
  node: MapNode;
  /** The global view: the node's region colour, and its folder shown above its name. */
  color?: string;
  global?: boolean;
}

/**
 * What is lit, read by each node rather than carried in its `data`. React Flow 12 drops a node's
 * measured size whenever it is handed a new node object, and hides it until measured again — so a
 * highlight in `data` re-created every node on each hover, and the whole map blinked out and back
 * as the pointer moved (user report, 2026-10-10). The nodes now change only with the graph.
 */
interface Spotlight {
  selected: string | null;
  /** Whose lines are lit: the hovered node, else the selected one. */
  spotlit: string | null;
  /** The spotlit node's neighbours, which stay bright. */
  linked: Set<string>;
}
const SpotlightContext = createContext<Spotlight>({ selected: null, spotlit: null, linked: new Set() });

type CanvasNode = Node<MapNodeData, "map">;

function formatCount(n: number): string {
  return n.toLocaleString();
}

const MapNodeView = memo(function MapNodeView({ data }: NodeProps<CanvasNode>) {
  const t = useT();
  const { node, color, global } = data;
  const spot = useContext(SpotlightContext);
  const selected = spot.selected === node.id;
  const dimmed = !!spot.spotlit && spot.spotlit !== node.id && !spot.linked.has(node.id);
  const Icon = node.folder ? Folder : FileCode2;
  const parent = node.id.includes("/") ? node.id.slice(0, node.id.length - node.label.length - 1) : "";
  return (
    <div
      className={`cf-map-node ${selected ? "cf-map-node--selected" : ""} ${dimmed ? "cf-map-node--dimmed" : ""}`}
      style={color ? { borderLeftColor: color, borderLeftWidth: 3 } : undefined}
      title={node.id}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {global && parent && <div className="mb-0.5 truncate font-mono text-[10px] text-[var(--cf-text-faint)]">{parent}/</div>}
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={14} className={node.folder ? "shrink-0 text-[var(--cf-accent)]" : "shrink-0 text-[var(--cf-text-muted)]"} />
        <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--cf-text)]">{node.label}</span>
        {node.importedBy > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
            <Users size={10} />
            {node.importedBy}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-[11px] text-[var(--cf-text-muted)]">
        {node.folder
          ? t(node.files === 1 ? "codemap.folderMetaOne" : "codemap.folderMeta", { files: formatCount(node.files), symbols: formatCount(node.symbols) })
          : t("codemap.fileMeta", { lang: node.lang, lines: formatCount(node.lines) })}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const NODE_TYPES = { map: MapNodeView };

function kindWord(t: ReturnType<typeof useT>, kind: SymbolHit["kind"]): string {
  return t(`codemap.kind.${kind}` as Parameters<typeof t>[0]);
}

export function CodeMapView() {
  return (
    <ReactFlowProvider>
      <CodeMap />
    </ReactFlowProvider>
  );
}

/** How an architecture-map run is named in the run store — and how this view finds its own. */
const ARCHIFY_RUN_KIND = "codemap.archify.runKind" as const;

function CodeMap() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const onScreen = useUiStore((s) => s.activeView === "codemap");
  const root = project?.local_path ?? null;
  /** The architecture map being written for this repository, if one is. Read from the run store
   *  rather than kept here: the run outlives this view — leaving the tab, or switching repository
   *  and back, must neither forget it nor allow a second one for the same repository. */
  const archifyRun = useAiRunStore((s) => {
    if (!project) return null;
    for (const [runId, on] of Object.entries(s.active)) {
      const about = s.aboutByRun[runId];
      if (on && about?.kindKey === ARCHIFY_RUN_KIND && about.target?.projectId === project.id) return runId;
    }
    return null;
  });
  const [diagramMenuAt, setDiagramMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** The type being asked a subject for — the dialog is open while this is set. */
  const [topicFor, setTopicFor] = useState<TopicKind | null>(null);
  const [focus, setFocus] = useState("");
  const [mode, setModeState] = useState<Mode>("global");
  /** The last map that arrived, and the repository it is of. Read through `root` below, so the
   *  render that switches repositories already shows the loading state: the previous repository's
   *  map used to stay on screen until the new one arrived (user report, 2026-10-11). Within one
   *  repository the old map stays while a new one loads, under the toolbar's spinner. */
  const [shown, setShown] = useState<{ root: string; graph: MapGraph; build: MapBuild } | null>(null);
  const [failure, setFailure] = useState<{ root: string; message: string } | null>(null);
  const graph = shown?.root === root ? shown.graph : null;
  const build = shown?.root === root ? shown.build : null;
  const error = failure?.root === root ? failure.message : null;
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** The node under the pointer. Its lines light up while it is there — on a map this dense, reading
   *  them should not cost a click (user's ask, 2026-10-10) — and the selection's come back after. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** A leave waits a moment before it un-lights: crossing the gap between two cards would otherwise
   *  flash the whole map bright for a frame. */
  const leaving = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(leaving.current), []);
  /** Whose lines are lit and whose neighbours stay bright: the hovered node, else the selected one. */
  const spotlit = hovered ?? selected;
  const [panel, setPanel] = useState<Panel>({ kind: "home" });
  const [query, setQuery] = useState("");
  const flow = useReactFlow();
  const requested = useRef(0);

  const setMode = (next: Mode) => {
    if (root) MODE.set(root, next);
    setSelected(null);
    setModeState(next);
  };

  // A different repository starts where it was last left.
  useEffect(() => {
    setFocus(root ? FOCUS.get(root) ?? "" : "");
    setModeState(root ? MODE.get(root) ?? "global" : "global");
    setSelected(null);
    setPanel({ kind: "home" });
    setQuery("");
  }, [root]);

  const load = useCallback(
    (target: string, view: Mode) => {
      if (!root) return;
      const ticket = ++requested.current;
      setLoading(true);
      (view === "global" ? codemapGlobal(root) : codemapGraph(root, target))
        .then(({ graph, build }) => {
          if (ticket !== requested.current) return;
          setShown({ root, graph, build });
          setFailure(null);
          if (view === "global") return;
          FOCUS.set(root, graph.focus);
          if (graph.focus !== target) setFocus(graph.focus);
        })
        .catch((e) => ticket === requested.current && setFailure({ root, message: String(e) }))
        .finally(() => ticket === requested.current && setLoading(false));
    },
    [root],
  );

  // Coming back to the tab re-reads the map — a lookup when nothing changed, the changed files when
  // something did.
  useEffect(() => {
    if (onScreen) load(focus, mode);
  }, [onScreen, focus, mode, load]);

  useEffect(() => {
    if (graph) requestAnimationFrame(() => flow.fitView({ padding: 0.2, maxZoom: 1, duration: 0 }));
    // A new graph replaces the nodes under the pointer without a mouse-leave for the old one.
    setHovered(null);
  }, [graph, flow]);

  const linked = useMemo(() => {
    const set = new Set<string>();
    if (!graph || !spotlit) return set;
    for (const edge of graph.edges) {
      if (edge.from === spotlit) set.add(edge.to);
      if (edge.to === spotlit) set.add(edge.from);
    }
    return set;
  }, [graph, spotlit]);

  // The global view is already sized by the backend to what a canvas can hold; the folder view caps
  // what it draws itself.
  const split = useMemo(
    () => (!graph ? { shown: [], hidden: [] } : mode === "global" ? { shown: graph.nodes, hidden: [] } : drawable(graph)),
    [graph, mode],
  );
  const colors = useMemo(() => (mode === "global" && graph ? groupColors(graph.nodes) : new Map<string, string>()), [graph, mode]);

  // The layout on its own, so a hover — which only changes what is lit — does not lay the map out again.
  const positions = useMemo(() => {
    if (!graph) return new Map<string, { x: number; y: number }>();
    const ids = new Set(split.shown.map((n) => n.id));
    return layoutMap(
      split.shown,
      graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      mode === "global" ? { maxRows: 18, maxColumns: 6, rootFirst: true } : {},
    );
  }, [graph, split, mode]);

  const nodes: CanvasNode[] = useMemo(() => {
    if (!graph) return [];
    return split.shown.map((node) => ({
      id: node.id,
      type: "map",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        node,
        color: colors.get(node.group),
        global: mode === "global",
      },
      draggable: false,
      connectable: false,
      // A size up front: with no onNodesChange the canvas never hands its measurements back, and
      // the minimap skips every node it has no size for — which left it blank.
      initialWidth: 220,
      initialHeight: 60,
    }));
  }, [graph, split, positions, colors, mode]);
  const spotlight = useMemo<Spotlight>(() => ({ selected, spotlit, linked }), [selected, spotlit, linked]);

  const edges: Edge[] = useMemo(() => {
    if (!graph) return [];
    const ids = new Set(split.shown.map((n) => n.id));
    return graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((edge) => {
      const lit = !!spotlit && (edge.from === spotlit || edge.to === spotlit);
      return {
        id: `${edge.from}→${edge.to}`,
        source: edge.from,
        target: edge.to,
        selectable: false,
        className: lit ? "cf-map-edge--lit" : spotlit ? "cf-map-edge--dim" : undefined,
        // Lit lines over the rest, or the bundle they cross hides them.
        zIndex: lit ? 1 : 0,
        style: { strokeWidth: Math.min(4, 1 + Math.log2(edge.weight)) },
      };
    });
  }, [graph, split, spotlit]);

  // Double click: a folder opens one level down (by folder, from the global view too); a file opens
  // in the editor — a single click already shows what it declares in the panel.
  const open = (node: MapNode) => {
    if (node.folder) {
      setSelected(null);
      setFocus(node.id);
      if (mode === "global") setMode("folders");
    } else {
      useUiStore.getState().openInEditor(node.id, 1);
    }
  };
  const hasFolders = !!graph?.nodes.some((node) => node.folder);
  const hint = mode === "folders" ? "codemap.hint" : hasFolders ? "codemap.hintGlobal" : "codemap.hintFiles";

  const crumbs = useMemo(() => {
    const parts = focus ? focus.split("/") : [];
    return parts.map((part, i) => ({ label: part, path: parts.slice(0, i + 1).join("/") }));
  }, [focus]);

  if (!project || !root) return null;

  /**
   * Has an engine read this repository and write one of archify's five diagrams of it, then files it
   * in Diagrams (`FORMAT_ARCHIFY`) — see `ai::archify_repository` for the run and `lib/diagrams/archify`
   * for the format.
   *
   * An architecture is one click: a map of the whole system is the question. The other four are about
   * *something* — which API call, which process, which data, which entity — because a sequence of "the
   * API" is a different diagram from the sequence of `POST /orders`; `topic` is that something, asked
   * by `ArchifyTopicDialog` (which offers the repository's own routes, statuses and so on) and empty
   * when the user left it to the engine, which then picks the repository's most important one. The
   * repository and its workspace are captured before anything is awaited: the run belongs to them
   * wherever the user goes while it reads.
   */
  const createDiagram = async (kind: ArchifyKind, topic = "") => {
    if (archifyRun) return;
    const target = { id: project.id, name: project.name, workspaceId: project.workspace_id };
    let instruction = t(`codemap.archify.default.${kind}`);
    if (topic.trim()) instruction = `${t("codemap.archify.focus")}: ${topic.trim()}. ${instruction}`;
    const runId = newRunId("archify");
    useAiRunStore.getState().start(runId, {
      kindKey: ARCHIFY_RUN_KIND,
      detail: target.name,
      workspaceId: target.workspaceId,
      target: { view: "codemap", projectId: target.id },
    });
    try {
      const raw = await diagramsArchifyProject({ projectId: target.id, kind, instruction, runId });
      const fallback = t(`codemap.archify.title.${kind}`, { project: target.name });
      const parsed = parseArchify(raw, fallback);
      if ("error" in parsed) throw new Error(t("codemap.archify.error"));
      // An architecture is named after the repository; the others after what the engine traced, under
      // the type — "API flow — POST /orders" says more than "API flow — my-repo".
      const named = parsed.ir.meta.title;
      const title =
        kind === "architecture" || !named || named === fallback
          ? fallback
          : `${t(`codemap.archify.kind.${kind}`)} — ${named}`;
      const ir = { ...parsed.ir, meta: { ...parsed.ir.meta, title } };
      const row = await diagramsCreateDiagram(
        target.workspaceId,
        null,
        title,
        storedDocument(ir),
        FORMAT_ARCHIFY,
        serializeTags(["archify", ir.diagram_type]),
      );
      // A tree already holding this workspace is told about the new row whether or not the diagram is
      // opened now; the notification below opens it by id, but the gallery lists what it has.
      const { useDiagramsStore } = await import("../../state/diagramsStore");
      if (useDiagramsStore.getState().workspaceId === target.workspaceId) await useDiagramsStore.getState().refresh();
      notify({
        source: "diagrams",
        titleKey: "notifications.archifyCreated",
        target: { view: "diagrams", select: { kind: "diagram", id: row.id } },
        status: "success",
        detail: title,
        workspaceId: target.workspaceId,
      });
      // Still looking at this repository's map: the answer is what they were waiting for, so it
      // opens. Anywhere else, the notification is the way to it — this does not pull anyone away.
      const workspace = useWorkspaceStore.getState();
      if (
        workspace.activeWorkspaceId === target.workspaceId &&
        workspace.activeProjectId === target.id &&
        useUiStore.getState().activeView === "codemap"
      ) {
        const { showDiagramAnywhere } = await import("../../lib/dbmlBridge");
        await showDiagramAnywhere(target.workspaceId, row.id);
        pushSuccessToast(t("codemap.archify.created"));
      }
    } catch (error) {
      if (!isCancellation(error)) pushErrorToast(String(error));
    } finally {
      useAiRunStore.getState().finish(runId);
    }
  };

  /** The five kinds, as the menu under the button lists them. */
  const diagramMenu = (): MenuItem[] =>
    (
      [
        ["architecture", Network],
        ["workflow", Workflow],
        ["sequence", ArrowRightLeft],
        ["dataflow", Waypoints],
        ["lifecycle", Repeat],
      ] as const
    ).map(([kind, icon]) => ({
      label: t(`codemap.archify.kind.${kind}`),
      icon,
      onClick: () => (kind === "architecture" ? void createDiagram(kind) : setTopicFor(kind)),
    }));

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <Segmented<Mode>
          size="sm"
          layoutId="cf-codemap-mode"
          value={mode}
          onChange={setMode}
          ariaLabel={t("codemap.mode")}
          options={[
            { value: "global", icon: Network, label: t("codemap.modeGlobal") },
            { value: "folders", icon: FolderTree, label: t("codemap.modeFolders") },
          ]}
        />
        <nav className="flex min-w-0 items-center gap-0.5 text-[12.5px]">
          <button type="button" onClick={() => setFocus("")} className="shrink-0 rounded px-1.5 py-0.5 font-medium text-[var(--cf-text)] hover:bg-[var(--cf-hover)]">
            {project.name}
          </button>
          {mode === "folders" && crumbs.map((crumb) => (
            <span key={crumb.path} className="flex min-w-0 items-center gap-0.5">
              <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
              <button
                type="button"
                onClick={() => setFocus(crumb.path)}
                className="min-w-0 truncate rounded px-1.5 py-0.5 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        {graph && (
          <Tooltip label={graph.languages.map(([lang, n]) => `${lang}: ${n}`).join(" · ")}>
            <span className={chipClass("neutral", "tabular-nums")}>
              {t("codemap.stats", { files: formatCount(graph.files), symbols: formatCount(graph.symbols) })}
            </span>
          </Tooltip>
        )}
        {loading && <LoaderCircle size={13} className="animate-spin text-[var(--cf-text-muted)]" />}
        <span className="flex-1" />
        <form
          className="relative w-[260px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) setPanel({ kind: "search", query: query.trim() });
          }}
        >
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value.trim().length >= 2) setPanel({ kind: "search", query: e.target.value.trim() });
              else if (!e.target.value.trim()) setPanel({ kind: "home" });
            }}
            placeholder={t("codemap.searchPlaceholder")}
            className={fieldClass({ size: "sm", className: "w-full pl-7" })}
          />
        </form>
        <Tooltip label={t("codemap.refresh")}>
          <button type="button" onClick={() => load(focus, mode)} className={iconButtonClass({ size: "sm" })} aria-label={t("codemap.refresh")}>
            <RefreshCw size={13} />
          </button>
        </Tooltip>
        <ChatModelPicker
          task="diagram"
          variant="tag"
          liveModel={null}
          chatActive={false}
          title={t("codemap.archify.modelHint")}
        />
        {archifyRun ? (
          <>
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
              <ThinkingOrb size="sm" />
              {t("codemap.archify.running")}
            </span>
            <Tooltip label={t("codemap.archify.stop")}>
              <button
                type="button"
                onClick={() => void useAiRunStore.getState().cancel(archifyRun)}
                className={iconButtonClass({ size: "sm" })}
                aria-label={t("codemap.archify.stop")}
              >
                <X size={13} />
              </button>
            </Tooltip>
          </>
        ) : (
          <Tooltip label={t("codemap.archify.hint")}>
            <button
              type="button"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setDiagramMenuAt({ x: box.left, y: box.bottom + 4 });
              }}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              <AiSparkles size={13} />
              {t("codemap.archify.action")}
            </button>
          </Tooltip>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {error ? (
            <p className="p-4 text-[12.5px] text-[var(--cf-danger)]">{error}</p>
          ) : !graph ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-[var(--cf-text-muted)]">
              <LoaderCircle size={14} className="animate-spin" />
              {t("codemap.building")}
            </div>
          ) : graph.nodes.length === 0 ? (
            <p className="p-4 text-[12.5px] text-[var(--cf-text-muted)]">{t("codemap.empty")}</p>
          ) : (
            <SpotlightContext.Provider value={spotlight}>
              <ReactFlow<CanvasNode, Edge>
                className="cf-map-canvas"
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                onNodeClick={(_, node) => {
                  setSelected(node.id === selected ? null : node.id);
                  if (!node.data.node.folder) setPanel({ kind: "file", path: node.id });
                }}
                onNodeDoubleClick={(_, node) => open(node.data.node)}
                onNodeMouseEnter={(_, node) => {
                  window.clearTimeout(leaving.current);
                  setHovered(node.id);
                }}
                onNodeMouseLeave={() => {
                  window.clearTimeout(leaving.current);
                  leaving.current = window.setTimeout(() => setHovered(null), 80);
                }}
                onPaneClick={() => setSelected(null)}
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                minZoom={0.15}
                maxZoom={2}
                zoomOnDoubleClick={false}
                deleteKeyCode={null}
                panActivationKeyCode={null}
                selectionKeyCode={null}
                multiSelectionKeyCode={null}
                zoomActivationKeyCode={null}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} />
                {split.shown.length >= MINIMAP_FROM && (
                  <MiniMap<CanvasNode>
                    className="cf-map-minimap"
                    pannable
                    zoomable
                    nodeBorderRadius={6}
                    nodeColor={(node) => node.data.color ?? (node.data.node.folder ? "var(--cf-accent)" : "var(--cf-border-strong)")}
                    ariaLabel={t("codemap.minimap")}
                  />
                )}
              </ReactFlow>
            </SpotlightContext.Provider>
          )}
          {build && graph && (
            <div className="pointer-events-none absolute bottom-2 left-3 flex flex-col gap-1">
              {mode === "global" && colors.size > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--cf-text-muted)]">
                  {[...colors.entries()].map(([group, color]) => (
                    <span key={group} className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                      {group}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-[var(--cf-text-faint)]">{t(hint)}</p>
            </div>
          )}
          {split.hidden.length > 0 && (
            <button
              type="button"
              onClick={() => setPanel({ kind: "rest" })}
              className={chipClass("neutral", "absolute right-3 top-3 h-6 cursor-pointer hover:text-[var(--cf-text)]")}
            >
              {t("codemap.moreFiles", { n: split.hidden.length })}
            </button>
          )}
        </div>

        <aside className="flex w-[320px] shrink-0 flex-col border-l border-[var(--cf-border)]">
          <SidePanel
            root={root}
            panel={panel}
            graph={graph}
            selected={selected}
            onPanel={setPanel}
            hidden={split.hidden}
            onOpenFolder={(path) => setFocus(path)}
            onClear={() => {
              setQuery("");
              setPanel({ kind: "home" });
            }}
          />
        </aside>
      </div>
      {diagramMenuAt && (
        <ContextMenu x={diagramMenuAt.x} y={diagramMenuAt.y} items={diagramMenu()} onClose={() => setDiagramMenuAt(null)} />
      )}
      {topicFor && (
        <ArchifyTopicDialog
          kind={topicFor}
          projectId={project.id}
          onClose={() => setTopicFor(null)}
          onStart={(topic) => {
            const kind = topicFor;
            setTopicFor(null);
            void createDiagram(kind, topic);
          }}
        />
      )}
    </div>
  );
}

function SidePanel({
  root,
  panel,
  graph,
  selected,
  hidden,
  onPanel,
  onOpenFolder,
  onClear,
}: {
  root: string;
  panel: Panel;
  graph: MapGraph | null;
  selected: string | null;
  hidden: MapNode[];
  onPanel: (panel: Panel) => void;
  onOpenFolder: (path: string) => void;
  onClear: () => void;
}) {
  const t = useT();
  const folder = graph?.nodes.find((n) => n.id === selected && n.folder);
  if (panel.kind === "file") return <FilePanel root={root} path={panel.path} highlight={panel.highlight} onPanel={onPanel} onBack={onClear} />;
  if (panel.kind === "search") return <SearchPanel root={root} query={panel.query} onPanel={onPanel} onBack={onClear} />;
  if (panel.kind === "usages") return <UsagesPanel root={root} name={panel.name} path={panel.path} onPanel={onPanel} onBack={onClear} />;
  if (panel.kind === "health") return <HealthPanel root={root} list={panel.list} onPanel={onPanel} onBack={onClear} />;
  if (panel.kind === "rest") {
    return (
      <>
        <PanelHeader title={t("codemap.moreFiles", { n: hidden.length })} onBack={onClear} />
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {hidden.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => (node.folder ? onOpenFolder(node.id) : onPanel({ kind: "file", path: node.id }))}
              className={rowClass(false, "h-7")}
            >
              {node.folder ? <Folder size={12} className="shrink-0 text-[var(--cf-accent)]" /> : <FileCode2 size={12} className="shrink-0 text-[var(--cf-text-muted)]" />}
              <span className="min-w-0 truncate font-mono text-[11.5px]">{node.label}</span>
              {node.importedBy > 0 && (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
                  <Users size={10} />
                  {node.importedBy}
                </span>
              )}
            </button>
          ))}
        </div>
      </>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {folder && (
        <div className="border-b border-[var(--cf-border)] px-1.5 pb-3 pt-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--cf-text)]">
            <Folder size={14} className="text-[var(--cf-accent)]" />
            <span className="min-w-0 truncate">{folder.id}</span>
          </div>
          <p className="mt-1 text-[12px] text-[var(--cf-text-muted)]">
            {t("codemap.folderMeta", { files: formatCount(folder.files), symbols: formatCount(folder.symbols) })}
          </p>
          <button type="button" onClick={() => onOpenFolder(folder.id)} className="mt-2 text-[12.5px] text-[var(--cf-accent)] hover:underline">
            {t("codemap.openFolder")}
          </button>
        </div>
      )}
      <HealthSection root={root} onPanel={onPanel} />
      <KeySymbols root={root} onPanel={onPanel} />
    </div>
  );
}

const HEALTH_LISTS: { list: HealthList; icon: typeof Users; label: "codemap.health.orphans" | "codemap.health.mostUsed" | "codemap.health.mostDependent" }[] = [
  { list: "orphans", icon: FileQuestion, label: "codemap.health.orphans" },
  { list: "mostUsed", icon: Users, label: "codemap.health.mostUsed" },
  { list: "mostDependent", icon: GitFork, label: "codemap.health.mostDependent" },
];

/** The import graph's three questions, each a row that opens its list: what nothing imports, what
 *  the most depend on, what depends on the most. */
function HealthSection({ root, onPanel }: { root: string; onPanel: (panel: Panel) => void }) {
  const t = useT();
  const { data } = useAsync(() => codemapHealth(root), [root]);
  return (
    <>
      <div className={sectionLabelClass}>{t("codemap.health.title")}</div>
      {HEALTH_LISTS.map(({ list, icon: Icon, label }) => (
        <button key={list} type="button" onClick={() => onPanel({ kind: "health", list })} className={rowClass(false, "h-7")}>
          <Icon size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 truncate text-[12.5px]">{t(label)}</span>
          {data && list === "orphans" && <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">{data.orphans.length}</span>}
        </button>
      ))}
    </>
  );
}

function HealthPanel({ root, list, onPanel, onBack }: { root: string; list: HealthList; onPanel: (panel: Panel) => void; onBack: () => void }) {
  const t = useT();
  const { data, error } = useAsync(() => codemapHealth(root), [root]);
  const rows: FileStanding[] = !data ? [] : list === "orphans" ? data.orphans : list === "mostUsed" ? data.mostUsed : data.mostDependent;
  const entry = HEALTH_LISTS.find((item) => item.list === list)!;
  return (
    <>
      <PanelHeader title={t(entry.label)} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? (
          <p className="px-1.5 py-2 text-[12px] text-[var(--cf-danger)]">{error}</p>
        ) : !data ? (
          <Loading />
        ) : (
          <>
            <p className="px-1.5 pb-1 pt-2 text-[11.5px] text-[var(--cf-text-faint)]">
              {list === "orphans" ? t("codemap.health.orphansHint", { n: formatCount(data.checked) }) : t(list === "mostUsed" ? "codemap.health.mostUsedHint" : "codemap.health.mostDependentHint")}
            </p>
            {rows.length === 0 && <p className="px-1.5 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("codemap.health.none")}</p>}
            {rows.map((row) => (
              <button
                key={row.path}
                type="button"
                onClick={() => onPanel({ kind: "file", path: row.path })}
                className={rowClass(false, "min-h-[40px] flex-col items-start gap-0.5 py-1.5")}
              >
                <span className="w-full min-w-0 truncate font-mono text-[11.5px]">{row.path}</span>
                <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                  {list === "orphans"
                    ? t("codemap.health.orphanMeta", { lines: formatCount(row.lines), symbols: formatCount(row.symbols) })
                    : t("codemap.health.fanMeta", { fanIn: formatCount(row.fanIn), fanOut: formatCount(row.fanOut) })}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const t = useT();
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-3 pr-1.5">
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--cf-text)]">{title}</span>
      <Tooltip label={t("common.close")}>
        <button type="button" onClick={onBack} className={iconButtonClass({ size: "sm" })} aria-label={t("common.close")}>
          <X size={13} />
        </button>
      </Tooltip>
    </div>
  );
}

function openAt(path: string, line: number) {
  useUiStore.getState().openInEditor(path, line);
}

function SymbolRow({ hit, onPanel }: { hit: SymbolHit; onPanel: (panel: Panel) => void }) {
  const t = useT();
  return (
    <div className="group flex items-center">
      <button
        type="button"
        onClick={() => onPanel({ kind: "file", path: hit.path, highlight: hit.start })}
        className={rowClass(false, "min-h-[44px] flex-col items-start gap-0.5 py-1.5")}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-[12.5px]">{hit.parent ? `${hit.parent}.${hit.name}` : hit.name}</span>
          <span className="shrink-0 text-[10.5px] text-[var(--cf-text-faint)]">{kindWord(t, hit.kind)}</span>
          {hit.usedBy > 0 && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
              <Users size={10} />
              {hit.usedBy}
            </span>
          )}
        </span>
        <span className="w-full truncate text-[11px] text-[var(--cf-text-muted)]">
          {hit.path}:{hit.start}
        </span>
      </button>
      <Tooltip label={t("codemap.showUsages")}>
        <button
          type="button"
          onClick={() => onPanel({ kind: "usages", name: hit.name, path: hit.path })}
          className={iconButtonClass({ size: "sm", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })}
          aria-label={t("codemap.showUsages")}
        >
          <Users size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const PENDING: Async<never> = { data: null, error: null, loading: true };

/** `run`'s result for these `deps`. The answer is kept with the deps it was for, so the render where
 *  they change — another repository, another file — is already loading rather than the previous
 *  answer for one frame until the effect clears it. */
function useAsync<T>(run: () => Promise<T>, deps: unknown[]): Async<T> {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<Async<T> & { key: string | null }>({ ...PENDING, key: null });
  useEffect(() => {
    let live = true;
    run()
      .then((data) => live && setState({ data, error: null, loading: false, key }))
      .catch((e) => live && setState({ data: null, error: String(e), loading: false, key }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state.key === key ? state : PENDING;
}

function Loading() {
  return (
    <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">
      <LoaderCircle size={13} className="animate-spin" />
    </div>
  );
}

function KeySymbols({ root, onPanel }: { root: string; onPanel: (panel: Panel) => void }) {
  const t = useT();
  const { data } = useAsync(() => codemapKeySymbols(root), [root]);
  return (
    <>
      <div className={sectionLabelClass}>{t("codemap.keySymbols")}</div>
      {!data ? <Loading /> : data.map((hit) => <SymbolRow key={`${hit.path}:${hit.start}`} hit={hit} onPanel={onPanel} />)}
    </>
  );
}

function SearchPanel({ root, query, onPanel, onBack }: { root: string; query: string; onPanel: (panel: Panel) => void; onBack: () => void }) {
  const t = useT();
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 180);
    return () => window.clearTimeout(timer);
  }, [query]);
  const { data, error } = useAsync(() => codemapFind(root, debounced), [root, debounced]);
  return (
    <>
      <PanelHeader title={t("codemap.searchTitle", { query })} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {error ? (
          <p className="px-1.5 py-2 text-[12px] text-[var(--cf-danger)]">{error}</p>
        ) : !data ? (
          <Loading />
        ) : data.length === 0 ? (
          <p className="px-1.5 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("codemap.noResults")}</p>
        ) : (
          data.map((hit) => <SymbolRow key={`${hit.path}:${hit.start}`} hit={hit} onPanel={onPanel} />)
        )}
      </div>
    </>
  );
}

function PathList({ label, paths, onPanel }: { label: string; paths: string[]; onPanel: (panel: Panel) => void }) {
  if (paths.length === 0) return null;
  return (
    <>
      <div className={sectionLabelClass}>
        {label} <span className="font-normal tabular-nums">{paths.length}</span>
      </div>
      {paths.map((path) => (
        <button key={path} type="button" onClick={() => onPanel({ kind: "file", path })} className={rowClass(false, "h-7 font-mono text-[11.5px]")}>
          <span className="min-w-0 truncate">{path}</span>
        </button>
      ))}
    </>
  );
}

function FilePanel({
  root,
  path,
  highlight,
  onPanel,
  onBack,
}: {
  root: string;
  path: string;
  highlight?: number;
  onPanel: (panel: Panel) => void;
  onBack: () => void;
}) {
  const t = useT();
  const { data, error, loading } = useAsync<FileOutline | null>(() => codemapOutline(root, path), [root, path]);
  const name = path.split("/").pop() ?? path;
  return (
    <>
      <PanelHeader title={name} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <button type="button" onClick={() => openAt(path, 1)} className="mt-2 w-full truncate px-1.5 text-left font-mono text-[11.5px] text-[var(--cf-accent)] hover:underline">
          {path}
        </button>
        {error ? (
          <p className="px-1.5 py-2 text-[12px] text-[var(--cf-danger)]">{error}</p>
        ) : loading ? (
          <Loading />
        ) : !data ? (
          <p className="px-1.5 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("codemap.notCode")}</p>
        ) : (
          <>
            <p className="px-1.5 pt-1 text-[11.5px] text-[var(--cf-text-muted)]">{t("codemap.fileMeta", { lang: data.lang, lines: formatCount(data.lines) })}</p>
            <div className={sectionLabelClass}>{t("codemap.declares")}</div>
            {data.symbols.length === 0 && <p className="px-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("codemap.noSymbols")}</p>}
            {data.symbols.map((symbol) => (
              <div key={`${symbol.start}-${symbol.name}`} className="group flex items-center" style={{ paddingLeft: symbol.depth * 12 }}>
                <button
                  type="button"
                  onClick={() => openAt(path, symbol.start)}
                  className={rowClass(symbol.start === highlight, "h-7 min-w-0 flex-1")}
                  title={symbol.label}
                >
                  <span className="min-w-0 truncate font-mono text-[12px]">{symbol.name}</span>
                  <span className="shrink-0 text-[10.5px] text-[var(--cf-text-faint)]">{kindWord(t, symbol.kind)}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-faint)]">{symbol.start}</span>
                </button>
                <Tooltip label={t("codemap.showUsages")}>
                  <button
                    type="button"
                    onClick={() => onPanel({ kind: "usages", name: symbol.name, path })}
                    className={iconButtonClass({ size: "sm", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })}
                    aria-label={t("codemap.showUsages")}
                  >
                    <Users size={12} />
                  </button>
                </Tooltip>
              </div>
            ))}
            <PathList label={t("codemap.imports")} paths={data.imports} onPanel={onPanel} />
            <PathList label={t("codemap.importedBy")} paths={data.importedBy} onPanel={onPanel} />
            {data.external.length > 0 && (
              <>
                <div className={sectionLabelClass}>{t("codemap.external")}</div>
                <div className="flex flex-wrap gap-1 px-1.5">
                  {data.external.map((spec) => (
                    <span key={spec} className={chipClass("neutral", "font-mono")}>
                      {spec}
                    </span>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function UsagesPanel({
  root,
  name,
  path,
  onPanel,
  onBack,
}: {
  root: string;
  name: string;
  path: string | null;
  onPanel: (panel: Panel) => void;
  onBack: () => void;
}) {
  const t = useT();
  const { data, error } = useAsync<UsageReport>(() => codemapUsages(root, name, path), [root, name, path]);
  return (
    <>
      <PanelHeader title={t("codemap.usagesTitle", { name })} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? (
          <p className="px-1.5 py-2 text-[12px] text-[var(--cf-danger)]">{error}</p>
        ) : !data ? (
          <Loading />
        ) : (
          <>
            {data.declarations.map((hit) => (
              <SymbolRow key={`d-${hit.path}:${hit.start}`} hit={hit} onPanel={onPanel} />
            ))}
            <div className={sectionLabelClass}>
              {t("codemap.usages")} <span className="font-normal tabular-nums">{data.usages.length}</span>
            </div>
            {data.usages.length === 0 && <p className="px-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("codemap.usagesNone")}</p>}
            {data.usages.map((usage) => (
              <button
                key={usage.path}
                type="button"
                onClick={() => openAt(usage.path, usage.line)}
                className={rowClass(false, "min-h-[40px] flex-col items-start gap-0.5 py-1.5")}
              >
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono text-[11.5px]">
                    {usage.path}:{usage.line}
                  </span>
                  {!usage.confirmed && <span className={chipClass("neutral", "ml-auto")}>{t("codemap.byName")}</span>}
                </span>
                {usage.signature && <span className="w-full truncate text-[11px] text-[var(--cf-text-muted)]">{usage.signature}</span>}
              </button>
            ))}
            {data.ruledOut > 0 && (
              <p className="px-1.5 pt-2 text-[11.5px] text-[var(--cf-text-faint)]">{t("codemap.ruledOut", { n: data.ruledOut, name })}</p>
            )}
          </>
        )}
      </div>
    </>
  );
}
