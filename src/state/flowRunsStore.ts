import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  flowsActiveRuns,
  flowsCancelRun,
  flowsClearRuns,
  flowsDeleteRun,
  flowsGetRun,
  flowsListPins,
  flowsListRuns,
  flowsPinNode,
  flowsRun,
  flowsRunLog,
  flowsListWaits,
  flowsTriggerStatus,
  flowsUnpinNode,
  type FlowWait,
  type FlowAgentEvent,
  type FlowAiEvent,
  type FlowOpenEvent,
  type FlowTerminalEvent,
  type FlowArmedView,
  type FlowLogEvent,
  type FlowLogLine,
  type FlowNodeEvent,
  type FlowNotifyEvent,
  type FlowRunDetail,
  type FlowRunMode,
  type FlowRunNodeRow,
  type FlowRunRow,
} from "../lib/tauri/flowsCommands";
import { isMainWindow } from "../lib/windowIdentity";
import { useAiRunStore } from "./aiRunStore";
import { translate } from "./languageStore";
import { notify } from "./notificationStore";
import { pushErrorToast } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Flujos' runs, as the window sees them: the run each flow's canvas paints, the executions list,
 * pinned output, and which panels are open around the canvas.
 *
 * Kept apart from `flowsStore`, which is about editing one document: a run belongs to a flow, not
 * to the open draft, and it goes on — and keeps sending events — after the flow is closed, the view
 * is left or the workspace changes. So everything here is keyed by flow id and filed from the
 * event's own `flowId`, never from "whatever is open" (the run-isolation rule).
 */

/** The log lines a run keeps in memory; the file on disk has the rest. */
const LOG_LIMIT = 5000;

export interface LiveRun {
  run: FlowRunRow;
  nodes: Record<string, FlowRunNodeRow>;
  logs: FlowLogLine[];
}

interface History {
  rows: FlowRunRow[];
  loading: boolean;
  /** Whether an older page may exist. */
  more: boolean;
}

export type FlowPane = "editor" | "executions" | "schedule";

interface FlowRunsState {
  /** Per flow: the run its canvas shows — the newest this window started, saw arrive, or loaded. */
  current: Record<string, LiveRun>;
  /** Per flow: pinned output, node id → ports. */
  pins: Record<string, Record<string, unknown[][]>>;
  history: Record<string, History>;
  /** Run details the executions view opened. */
  details: Record<string, FlowRunDetail>;
  pane: FlowPane;
  logOpen: boolean;
  /** The node open in the inspector, if any. */
  inspector: string | null;
  /** The execution selected in the executions view. */
  selectedRun: string | null;
  /** The node selected in an execution's waterfall. */
  selectedRunNode: string | null;
  /** What the active flows of the workspace on screen listen for. */
  triggers: FlowArmedView[];
  /** The workspace's runs waiting for someone — approvals, calls, times — oldest first. */
  waits: FlowWait[];
  /** A flow whose commands are up for review before it may run — and the run to start once trusted. */
  trustPrompt: { flowId: string; then: { mode: FlowRunMode; trigger: string | null } | null } | null;
  askTrust: (flowId: string | null, then?: { mode: FlowRunMode; trigger: string | null } | null) => void;

  start: (flowId: string, mode: FlowRunMode, trigger?: string | null) => Promise<FlowRunRow | null>;
  stop: (flowId: string) => Promise<void>;
  /** What a flow needs when it opens: its pins and its newest run (to paint). */
  loadFlow: (flowId: string, workspaceId: string) => Promise<void>;
  loadHistory: (flowId: string, older?: boolean) => Promise<void>;
  loadRun: (runId: string) => Promise<FlowRunDetail | null>;
  deleteRun: (flowId: string, runId: string) => Promise<void>;
  clearRuns: (flowId: string) => Promise<void>;
  pin: (flowId: string, nodeId: string, ports: unknown[][]) => Promise<void>;
  unpin: (flowId: string, nodeId: string) => Promise<void>;
  setPane: (pane: FlowPane) => void;
  setLogOpen: (open: boolean) => void;
  openInspector: (nodeId: string | null) => void;
  selectRun: (runId: string | null, nodeId?: string | null) => void;
  selectRunNode: (nodeId: string | null) => void;
  loadTriggers: () => Promise<void>;
  loadWaits: () => Promise<void>;
}

/** Runs this window started: their failures get a toast here, everyone else's only a notification. */
const startedHere = new Set<string>();

const isRunning = (run: FlowRunRow | undefined) => run?.status === "running";

