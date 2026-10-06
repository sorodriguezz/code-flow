import "@xyflow/react/dist/style.css";
import "./flows.css";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import { ChevronDown, ClipboardPaste, Copy, CopyPlus, Globe, History, KeyRound, Network, Palette, PanelTop, Pencil, Pin, PinOff, Play, Plus, Power, Redo2, Scan, Scissors, ScrollText, Settings2, ShieldAlert, Square, StepForward, StickyNote, Trash2, Undo2, Users, ZoomIn, ZoomOut } from "lucide-react";
import { AiWand } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Button, iconButtonClass } from "../common/Button";
import { Segmented } from "../common/Segmented";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { VersionHistoryModal } from "../common/VersionHistoryModal";
import { toolbarClass } from "../common/recipes";
import {
  CanvasActionsContext,
  FlowEdgeView,
  FlowNodeView,
  NoteNodeView,
  type CanvasActions,
  type CfNode,
  type FlowCanvasNode,
  type NoteNode,
} from "./FlowNodes";
import { NodePalette } from "./NodePalette";
import { FlowAiPanel } from "./FlowAiPanel";
import { FlowShareDialog, ShareConflictDialog } from "./FlowShareDialog";
import { useFlowShareStore } from "../../state/flowShareStore";
import { FlowSettingsDialog } from "./FlowSettingsDialog";
import { ExecutionsView } from "./ExecutionsView";
import { RunLog } from "./RunLog";
import { NODE_STATUS_KEY, formatDuration, itemsLabel, nodeTime } from "./runFormat";
import {
  addNode,
  addNote,
  autoLayout,
  colorNotes,
  connect,
  connectionKey,
  connectionProblem,
  hasErrorOutput,
  outputCount,
  copyFragment,
  moveElements,
  noteColor,
  parseSpec,
  pasteFragment,
  removeElements,
  renameNode,
  setNodeDisabled,
  updateNote,
  type FlowConnection,
  type FlowFragment,
  type FlowSpec,
} from "../../lib/flows/spec";
import {
  flowsClearVersions,
  flowsDeleteVersion,
  flowsListVersions,
  flowsVersionContent,
  type FlowNodeDescriptor,
} from "../../lib/tauri/flowsCommands";
import { diffSpecs } from "../../lib/flows/diff";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useFlowVaultStore } from "../../state/flowVaultStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast } from "../../state/toastStore";
import { useUiStore } from "../../state/uiStore";

const NODE_TYPES: NodeTypes = { cf: FlowNodeView, note: NoteNodeView };
const EDGE_TYPES: EdgeTypes = { cf: FlowEdgeView };

/**
 * React Flow's keys, all off while Flujos is not on screen — these four, and `deleteKeyCode`, which
 * its own prop switches off.
 *
 * It listens for them on `window` and `document`, not on its pane, and this view stays mounted while
 * hidden — so a canvas nobody could see still answered the keyboard everywhere else in the app.
 * Backspace pressed outside a text field in another view deleted the nodes left selected here, and
 * Space-to-pan swallowed the spaces typed into any editable it did not recognise as a field.
 */
const KEYS_OFF_SCREEN = {
  panActivationKeyCode: null,
  selectionKeyCode: null,
  multiSelectionKeyCode: null,
  zoomActivationKeyCode: null,
} as const;

/** The node inspector and its form arrive the first time a node is opened. */
const NodeInspector = lazy(() => import("./NodeInspector"));

/** Statuses after which a node's output counts are real. */
const HAS_OUTPUT = new Set(["success", "error", "pinned", "reused", "disabled"]);

/** How far a paste lands from what was copied, per paste — so three pastes are three visible copies
 *  rather than one stack. */
const PASTE_STEP = 40;

/** What was last copied, across flows. The system clipboard gets a JSON copy too, for pasting into a
 *  note or a message; the canvas never reads it back — on macOS that read puts a native "Paste"
 *  prompt on screen, which is not what ⌘V on a canvas should do. */
let clipboard: { fragment: FlowFragment; pastes: number } | null = null;

/** A descriptor for a type this build does not know — a row Rust would refuse, so only reachable
 *  from a hand-edited database. Drawn plain, rather than left out, so it can be seen and deleted. */
const unknownDescriptor = (typeId: string): FlowNodeDescriptor => ({
  typeId,
  family: "logic",
  icon: "box",
  inputs: 1,
  outputs: 1,
  inputLabels: [],
  outputLabels: [],
  milestone: 1,
  params: [],
});

/** Port names: a digit or a letter is shown as itself, a word through the translations. */
const portLabel = (label: string, t: ReturnType<typeof useT>) =>
  /^[0-9A-Z]$/.test(label) ? label : t(`flows.port.${label}` as TranslationKey);