export const useFlowRunsStore = create<FlowRunsState>((set, get) => ({
  current: {},
  pins: {},
  history: {},
  details: {},
  pane: "editor",
  logOpen: false,
  inspector: null,
  selectedRun: null,
  selectedRunNode: null,
  triggers: [],
  waits: [],
  trustPrompt: null,
  askTrust: (flowId, then = null) => set({ trustPrompt: flowId ? { flowId, then } : null }),

  start: async (flowId, mode, trigger) => {
    if (isRunning(get().current[flowId]?.run)) return null;
    try {
      const run = await flowsRun(flowId, mode, trigger ?? null);
      startedHere.add(run.id);
      adoptRun(run);
      return run;
    } catch (error) {
      const text = String(error);
      // Somebody else's commands: they are shown first, and the run starts once they are trusted.
      if (text === "untrusted") {
        set({ trustPrompt: { flowId, then: { mode, trigger: trigger ?? null } } });
        return null;
      }
      pushErrorToast(text.includes("no-trigger") ? translate("flows.run.noTrigger") : text);
      return null;
    }
  },

  stop: async (flowId) => {
    const run = get().current[flowId]?.run;
    if (!run || !isRunning(run)) return;
    await flowsCancelRun(run.id).catch((error) => pushErrorToast(String(error)));
  },

  loadFlow: async (flowId, workspaceId) => {
    try {
      const [pins, newest, active] = await Promise.all([
        flowsListPins(flowId),
        get().current[flowId] ? Promise.resolve([] as FlowRunRow[]) : flowsListRuns(flowId, 1),
        flowsActiveRuns(workspaceId),
      ]);
      set((state) => ({ pins: { ...state.pins, [flowId]: pins } }));
      const running = active.find((run) => run.flowId === flowId);
      const pick = running ?? newest[0];
      if (!pick || get().current[flowId]?.run.id === pick.id) return;
      const [detail, logs] = await Promise.all([flowsGetRun(pick.id), flowsRunLog(pick.id).catch(() => [])]);
      if (!detail) return;
      // Something newer may have arrived by event while this was loading.
      const now = get().current[flowId];
      if (now && now.run.startedAt > detail.run.startedAt) return;
      set((state) => ({
        current: {
          ...state.current,
          [flowId]: {
            run: detail.run,
            nodes: Object.fromEntries(detail.nodes.map((node) => [node.nodeId, node])),
            logs: logs.slice(-LOG_LIMIT),
          },
        },
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  loadHistory: async (flowId, older) => {
    const existing = get().history[flowId];
    if (existing?.loading) return;
    const before = older && existing?.rows.length ? existing.rows[existing.rows.length - 1].startedAt : null;
    set((state) => ({
      history: { ...state.history, [flowId]: { rows: existing?.rows ?? [], loading: true, more: existing?.more ?? true } },
    }));
    try {
      const rows = await flowsListRuns(flowId, 50, before);
      set((state) => {
        const previous = older ? state.history[flowId]?.rows ?? [] : [];
        const merged = [...previous, ...rows.filter((row) => !previous.some((p) => p.id === row.id))];
        return { history: { ...state.history, [flowId]: { rows: merged, loading: false, more: rows.length === 50 } } };
      });
    } catch (error) {
      set((state) => ({ history: { ...state.history, [flowId]: { rows: existing?.rows ?? [], loading: false, more: false } } }));
      pushErrorToast(String(error));
    }
  },

  loadRun: async (runId) => {
    try {
      const detail = await flowsGetRun(runId);
      if (detail) set((state) => ({ details: { ...state.details, [runId]: detail } }));
      return detail;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  deleteRun: async (flowId, runId) => {
    try {
      await flowsDeleteRun(runId);
      set((state) => {
        const history = state.history[flowId];
        const details = { ...state.details };
        delete details[runId];
        const current = { ...state.current };
        if (current[flowId]?.run.id === runId) delete current[flowId];
        return {
          details,
          current,
          selectedRun: state.selectedRun === runId ? null : state.selectedRun,
          history: history
            ? { ...state.history, [flowId]: { ...history, rows: history.rows.filter((row) => row.id !== runId) } }
            : state.history,
        };
      });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  clearRuns: async (flowId) => {
    try {
      await flowsClearRuns(flowId);
      set((state) => {
        const current = { ...state.current };
        if (current[flowId] && !isRunning(current[flowId].run)) delete current[flowId];
        const kept = (state.history[flowId]?.rows ?? []).filter((row) => isRunning(row));
        return {
          current,
          selectedRun: null,
          history: { ...state.history, [flowId]: { rows: kept, loading: false, more: false } },
        };
      });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  pin: async (flowId, nodeId, ports) => {
    try {
      await flowsPinNode(flowId, nodeId, ports);
      set((state) => ({ pins: { ...state.pins, [flowId]: { ...(state.pins[flowId] ?? {}), [nodeId]: ports } } }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  unpin: async (flowId, nodeId) => {
    try {
      await flowsUnpinNode(flowId, nodeId);
      set((state) => {
        const pins = { ...(state.pins[flowId] ?? {}) };
        delete pins[nodeId];
        return { pins: { ...state.pins, [flowId]: pins } };
      });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  setPane: (pane) => set({ pane, inspector: pane === "executions" ? null : get().inspector }),
  setLogOpen: (logOpen) => set({ logOpen }),
  openInspector: (inspector) => set({ inspector }),
  selectRun: (selectedRun, nodeId) => set({ selectedRun, selectedRunNode: nodeId ?? null }),
  selectRunNode: (selectedRunNode) => set({ selectedRunNode }),
  loadTriggers: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    try {
      const triggers = await flowsTriggerStatus(workspaceId);
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) set({ triggers });
    } catch {
      // The view shows what it had; the next change tries again.
    }
  },

  loadWaits: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!workspaceId) {
      set({ waits: [] });
      return;
    }
    try {
      const waits = await flowsListWaits(workspaceId);
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) set({ waits });
    } catch {
      // As above: what is on screen stays until the next change.
    }
  },
}));

/** A run row arrived: it becomes its flow's current run if it is that run or a newer one. */
function adoptRun(run: FlowRunRow): void {
  useFlowRunsStore.setState((state) => {
    const existing = state.current[run.flowId];
    let current = state.current;
    if (!existing || existing.run.id === run.id) {
      current = { ...state.current, [run.flowId]: { run, nodes: existing?.nodes ?? {}, logs: existing?.logs ?? [] } };
    } else if (run.startedAt >= existing.run.startedAt) {
      current = { ...state.current, [run.flowId]: { run, nodes: {}, logs: [] } };
    }
    const history = state.history[run.flowId];
    const rows = history
      ? history.rows.some((row) => row.id === run.id)
        ? history.rows.map((row) => (row.id === run.id ? run : row))
        : [run, ...history.rows]
      : undefined;
    const detail = state.details[run.id];
    return {
      current,
      history: rows && history ? { ...state.history, [run.flowId]: { ...history, rows } } : state.history,
      details: detail ? { ...state.details, [run.id]: { ...detail, run } } : state.details,
    };
  });
}

function settled(run: FlowRunRow): void {
  const mine = startedHere.delete(run.id);
  // A run nobody started by hand speaks when its flow says so.
  if (run.notify) {
    if (!isMainWindow() || run.notify === "never") return;
    if (run.status === "error" || (run.notify === "always" && run.status === "success")) {
      const failed = run.status === "error";
      notify({
        source: "flows",
        workspaceId: run.workspaceId,
        titleKey: failed ? "flows.run.failedTitle" : "flows.run.doneTitle",
        params: { flow: run.flowName },
        detail: failed ? run.error : undefined,
        status: failed ? "error" : "success",
        target: { view: "flows" },
      });
    }
    return;
  }
  if (run.status === "error") {
    const node = run.errorNode
      ? useFlowRunsStore.getState().current[run.flowId]?.nodes[run.errorNode]?.nodeName ?? run.errorNode
      : "";
    const detail = node ? `${node}: ${run.error}` : run.error;
    if (mine) pushErrorToast(translate("flows.run.failed", { detail }));
    if (isMainWindow()) {
      notify({
        source: "flows",
        workspaceId: run.workspaceId,
        titleKey: "flows.run.failedTitle",
        params: { flow: run.flowName },
        detail,
        status: "error",
        target: { view: "flows" },
      });
    }
  } else if (run.status === "success" && isMainWindow() && (run.durationMs ?? 0) >= 30_000) {
    // A long run finished — the kind somebody walks away from.
    notify({
      source: "flows",
      workspaceId: run.workspaceId,
      titleKey: "flows.run.doneTitle",
      params: { flow: run.flowName },
      status: "success",
      target: { view: "flows" },
    });
  }
}

let listening = false;

/** Subscribes this window to run events. Idempotent; called by the view on mount. */
export function ensureFlowRunEvents(): void {
  if (listening) return;
  listening = true;
  void listen<FlowRunRow>("flows:run", (event) => {
    const run = event.payload;
    adoptRun(run);
    if (run.status !== "running") settled(run);
  });
  void listen<FlowNodeEvent>("flows:node", (event) => {
    const { flowId, runId, node } = event.payload;
    useFlowRunsStore.setState((state) => {
      const live = state.current[flowId];
      const detail = state.details[runId];
      const next: Partial<FlowRunsState> = {};
      if (live && live.run.id === runId) {
        next.current = { ...state.current, [flowId]: { ...live, nodes: { ...live.nodes, [node.nodeId]: node } } };
      }
      if (detail) {
        const nodes = detail.nodes.some((n) => n.nodeId === node.nodeId)
          ? detail.nodes.map((n) => (n.nodeId === node.nodeId ? node : n))
          : [...detail.nodes, node];
        next.details = { ...state.details, [runId]: { ...detail, nodes } };
      }
      return next;
    });
  });
  void listen<FlowLogEvent>("flows:log", (event) => {
    const { flowId, runId, lines } = event.payload;
    useFlowRunsStore.setState((state) => {
      const live = state.current[flowId];
      if (!live || live.run.id !== runId) return {};
      const logs = [...live.logs, ...lines];
      return { current: { ...state.current, [flowId]: { ...live, logs: logs.length > LOG_LIMIT ? logs.slice(-LOG_LIMIT) : logs } } };
    });
  });
  let triggerTimer: ReturnType<typeof setTimeout> | undefined;
  void listen("flows:triggers", () => {
    if (triggerTimer) clearTimeout(triggerTimer);
    triggerTimer = setTimeout(() => void useFlowRunsStore.getState().loadTriggers(), 250);
  });
  useWorkspaceStore.subscribe((state, previous) => {
    if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
      void useFlowRunsStore.getState().loadTriggers();
      void useFlowRunsStore.getState().loadWaits();
    }
  });
  void useFlowRunsStore.getState().loadTriggers();
  void useFlowRunsStore.getState().loadWaits();
  // A run started or stopped waiting for someone. An approval that opens is also a notification:
  // it is a question, and the person it is for may be in another app.
  void listen<FlowWait>("flows:wait", (event) => {
    const wait = event.payload;
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (wait.workspaceId === workspaceId) {
      useFlowRunsStore.setState((state) => ({
        waits: wait.decidedAt ? state.waits.filter((w) => w.id !== wait.id) : [...state.waits.filter((w) => w.id !== wait.id), wait],
      }));
    }
    if (!wait.decidedAt && wait.kind === "approval" && isMainWindow()) {
      notify({
        source: "flows",
        workspaceId: wait.workspaceId,
        titleKey: "flows.wait.notifyTitle",
        params: { flow: wait.flowName },
        detail: wait.message || wait.nodeName,
        status: "info",
        target: { view: "flows" },
      });
    }
  });
  // An AI node's model call is about to start: every window lists it under the flow's name, before
  // the engine's own banner would file it as a run nobody here started.
  void listen<FlowAiEvent>("flows:ai", (event) => {
    const { runId, flowName, workspaceId, node } = event.payload;
    useAiRunStore.getState().adopt(runId, {
      kindKey: "flows.aiRunKind",
      detail: `${flowName} · ${node}`,
      workspaceId,
      target: { view: "flows" },
    });
  });
  // A flow filed a chain in Agents. Chains are driven by the main window and only there; marked as
  // driven from outside so a window closed to the tray still advances it — the flow asked.
  void listen<FlowAgentEvent>("flows:agent", (event) => {
    if (!isMainWindow()) return;
    const { chainId, aborted } = event.payload;
    void import("./chainStore").then(async ({ useChainStore }) => {
      const chains = useChainStore.getState();
      if (aborted) {
        await chains.abort(chainId).catch(() => {});
        return;
      }
      await chains.reloadChains().catch(() => {});
      await useChainStore.getState().pump(chainId, { remote: true });
    });
  });
  // A flow asked to show one of the app's views (URLs, files and folders open from Rust).
  void listen<FlowOpenEvent>("flows:open", (event) => {
    if (!isMainWindow()) return;
    const { kind, target } = event.payload;
    if (kind === "view" && target) {
      void import("./uiStore").then(({ useUiStore }) => useUiStore.getState().setActiveView(target as never));
    }
  });
  // A flow asked for a terminal the user can watch: a tab of the repository's (or the active one's)
  // dock, running the command.
  void listen<FlowTerminalEvent>("flows:terminal", (event) => {
    if (!isMainWindow()) return;
    const { command, cwd, projectId, title } = event.payload;
    void Promise.all([import("./terminalStore"), import("./workspaceStore")]).then(([{ useTerminalStore }, { useWorkspaceStore }]) => {
      const project = projectId || useWorkspaceStore.getState().activeProjectId || "";
      if (!project) return;
      void useTerminalStore.getState().runCommand(project, { cwd, command, reuseKey: `flow:${title}`, title });
    });
  });
  void listen<FlowNotifyEvent>("flows:notify", (event) => {
    if (!isMainWindow()) return;
    const { workspaceId, title, body } = event.payload;
    notify({
      source: "flows",
      workspaceId,
      titleKey: "flows.notifyTitle",
      params: { title },
      detail: body,
      status: "info",
      target: { view: "flows" },
    });
  });
}