/** A selection with React Flow's select changes applied — the same set back when nothing moved. */
function applySelects(before: Set<string>, selects: { id: string; selected: boolean }[]): Set<string> {
  const next = new Set(before);
  for (const { id, selected } of selects) {
    if (selected) next.add(id);
    else next.delete(id);
  }
  const same = next.size === before.size && [...next].every((id) => before.has(id));
  return same ? before : next;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The canvas of the open flow. Lazy: this module is the only one that imports @xyflow/react, so the
 * library arrives the first time a flow is opened rather than with the app.
 */
export function FlowEditor() {
  const draftId = useFlowsStore((s) => s.draft?.id ?? null);
  if (!draftId) return null;
  // Keyed by the flow, so selection, measurements and the viewport start over with each one.
  return (
    <ReactFlowProvider key={draftId}>
      <Editor />
    </ReactFlowProvider>
  );
}

function Editor() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const spec = useFlowsStore((s) => s.draft?.spec ?? null);
  const draftId = useFlowsStore((s) => s.draft?.id ?? "");
  const dirty = useFlowsStore((s) => s.draft?.dirty ?? false);
  const saving = useFlowsStore((s) => s.saving);
  const savedAt = useFlowsStore((s) => s.savedAt);
  const catalog = useFlowsStore((s) => s.catalog);
  const catalogMap = useFlowsStore((s) => s.catalogMap);
  const meta = useFlowsStore((s) => s.flows.find((flow) => flow.id === s.draft?.id) ?? null);
  const canUndo = useFlowsStore((s) => s.past.length > 0);
  const canRedo = useFlowsStore((s) => s.future.length > 0);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const live = useFlowRunsStore((s) => s.current[draftId]);
  const pins = useFlowRunsStore((s) => s.pins[draftId]);
  const openWaits = useFlowRunsStore((s) => s.waits);
  // The nodes of the run on screen that are parked waiting for someone.
  const waitingNodes = useMemo(
    () => new Set(openWaits.filter((wait) => wait.runId === live?.run.id).map((wait) => wait.nodeId)),
    [openWaits, live?.run.id],
  );
  const inspector = useFlowRunsStore((s) => s.inspector);
  // `activeView` is "flows" in a detached Flujos window too — `AppWindow` writes it there.
  const onScreen = useUiStore((s) => s.activeView === "flows");
  const logOpen = useFlowRunsStore((s) => s.logOpen);
  const pane = useFlowRunsStore((s) => s.pane);
  const running = live?.run.status === "running";
  const [now, setNow] = useState(Date.now());
  // The AI builder: its window, and a proposal drawn over the canvas as changes until answered.
  const aiRun = useFlowsStore((s) => s.aiByFlow[draftId]);
  const [aiOpen, setAiOpen] = useState(false);
  const share = useFlowShareStore((s) => s.shares[draftId]);
  const [shareDialog, setShareDialog] = useState<"share" | "conflict" | null>(null);
  const proposal = aiRun?.status === "ready" ? aiRun.proposal : null;
  const diff = useMemo(() => (spec && proposal ? diffSpecs(spec, proposal.spec) : null), [spec, proposal]);
  const shown = diff?.shown ?? spec;

  // What this flow ran last, painted on the canvas; and its pins.
  useEffect(() => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (draftId && workspaceId) void useFlowRunsStore.getState().loadFlow(draftId, workspaceId);
    useFlowRunsStore.getState().openInspector(null);
  }, [draftId]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [edgeSelection, setEdgeSelection] = useState<Set<string>>(() => new Set());
  /** The note whose palette is open — see `CanvasActions.noteColorFor`. */
  const [noteColorFor, setNoteColorFor] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const edgeSelectionRef = useRef(edgeSelection);
  edgeSelectionRef.current = edgeSelection;
  const measured = useRef(new Map<string, { width: number; height: number }>());
  const [measureTick, setMeasureTick] = useState(0);
  const palette = useFlowsStore((s) => s.palette);
  const setPalette = useFlowsStore((s) => s.setPalette);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const edit = useCallback((next: FlowSpec | null, history = true) => {
    if (next) useFlowsStore.getState().edit(next, { history });
  }, []);
  const current = () => useFlowsStore.getState().draft?.spec ?? null;

  // ---------- nodes and edges, derived from the document ----------

  /** Per-id cache, so an element whose document entry, selection and measurement did not change
   *  keeps its object — which is what lets React Flow skip re-adopting it on every drag frame. */
  const nodeCache = useRef(new Map<string, { key: unknown[]; node: FlowCanvasNode }>());
  const nodes = useMemo<FlowCanvasNode[]>(() => {
    if (!shown) return [];
    const next = new Map<string, { key: unknown[]; node: FlowCanvasNode }>();
    const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
    const out: FlowCanvasNode[] = [];
    for (const item of shown.nodes) {
      const selected = selection.has(item.id);
      const size = measured.current.get(item.id);
      const descriptor = catalogMap.get(item.type);
      // A proposal on screen is not what the last run ran: no run marks over it.
      const record = diff ? undefined : live?.nodes[item.id];
      const pinned = pins?.[item.id] !== undefined;
      const waiting = waitingNodes.has(item.id);
      const mark = diff?.nodes.get(item.id);
      // Only a running node's clock moves; every other node keeps its cached object.
      const time = record ? nodeTime(record, now) : "";
      const key = [item, selected, size, descriptor, language, record, pinned, waiting, mark, time];
      const cached = nodeCache.current.get(item.id);
      if (cached && same(cached.key, key)) {
        out.push(cached.node);
        next.set(item.id, cached);
        continue;
      }
      const d = descriptor ?? unknownDescriptor(item.type);
      const node: CfNode = {
        id: item.id,
        type: "cf",
        position: { x: item.pos[0], y: item.pos[1] },
        selected,
        measured: size,
        data: {
          descriptor: d,
          name: item.name,
          typeLabel: descriptor ? t(`flows.node.${item.type}` as TranslationKey) : item.type,
          disabled: item.disabled === true,
          inputLabels: d.inputLabels.map((label) => portLabel(label, t)),
          outputLabels: [
            ...d.outputLabels.map((label) => portLabel(label, t)),
            ...(hasErrorOutput(item, descriptor)
              ? [...Array.from({ length: d.outputLabels.length === 0 ? d.outputs : 0 }, () => ""), t("flows.port.error")]
              : []),
          ],
          outputs: outputCount(item, descriptor),
          errorPort: hasErrorOutput(item, descriptor),
          run: record
            ? {
                status: record.status,
                error: record.error,
                waiting,
                title: waiting
                  ? t("flows.status.waiting")
                  : record.error
                  ? `${t(NODE_STATUS_KEY[record.status])}: ${record.error}`
                  : `${t(NODE_STATUS_KEY[record.status])}${HAS_OUTPUT.has(record.status) ? ` · ${itemsLabel(t, record.itemsOut.reduce((a, b) => a + b, 0))}` : ""}${
                      record.durationMs !== null ? ` · ${formatDuration(record.durationMs)}` : ""
                    }`,
              }
            : null,
          time,
          pinned,
          pinnedTitle: t("flows.inspector.pinned"),
          diff: mark,
          diffTitle: mark ? t(`flows.builder.${mark}` as TranslationKey) : "",
        },
      };
      out.push(node);
      next.set(item.id, { key, node });
    }
    for (const note of shown.notes) {
      const selected = selection.has(note.id);
      const size = measured.current.get(note.id);
      const key = [note, selected, size, language, !!diff];
      const cached = nodeCache.current.get(note.id);
      if (cached && same(cached.key, key)) {
        out.push(cached.node);
        next.set(note.id, cached);
        continue;
      }
      const node: NoteNode = {
        id: note.id,
        type: "note",
        position: { x: note.pos[0], y: note.pos[1] },
        width: note.size[0],
        height: note.size[1],
        selected,
        measured: size,
        // Under the nodes: a note annotates the flow, it must never sit on top of a port.
        zIndex: -1,
        data: { text: note.text, placeholder: t("flows.notePlaceholder"), color: noteColor(note), locked: !!diff },
      };
      out.push(node);
      next.set(note.id, { key, node });
    }
    nodeCache.current = next;
    return out;
    // `measureTick` is the signal that `measured` (a ref) changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, diff, selection, measureTick, catalogMap, language, t, live, pins, waitingNodes, now]);

  const edges = useMemo<Edge[]>(
    () =>
      (shown?.connections ?? []).map((c) => {
        const id = connectionKey(c);
        const record = diff ? undefined : live?.nodes[c.from];
        const count = record && HAS_OUTPUT.has(record.status) ? record.itemsOut[c.out] : undefined;
        const source = shown?.nodes.find((n) => n.id === c.from);
        const mark = diff?.connections.get(id);
        const descriptor = source ? catalogMap.get(source.type) : undefined;
        const fromErrorPort = !!source && hasErrorOutput(source, descriptor) && c.out === (descriptor?.outputs ?? 0);
        return {
          id,
          type: "cf",
          source: c.from,
          sourceHandle: `o${c.out}`,
          target: c.to,
          targetHandle: `i${c.in}`,
          selected: edgeSelection.has(id),
          // A proposal is answered from the builder's window, not edited on the canvas.
          deletable: !diff,
          label: count !== undefined && count > 0 ? itemsLabel(t, count) : undefined,
          labelBgPadding: [5, 2] as [number, number],
          labelBgBorderRadius: 4,
          className: `${count ? "has-items" : ""} ${fromErrorPort ? "is-error-edge" : ""} ${mark ? `is-diff-${mark}` : ""}`,
        };
      }),
    [shown, diff, edgeSelection, live, catalogMap, t],
  );

  // A proposal arriving is looked at whole.
  useEffect(() => {
    if (diff) requestAnimationFrame(() => void fitView({ padding: 0.25, maxZoom: 1, duration: 200 }));
    // Once per proposal, not per render of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal]);

  // ---------- React Flow's changes, written back into the document ----------

  const onNodesChange = useCallback((changes: NodeChange<FlowCanvasNode>[]) => {
    const doc = current();
    if (!doc) return;
    const notes = new Set(doc.notes.map((n) => n.id));
    const positions = new Map<string, [number, number]>();
    const sizes = new Map<string, [number, number]>();
    const removeNodes: string[] = [];
    const removeNotes: string[] = [];
    const selects: { id: string; selected: boolean }[] = [];
    let remeasured = false;
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        positions.set(change.id, [Math.round(change.position.x), Math.round(change.position.y)]);
      } else if (change.type === "dimensions" && change.dimensions) {
        const before = measured.current.get(change.id);
        if (!before || before.width !== change.dimensions.width || before.height !== change.dimensions.height) {
          measured.current.set(change.id, { width: change.dimensions.width, height: change.dimensions.height });
          remeasured = true;
        }
        if (change.resizing !== undefined && notes.has(change.id)) {
          sizes.set(change.id, [Math.round(change.dimensions.width), Math.round(change.dimensions.height)]);
        }
      } else if (change.type === "select") {
        selects.push({ id: change.id, selected: change.selected });
      } else if (change.type === "remove") {
        (notes.has(change.id) ? removeNotes : removeNodes).push(change.id);
      }
    }
    let next = doc;
    if (positions.size) next = moveElements(next, positions);
    for (const [id, size] of sizes) next = updateNote(next, id, { size });
    // Frames of a gesture: its undo step was recorded when it started (`checkpoint`).
    if (next !== doc) useFlowsStore.getState().edit(next, { history: false });
    if (removeNodes.length || removeNotes.length) {
      const after = current();
      if (after) useFlowsStore.getState().edit(removeElements(after, { nodes: removeNodes, notes: removeNotes }));
    }
    if (remeasured) setMeasureTick((tick) => tick + 1);
    // Applied to the latest selection rather than to the one the last render saw: a click can land
    // in the same tick as a programmatic `select` (a node just added), and a set computed from a
    // stale ref would quietly put the old selection back.
    if (selects.length) setSelection((before) => applySelects(before, selects));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed: string[] = [];
    const selects: { id: string; selected: boolean }[] = [];
    for (const change of changes) {
      if (change.type === "select") selects.push({ id: change.id, selected: change.selected });
      else if (change.type === "remove") removed.push(change.id);
    }
    const doc = current();
    if (removed.length && doc) useFlowsStore.getState().edit(removeElements(doc, { connections: removed }));
    if (selects.length) setEdgeSelection((before) => applySelects(before, selects));
  }, []);

  const toConnection = (c: Connection | Edge): FlowConnection => ({
    from: c.source,
    out: Number((c.sourceHandle ?? "o0").slice(1)) || 0,
    to: c.target,
    in: Number((c.targetHandle ?? "i0").slice(1)) || 0,
  });

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const doc = current();
      return !!doc && connectionProblem(doc, catalogMap, toConnection(c)) === null;
    },
    [catalogMap],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const doc = current();
      if (doc) edit(connect(doc, catalogMap, toConnection(c)));
    },
    [catalogMap, edit],
  );

  const checkpoint = useCallback(() => useFlowsStore.getState().checkpoint(), []);

  /** One connection out — the canvas's remove button and the connection's menu. */
  const removeConnection = useCallback(
    (id: string) => {
      const doc = current();
      if (doc) edit(removeElements(doc, { connections: [id] }));
      // Keys are rebuilt from the ends, so the same wire drawn again would come back selected.
      setEdgeSelection((before) => {
        if (!before.has(id)) return before;
        const next = new Set(before);
        next.delete(id);
        return next;
      });
    },
    [edit],
  );

  const actions = useMemo<CanvasActions>(
    () => ({
      beginGesture: checkpoint,
      commitNoteText: (id, text) => {
        const doc = current();
        if (doc) edit(updateNote(doc, id, { text }));
      },
      removeConnection,
      removeConnectionLabel: t("flows.removeConnection"),
      setNoteColor: (id, color) => {
        const doc = current();
        if (!doc) return;
        // The whole selection when the note is part of it, like the menu's other commands.
        const chosen = selectionRef.current;
        const ids = chosen.has(id) ? doc.notes.filter((n) => chosen.has(n.id)).map((n) => n.id) : [id];
        edit(colorNotes(doc, ids, color));
      },
      noteColorFor,
      setNoteColorFor,
      noteColorLabel: t("flows.noteColor"),
      noteColorNoneLabel: t("flows.noteColorNone"),
    }),
    [checkpoint, edit, removeConnection, noteColorFor, t],
  );

  // ---------- commands ----------

  const selectedNodes = () => {
    const doc = current();
    return doc ? doc.nodes.filter((n) => selectionRef.current.has(n.id)).map((n) => n.id) : [];
  };
  const selectedNotes = () => {
    const doc = current();
    return doc ? doc.notes.filter((n) => selectionRef.current.has(n.id)).map((n) => n.id) : [];
  };

  const select = (ids: string[]) => {
    setSelection(new Set(ids));
    setEdgeSelection(new Set());
  };

  const viewportCenter = (): [number, number] => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    const point = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    return [point.x - 32, point.y - 32];
  };

  const copySelection = (): FlowFragment | null => {
    const doc = current();
    const nodeIds = selectedNodes();
    const noteIds = selectedNotes();
    if (!doc || (nodeIds.length === 0 && noteIds.length === 0)) return null;
    const fragment = copyFragment(doc, nodeIds, noteIds);
    clipboard = { fragment, pastes: 0 };
    void navigator.clipboard?.writeText(JSON.stringify(fragment)).catch(() => {});
    return fragment;
  };

  const pasteInto = (fragment: FlowFragment, step: number) => {
    const doc = current();
    if (!doc) return;
    const pasted = pasteFragment(doc, fragment, catalogMap, [PASTE_STEP * step, PASTE_STEP * step]);
    if (pasted.nodeIds.length + pasted.noteIds.length === 0) return;
    edit(pasted.spec);
    select([...pasted.nodeIds, ...pasted.noteIds]);
  };

  const paste = () => {
    if (!clipboard) return;
    clipboard.pastes += 1;
    pasteInto(clipboard.fragment, clipboard.pastes);
  };

  const deleteSelection = () => {
    const doc = current();
    if (!doc) return;
    edit(
      removeElements(doc, {
        nodes: selectedNodes(),
        notes: selectedNotes(),
        connections: [...edgeSelectionRef.current],
      }),
    );
    select([]);
  };

  const duplicateSelection = () => {
    const doc = current();
    if (!doc) return;
    const nodeIds = selectedNodes();
    const noteIds = selectedNotes();
    if (nodeIds.length + noteIds.length === 0) return;
    pasteInto(copyFragment(doc, nodeIds, noteIds), 1);
  };

  const toggleDisabled = () => {
    const doc = current();
    const ids = selectedNodes();
    if (!doc || ids.length === 0) return;
    const allOff = doc.nodes.filter((n) => ids.includes(n.id)).every((n) => n.disabled);
    edit(setNodeDisabled(doc, ids, !allOff));
  };

  const renameNodeById = (id: string) => {
    const doc = current();
    const node = doc?.nodes.find((n) => n.id === id);
    if (!doc || !node) return;
    void promptAction(t("flows.renameNodePrompt"), {
      initial: node.name,
      confirmLabel: t("flows.rename"),
      validate: (value) => {
        const latest = current();
        if (!latest || !value.trim()) return null;
        return renameNode(latest, id, value) ? null : t("flows.nameTaken", { name: value.trim() });
      },
    }).then((value) => {
      const latest = current();
      if (value && latest) edit(renameNode(latest, id, value));
    });
  };

  /**
   * Adds a node from the palette. Where it lands, in order: where the palette was opened from (a
   * right-click on the canvas); beside the one selected node, wired to its first output when that is
   * a legal connection — the way a flow is usually grown, left to right; or the middle of the view.
   */
  const placeNode = (typeId: string) => {
    const doc = current();
    if (!doc) return;
    const name = t(`flows.node.${typeId}` as TranslationKey);
    const anchorId = selectedNodes().length === 1 ? selectedNodes()[0] : null;
    const anchor = anchorId ? doc.nodes.find((n) => n.id === anchorId) : undefined;
    const at: [number, number] = palette?.at ?? (anchor ? [anchor.pos[0] + 200, anchor.pos[1]] : viewportCenter());
    const added = addNode(doc, typeId, name, at);
    let next = added.spec;
    if (!palette?.at && anchor) {
      const wired = connect(next, catalogMap, { from: anchor.id, out: 0, to: added.id, in: 0 });
      if (wired) next = wired;
    }
    edit(next);
    select([added.id]);
    // The palette stays open — a flow is built from it, node after node. A drop point from the
    // canvas's menu is used once.
    if (palette?.at) setPalette({ at: null });
  };

  /** The client point is on the drawing itself — not the AI window, the inspector or the zoom
   *  controls laid over it — and the canvas is taking edits. */
  const canvasAt = (x: number, y: number): boolean => {
    const host = wrapper.current;
    const under = document.elementFromPoint(x, y);
    return !diff && !!host && !!under && host.contains(under) && !!under.closest(".react-flow");
  };

  /** A node dragged in from the palette, centred where it was let go — on the grid, unwired. */
  const dropNode = (typeId: string, x: number, y: number) => {
    const doc = current();
    if (!doc || !canvasAt(x, y)) return;
    const point = screenToFlowPosition({ x, y });
    const snap = (n: number) => Math.round(n / 10) * 10;
    const added = addNode(doc, typeId, t(`flows.node.${typeId}` as TranslationKey), [snap(point.x - 32), snap(point.y - 32)]);
    edit(added.spec);
    select([added.id]);
  };

  const addNoteAt = (at: [number, number] | null) => {
    const doc = current();
    if (!doc) return;
    const added = addNote(doc, at ?? viewportCenter());
    edit(added.spec);
    select([added.id]);
  };

  const tidy = () => {
    const doc = current();
    if (!doc) return;
    edit(autoLayout(doc));
    // After React Flow has the new positions.
    requestAnimationFrame(() => void fitView({ padding: 0.25, maxZoom: 1, duration: 200 }));
  };

  // ---------- running ----------

  /** Every run reads the saved flow, so the open edit is saved first. */
  const runFlow = async (mode: Parameters<ReturnType<typeof useFlowRunsStore.getState>["start"]>[1], trigger?: string) => {
    await useFlowsStore.getState().flush();
    if (useFlowsStore.getState().draft?.dirty) return;
    void useFlowRunsStore.getState().start(draftId, mode, trigger ?? null);
  };

  const triggers = useMemo(
    () => (spec?.nodes ?? []).filter((n) => catalogMap.get(n.type)?.family === "trigger" && !n.disabled),
    [spec, catalogMap],
  );

  const openTriggerMenu = (event: ReactMouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: rect.left,
      y: rect.bottom + 4,
      items: triggers.map((trigger) => ({
        label: t("flows.run.from", { name: trigger.name }),
        icon: Play,
        onClick: () => void runFlow({ kind: "full" }, trigger.id),
      })),
    });
  };

  const pinOutput = async (nodeId: string) => {
    const run = useFlowRunsStore.getState().current[draftId]?.run;
    if (!run) return;
    const { flowsRunNodeData } = await import("../../lib/tauri/flowsCommands");
    const data = await flowsRunNodeData(run.id, nodeId, 5000).catch(() => null);
    if (data) void useFlowRunsStore.getState().pin(draftId, nodeId, data.outputs);
  };

  // ---------- keyboard ----------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const host = wrapper.current;
      // The view stays mounted while hidden (see `MainContent`), so the canvas only answers when it
      // is on screen and the keyboard is not in a field somewhere else — or in the open inspector.
      if (!host || host.offsetParent === null || isTyping(event.target)) return;
      if (useFlowRunsStore.getState().inspector) return;
      // A proposal on the canvas is answered from its window, not edited underneath it.
      const flowId = useFlowsStore.getState().draft?.id ?? "";
      if (useFlowsStore.getState().aiByFlow[flowId]?.status === "ready") return;
      const focus = document.activeElement;
      if (focus && focus !== document.body && !host.contains(focus)) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const store = useFlowsStore.getState();
      let handled = true;
      if (mod && key === "z" && !event.shiftKey) store.undo();
      else if (mod && ((key === "z" && event.shiftKey) || key === "y")) store.redo();
      else if (mod && key === "c") handled = copySelection() !== null;
      else if (mod && key === "x") {
        handled = copySelection() !== null;
        if (handled) deleteSelection();
      } else if (mod && key === "v") paste();
      else if (mod && key === "d") duplicateSelection();
      else if (mod && event.key === "Enter") void runFlow({ kind: "full" });
      else if (mod && key === "a") {
        const doc = current();
        select(doc ? [...doc.nodes.map((n) => n.id), ...doc.notes.map((n) => n.id)] : []);
      } else if (!mod && event.key === "Tab") store.setPalette(store.palette ? null : { at: null });
      else if (!mod && key === "f" && !event.altKey) void fitView({ padding: 0.25, maxZoom: 1, duration: 200 });
      else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // The handlers read the store and refs at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- menus ----------

  const openPaneMenu = (event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault();
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const at: [number, number] = [point.x - 32, point.y - 32];
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: t("flows.addNode"), icon: Plus, onClick: () => setPalette({ at }) },
        { label: t("flows.addNote"), icon: StickyNote, onClick: () => addNoteAt(at) },
        { label: t("flows.paste"), icon: ClipboardPaste, onClick: paste, disabled: !clipboard, separated: true },
        {
          label: t("flows.selectAll"),
          onClick: () => {
            const doc = current();
            select(doc ? [...doc.nodes.map((n) => n.id), ...doc.notes.map((n) => n.id)] : []);
          },
        },
        { label: t("flows.tidy"), icon: Network, onClick: tidy, separated: true },
      ],
    });
  };

  /** A connection's menu: it is selected, like a node under a right-click, and can be taken out. */
  const openEdgeMenu = (event: ReactMouseEvent, id: string) => {
    event.preventDefault();
    setSelection(new Set());
    setEdgeSelection(new Set([id]));
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [{ label: t("flows.removeConnection"), icon: Trash2, danger: true, onClick: () => removeConnection(id) }],
    });
  };

  const openSelectionMenu = (event: ReactMouseEvent, single: string | null) => {
    event.preventDefault();
    const doc = current();
    const ids = selectedNodes();
    const disabled = !!doc && ids.length > 0 && doc.nodes.filter((n) => ids.includes(n.id)).every((n) => n.disabled);
    const items: MenuItem[] = [];
    if (single && doc?.notes.some((n) => n.id === single)) {
      // Opens the dot's palette, on this note — one palette, two ways in.
      items.push({ label: t("flows.noteColor"), icon: Palette, onClick: () => setNoteColorFor(single) });
    }
    if (single && doc?.nodes.some((n) => n.id === single)) {
      const isTriggerNode = catalogMap.get(doc.nodes.find((n) => n.id === single)?.type ?? "")?.family === "trigger";
      const isPinned = useFlowRunsStore.getState().pins[draftId]?.[single] !== undefined;
      const hasOutput = !!useFlowRunsStore.getState().current[draftId]?.nodes[single];
      items.push(
        { label: t("flows.open"), icon: PanelTop, onClick: () => useFlowRunsStore.getState().openInspector(single) },
        {
          label: isTriggerNode ? t("flows.inspector.runTrigger") : t("flows.inspector.testStep"),
          icon: Play,
          disabled: running,
          onClick: () => void runFlow({ kind: "step", node: single }),
        },
        {
          label: t("flows.run.upTo"),
          icon: StepForward,
          disabled: running || isTriggerNode,
          onClick: () => void runFlow({ kind: "upTo", node: single }),
        },
        isPinned
          ? { label: t("flows.inspector.unpin"), icon: PinOff, onClick: () => void useFlowRunsStore.getState().unpin(draftId, single) }
          : { label: t("flows.run.pinOutput"), icon: Pin, disabled: !hasOutput, onClick: () => void pinOutput(single) },
        { label: t("flows.rename"), icon: Pencil, onClick: () => renameNodeById(single), separated: true },
      );
    }
    items.push(
      { label: t("flows.duplicate"), icon: CopyPlus, onClick: duplicateSelection },
      { label: t("flows.copy"), icon: Copy, onClick: () => void copySelection() },
      {
        label: t("flows.cut"),
        icon: Scissors,
        onClick: () => {
          if (copySelection()) deleteSelection();
        },
      },
    );
    if (ids.length > 0) {
      items.push({
        label: disabled ? t("flows.enableNode") : t("flows.disableNode"),
        icon: Power,
        onClick: toggleDisabled,
        separated: true,
      });
    }
    items.push({ label: t("flows.delete"), icon: Trash2, danger: true, onClick: deleteSelection, separated: true });
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  // ---------- render ----------

  if (!spec) return null;

  const status = saving ? t("flows.saving") : dirty ? t("flows.unsaved") : savedAt ? t("flows.saved") : "";
  const hasTrigger = spec.nodes.some((n) => catalogMap.get(n.type)?.family === "trigger");

  const names = Object.fromEntries(spec.nodes.map((n) => [n.id, n.name]));
  const startedAt = live ? Date.parse(live.run.startedAt) : 0;

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div className="flex h-full min-h-0 flex-col">
        <header className={toolbarClass} data-tour="flows-toolbar">
          <button
            type="button"
            className="min-w-[56px] truncate rounded-md px-1 text-[14px] font-semibold text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
            title={t("flows.rename")}
            onClick={() => {
              if (!meta) return;
              void promptAction(t("flows.renamePrompt"), { initial: meta.name, confirmLabel: t("flows.rename") }).then(
                (value) => value && void useFlowsStore.getState().renameFlow(meta.id, value),
              );
            }}
          >
            {meta?.name ?? ""}
          </button>
          {meta?.scope === "global" && (
            <span className="shrink-0 text-[var(--cf-text-muted)]" title={t("flows.global")}>
              <Globe size={13} />
            </span>
          )}
          <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">{status}</span>
          <span className="flex-1" />
          <Segmented
            options={[
              { value: "editor", label: t("flows.pane.editor") },
              { value: "executions", label: t("flows.pane.executions") },
            ]}
            value={pane}
            onChange={(next) => useFlowRunsStore.getState().setPane(next)}
            layoutId="flows-pane"
            size="sm"
            ariaLabel={t("flows.pane.label")}
          />
          <span className="flex-1" />
          {/* The icon buttons sit at toolbar spacing: at the header's own 8 px gaps they no longer
              fit beside the run controls on a laptop-width editor, and the flow's name paid for it. */}
          <span className="flex shrink-0 items-center gap-0.5">
          {pane === "editor" && (
            <>
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                title={`${t("flows.undo")} (⌘Z)`}
                aria-label={t("flows.undo")}
                disabled={!canUndo}
                onClick={() => useFlowsStore.getState().undo()}
              >
                <Undo2 size={15} />
              </button>
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                title={`${t("flows.redo")} (⇧⌘Z)`}
                aria-label={t("flows.redo")}
                disabled={!canRedo}
                onClick={() => useFlowsStore.getState().redo()}
              >
                <Redo2 size={15} />
              </button>
              <span className="mx-1 h-[18px] w-px shrink-0 bg-[var(--cf-border)]" />
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                title={t("flows.addNote")}
                aria-label={t("flows.addNote")}
                onClick={() => addNoteAt(null)}
              >
                <StickyNote size={15} />
              </button>
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                title={t("flows.tidy")}
                aria-label={t("flows.tidy")}
                disabled={spec.nodes.length < 2}
                onClick={tidy}
              >
                <Network size={15} />
              </button>
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                title={t("flows.history")}
                aria-label={t("flows.history")}
                onClick={() => setHistoryOpen(true)}
              >
                <History size={15} />
              </button>
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                title={t("flows.settingsDialog.title")}
                aria-label={t("flows.settingsDialog.title")}
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 size={15} />
              </button>
              <button
                type="button"
                className={iconButtonClass({ size: "sm", active: logOpen })}
                title={t("flows.log.title")}
                aria-label={t("flows.log.title")}
                aria-pressed={logOpen}
                onClick={() => useFlowRunsStore.getState().setLogOpen(!logOpen)}
                data-tour="flows-log-toggle"
              >
                <ScrollText size={15} />
              </button>
            </>
          )}
          <button
            type="button"
            className={iconButtonClass({ size: "sm" })}
            title={t("flows.vault.title")}
            aria-label={t("flows.vault.title")}
            onClick={() => useFlowVaultStore.getState().openDialog("variables")}
          >
            <KeyRound size={15} />
          </button>
          {pane === "editor" && (
            <button
              type="button"
              className={iconButtonClass({ size: "sm", active: aiOpen || !!aiRun })}
              title={t("flows.builder.button")}
              aria-label={t("flows.builder.button")}
              aria-expanded={aiOpen || aiRun?.status === "ready"}
              onClick={() => setAiOpen((open) => !open)}
              data-tour="flows-ai"
            >
              {/* While the model works with its window closed, the orb is where the run shows. */}
              {aiRun?.status === "running" && !aiOpen ? <ThinkingOrb size="sm" /> : <AiWand size={15} />}
            </button>
          )}
          </span>
          <span className="mx-0.5 h-[18px] w-px shrink-0 bg-[var(--cf-border)]" />
          {share?.conflict ? (
            <button
              type="button"
              className="flex h-[24px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-[var(--cf-warning)] hover:bg-[var(--cf-hover)]"
              title={t("flows.share.conflictHint")}
              onClick={() => setShareDialog("conflict")}
            >
              <Users size={13} />
              {t("flows.share.conflictChip")}
            </button>
          ) : (
            share && (
              <button
                type="button"
                className={`${iconButtonClass({ size: "sm" })} ${share.lastError ? "text-[var(--cf-warning)]" : ""}`}
                title={share.lastError || t("flows.share.shared")}
                aria-label={t("flows.share.title")}
                onClick={() => setShareDialog("share")}
              >
                <Users size={15} />
              </button>
            )
          )}
          {meta && !meta.trusted && (
            <button
              type="button"
              className="flex h-[24px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-[var(--cf-warning)] hover:bg-[var(--cf-hover)]"
              title={t("flows.trust.chipHint")}
              onClick={() => useFlowRunsStore.getState().askTrust(meta.id)}
            >
              <ShieldAlert size={13} />
              {t("flows.trust.chip")}
            </button>
          )}
          {meta && (
            <ActiveSwitch
              flowId={meta.id}
              active={meta.active}
              automatic={triggers.some((n) => n.type !== "trigger.manual")}
              trusted={meta.trusted}
            />
          )}
          {running ? (
            <Button variant="danger-ghost" size="sm" onClick={() => void useFlowRunsStore.getState().stop(draftId)} data-tour="flows-run">
              <Square size={11} />
              {t("flows.run.stop")}
              <span className="tabular-nums opacity-75">{formatDuration(Math.max(0, now - startedAt))}</span>
            </Button>
          ) : (
            <span className="flex shrink-0 items-center" data-tour="flows-run">
              <Button
                variant="primary"
                size="sm"
                className={triggers.length > 1 ? "rounded-r-none" : ""}
                disabled={triggers.length === 0}
                title={triggers.length === 0 ? t("flows.run.needsTrigger") : `${t("flows.run.run")} (⌘↵)`}
                onClick={() => void runFlow({ kind: "full" })}
              >
                <Play size={12} />
                {t("flows.run.run")}
              </Button>
              {triggers.length > 1 && (
                <Button
                  variant="primary"
                  size="sm"
                  className="rounded-l-none border-l border-[color-mix(in_oklab,var(--cf-on-accent)_25%,transparent)] px-1.5"
                  aria-label={t("flows.run.chooseTrigger")}
                  title={t("flows.run.chooseTrigger")}
                  onClick={openTriggerMenu}
                >
                  <ChevronDown size={12} />
                </Button>
              )}
            </span>
          )}
        </header>

        {pane === "executions" ? (
          <ExecutionsView />
        ) : (
          <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div ref={wrapper} className="relative min-h-0 flex-1" data-tour="flows-canvas">
              <ReactFlow<FlowCanvasNode, Edge>
                className="cf-flow-canvas"
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                isValidConnection={isValidConnection}
                onNodeDragStart={checkpoint}
                onSelectionDragStart={checkpoint}
                // A proposal is looked at, not edited: it is answered from the builder's window.
                nodesDraggable={!diff}
                nodesConnectable={!diff}
                elementsSelectable={!diff}
                onNodeDoubleClick={(_, node) => !diff && node.type === "cf" && useFlowRunsStore.getState().openInspector(node.id)}
                onPaneContextMenu={(event) => (diff ? event.preventDefault() : openPaneMenu(event))}
                onNodeContextMenu={(event, node) => {
                  if (diff) return event.preventDefault();
                  if (!selectionRef.current.has(node.id)) select([node.id]);
                  openSelectionMenu(event, node.id);
                }}
                onSelectionContextMenu={(event) => (diff ? event.preventDefault() : openSelectionMenu(event, null))}
                onEdgeContextMenu={(event, edge) => (diff ? event.preventDefault() : openEdgeMenu(event, edge.id))}
                onPaneClick={() => setMenu(null)}
                fitView
                fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
                minZoom={0.2}
                maxZoom={2}
                snapToGrid
                snapGrid={[10, 10]}
                deleteKeyCode={!onScreen || inspector || diff ? null : ["Backspace", "Delete"]}
                {...(onScreen ? {} : KEYS_OFF_SCREEN)}
                zoomOnDoubleClick={false}
                connectionRadius={26}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} />
              </ReactFlow>
              <ZoomControls />
              {(aiOpen || aiRun?.status === "ready") && <FlowAiPanel flowId={draftId} diff={diff} onClose={() => setAiOpen(false)} />}
              {inspector && !diff && spec.nodes.some((n) => n.id === inspector) && (
                <Suspense fallback={null}>
                  <NodeInspector nodeId={inspector} onClose={() => useFlowRunsStore.getState().openInspector(null)} />
                </Suspense>
              )}
            </div>
            {logOpen && <RunLog lines={live?.logs ?? []} names={names} onClose={() => useFlowRunsStore.getState().setLogOpen(false)} />}
          </div>
          {/* Docked beside the canvas, not over it — see `NodePalette`. */}
          <NodePalette
            catalog={catalog}
            initialFamily={hasTrigger ? null : "trigger"}
            expanded={palette !== null}
            disabled={diff !== null}
            onPick={placeNode}
            canDropAt={canvasAt}
            onDropAt={dropNode}
            onExpand={() => setPalette({ at: null })}
            onCollapse={() => setPalette(null)}
          />
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {settingsOpen && <FlowSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {shareDialog === "share" && <FlowShareDialog flowId={draftId} onClose={() => setShareDialog(null)} />}
      {shareDialog === "conflict" && <ShareConflictDialog flowId={draftId} onClose={() => setShareDialog(null)} />}

      {historyOpen && meta && (
        <VersionHistoryModal
          title={meta.name}
          listVersions={() => flowsListVersions(draftId)}
          readVersion={(versionId) => flowsVersionContent(versionId)}
          deleteVersion={(versionId) => flowsDeleteVersion(versionId)}
          clearVersions={() => flowsClearVersions(draftId)}
          onRestore={async (content) => {
            try {
              edit(parseSpec(content));
              await useFlowsStore.getState().flush();
            } catch (error) {
              pushErrorToast(t("flows.unreadable", { detail: String(error) }));
            }
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </CanvasActionsContext.Provider>
  );
}

/**
 * Active or paused: whether the flow's automatic triggers listen. A flow with only a manual trigger
 * has nothing to switch on, and says so instead of failing.
 */
function ActiveSwitch({ flowId, active, automatic, trusted }: { flowId: string; active: boolean; automatic: boolean; trusted: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      disabled={busy || (!active && (!automatic || !trusted))}
      title={
        active
          ? t("flows.active.onHint")
          : !trusted
            ? t("flows.trust.activateHint")
            : automatic
              ? t("flows.active.offHint")
              : t("flows.active.noTrigger")
      }
      data-tour="flows-active"
      onClick={async () => {
        setBusy(true);
        await useFlowsStore.getState().setActive(flowId, !active);
        setBusy(false);
      }}
      className="flex h-[26px] shrink-0 items-center gap-2 rounded-md px-1.5 text-[12px] font-medium text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-45"
    >
      <span
        className="relative h-[16px] w-[28px] shrink-0 rounded-full transition-colors"
        style={{ background: active ? "var(--cf-success)" : "var(--cf-border-strong)" }}
      >
        <span
          className="absolute left-0 top-[2px] h-3 w-3 rounded-full bg-[var(--cf-surface)] shadow-sm transition-transform"
          style={{ transform: `translateX(${active ? 14 : 2}px)` }}
        />
      </span>
      {active ? t("flows.active.on") : t("flows.active.off")}
    </button>
  );
}

/** Zoom out · percentage · zoom in · fit. Its own component so the viewport subscription that keeps
 *  the percentage live re-renders four buttons, not the canvas. */
function ZoomControls() {
  const t = useT();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const button = iconButtonClass({ size: "sm" });
  return (
    <div className="absolute bottom-3 left-3 z-10 flex items-center gap-px rounded-[9px] bg-[var(--cf-surface)] p-[3px] shadow-[var(--cf-shadow-lift),0_0_0_1px_var(--cf-border)]">
      <button type="button" className={button} title={t("flows.zoomOut")} aria-label={t("flows.zoomOut")} onClick={() => void zoomOut({ duration: 120 })}>
        <ZoomOut size={14} />
      </button>
      <span className="w-10 text-center text-[11px] tabular-nums text-[var(--cf-text-muted)]">{Math.round(zoom * 100)} %</span>
      <button type="button" className={button} title={t("flows.zoomIn")} aria-label={t("flows.zoomIn")} onClick={() => void zoomIn({ duration: 120 })}>
        <ZoomIn size={14} />
      </button>
      <button
        type="button"
        className={button}
        title={`${t("flows.fit")} (F)`}
        aria-label={t("flows.fit")}
        onClick={() => void fitView({ padding: 0.25, maxZoom: 1, duration: 200 })}
      >
        <Scan size={14} />
      </button>
    </div>
  );
}
