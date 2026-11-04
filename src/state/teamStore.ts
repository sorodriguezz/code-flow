import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { isMainWindow } from "../lib/windowIdentity";
import { useAiRunStore } from "./aiRunStore";
import { useAgentsStore } from "./agentsStore";
import { useChainStore } from "./chainStore";
import { pushErrorToast } from "./toastStore";
import { startAgentCli } from "../lib/agents/startCli";
import { invoke } from "@tauri-apps/api/core";
import {
  teamAnswer,
  teamControl,
  teamDecide,
  teamDelete,
  teamDeleteRun,
  teamItemTerminal,
  teamList,
  teamNote,
  teamRunMeta,
  teamRunState,
  teamRuns,
  teamSave,
  teamSettle,
  teamStart,
  type TeamRepoPick,
} from "../lib/tauri/teamCommands";
import type { Team, TeamDispatch, TeamPolicy, TeamRun, TeamRunState } from "../types/team";

/**
 * «Equipo»: the workspace's teams and their runs.
 *
 * The backend decides and now also drives (`src-tauri/src/runner`): every change to a run kicks the
 * runner, which claims what is ready and runs headless turns itself — so a run moves the same with
 * the Agents view in the main window, in an island, or with the window in the tray. Every window
 * only watches (`team:changed`, `runner:turn`) and sends orders. The one thing left to a window is
 * a member that runs in a terminal: the bench lives in the main window, which opens its CLI when
 * the runner hands it over (`team:terminal-dispatch`).
 */
interface TeamState {
  workspaceId: string | null;
  teams: Team[];
  runs: TeamRun[];
  states: Record<string, TeamRunState>;
  selectedRunId: string | null;
  loading: boolean;
  /** The team dialog open in the Agents view, if any — see `TeamDialogs`. */
  dialog: { kind: "run"; projectId?: string } | { kind: "teams" } | null;

  load: (workspaceId: string | null) => Promise<void>;
  refresh: (runId: string) => Promise<void>;
  select: (runId: string | null) => Promise<void>;
  saveTeam: (team: Team) => Promise<Team | null>;
  deleteTeam: (id: string) => Promise<void>;
  start: (input: { teamId: string; goal: string; title?: string; repos: TeamRepoPick[]; policy?: TeamPolicy | null; agentProjectId?: string }) => Promise<string | null>;
  pump: (runId: string) => Promise<void>;
  answer: (runId: string, messageId: string, answer: string) => Promise<void>;
  note: (runId: string, toId: string, body: string) => Promise<void>;
  decide: (runId: string, approve: boolean, comment?: string) => Promise<void>;
  control: (runId: string, action: string) => Promise<void>;
  /** A terminal member says it is done — the same as `cf done` from its shell. */
  finishTerminalItem: (runId: string, itemId: string, text: string) => Promise<void>;
  rename: (runId: string, title: string) => Promise<void>;
  setPinned: (runId: string, pinned: boolean) => Promise<void>;
  setGroup: (runId: string, agentProjectId: string) => Promise<void>;
  removeRun: (runId: string) => Promise<void>;
}


export const useTeamStore = create<TeamState>((set, get) => ({
  workspaceId: null,
  teams: [],
  runs: [],
  states: {},
  selectedRunId: null,
  loading: false,
  dialog: null,

  load: async (workspaceId) => {
    if (get().workspaceId !== workspaceId) set({ workspaceId, teams: [], runs: [], states: {}, selectedRunId: null });
    if (!workspaceId) return;
    set({ loading: true });
    const [teams, runs] = await Promise.all([teamList(workspaceId).catch(() => [] as Team[]), teamRuns(workspaceId).catch(() => [] as TeamRun[])]);
    if (get().workspaceId !== workspaceId) return;
    set({ teams, runs, loading: false });
    // A run that is moving carries on: whatever it was waiting for when the window closed, the
    // backend will say so on the claim.
    for (const run of runs) if (run.status === "running") void get().pump(run.id);
  },

  refresh: async (runId) => {
    const state = await teamRunState(runId).catch(() => null);
    if (!state) {
      set((s) => ({ runs: s.runs.filter((r) => r.id !== runId), states: omit(s.states, runId), selectedRunId: s.selectedRunId === runId ? null : s.selectedRunId }));
      return;
    }
    if (state.run.workspace_id !== get().workspaceId) return;
    set((s) => ({
      states: { ...s.states, [runId]: state },
      runs: upsertRun(s.runs, state.run),
    }));
  },

  select: async (runId) => {
    set({ selectedRunId: runId });
    if (!runId) return;
    // One thing in the middle column.
    useAgentsStore.setState({ selectedId: null });
    useChainStore.setState({ selectedId: null, selectedTemplateId: null });
    await get().refresh(runId);
  },

  saveTeam: async (team) => {
    try {
      const saved = await teamSave(team);
      set((s) => ({ teams: [...s.teams.filter((t) => t.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)) }));
      return saved;
    } catch (e) {
      pushErrorToast(String(e));
      return null;
    }
  },

  deleteTeam: async (id) => {
    await teamDelete(id).catch((e: unknown) => pushErrorToast(String(e)));
    set((s) => ({ teams: s.teams.filter((t) => t.id !== id) }));
  },

  start: async (input) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    try {
      const state = await teamStart({ workspaceId, ...input });
      set((s) => ({ states: { ...s.states, [state.run.id]: state }, runs: upsertRun(s.runs, state.run) }));
      await get().select(state.run.id);
      void get().pump(state.run.id);
      return state.run.id;
    } catch (e) {
      pushErrorToast(String(e));
      return null;
    }
  },

  pump: async (runId) => {
    await invoke("team_pump", { runId }).catch(() => undefined);
  },

  answer: async (runId, messageId, answer) => {
    await teamAnswer(messageId, answer).catch((e: unknown) => pushErrorToast(String(e)));
    await get().refresh(runId);
    void get().pump(runId);
  },

  note: async (runId, toId, body) => {
    await teamNote(runId, toId, body).catch((e: unknown) => pushErrorToast(String(e)));
    await get().refresh(runId);
  },

  decide: async (runId, approve, comment) => {
    await teamDecide(runId, approve, comment).catch((e: unknown) => pushErrorToast(String(e)));
    await get().refresh(runId);
    void get().pump(runId);
  },

  control: async (runId, action) => {
    const running = await teamControl(runId, action).catch((e: unknown) => {
      pushErrorToast(String(e));
      return [] as string[];
    });
    // The runner stops the turns it has in flight; a task started from this window by hand is
    // stopped here too.
    if (action === "abort") for (const taskId of running) void useAgentsStore.getState().stop(taskId);
    await get().refresh(runId);
    if (action !== "abort" && action !== "pause") void get().pump(runId);
  },

  finishTerminalItem: async (runId, itemId, text) => {
    await teamSettle(itemId, "ok", text).catch((e: unknown) => pushErrorToast(String(e)));
    await get().refresh(runId);
    void get().pump(runId);
  },

  rename: async (runId, title) => {
    await teamRunMeta(runId, { title }).catch(() => undefined);
    await get().refresh(runId);
  },
  setPinned: async (runId, pinned) => {
    await teamRunMeta(runId, { pinned }).catch(() => undefined);
    await get().refresh(runId);
  },
  setGroup: async (runId, agentProjectId) => {
    await teamRunMeta(runId, { agentProjectId }).catch(() => undefined);
    await get().refresh(runId);
  },

  removeRun: async (runId) => {
    const state = get().states[runId];
    for (const item of state?.items ?? []) if (item.status === "running" && item.task_id) void useAgentsStore.getState().stop(item.task_id);
    await teamDeleteRun(runId).catch((e: unknown) => pushErrorToast(String(e)));
    const taskIds = new Set((state?.items ?? []).map((i) => i.task_id).filter(Boolean));
    useAgentsStore.setState((s) => ({ tasks: s.tasks.filter((t) => !taskIds.has(t.id)) }));
    set((s) => ({ runs: s.runs.filter((r) => r.id !== runId), states: omit(s.states, runId), selectedRunId: s.selectedRunId === runId ? null : s.selectedRunId }));
  },
}));

/** Opens a terminal member's CLI in the bench — the one part of a run a window has to do. */
async function runInTerminal(runId: string, dispatch: TeamDispatch, get: () => TeamState) {
  const { item } = dispatch;
  const settle = async (error: string) => {
    await teamSettle(item.id, "error", undefined, error).catch((e: unknown) => pushErrorToast(String(e)));
    await get().refresh(runId);
  };
  const workspaceId = get().workspaceId ?? dispatch.task?.workspace_id ?? null;
  if (!workspaceId) {
    await settle("no hay un workspace abierto para su terminal");
    return;
  }
  try {
    const started = await startAgentCli({
      workspaceId,
      path: dispatch.cwd,
      provider: dispatch.provider,
      title: dispatch.title,
      prompt: dispatch.message,
      model: dispatch.model,
      effort: dispatch.effort,
    });
    if (started) await teamItemTerminal(item.id, started.sessionId).catch(() => undefined);
    else await settle("no se pudo abrir su terminal");
    await get().refresh(runId);
  } catch (e) {
    await settle(String(e));
  }
}

function upsertRun(runs: TeamRun[], run: TeamRun): TeamRun[] {
  const others = runs.filter((r) => r.id !== run.id);
  return [run, ...others].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

// The backend says when a run moved — the runner, a terminal member's `cf done`, another window.
// A run this window has not listed yet (started from an island) is fetched rather than ignored.
void listen<{ runId: string }>("team:changed", (event) => {
  const { runId } = event.payload;
  const store = useTeamStore.getState();
  if (!store.workspaceId) return;
  void store.refresh(runId);
});

// The runner hands a terminal member to the window that holds the bench.
if (isMainWindow()) {
  void listen<{ runId: string; dispatch: TeamDispatch }>("team:terminal-dispatch", (event) => {
    void runInTerminal(event.payload.runId, event.payload.dispatch, useTeamStore.getState);
  });
}

/** A headless turn the runner started or finished, so the status bar and the task's transcript
 * show it live in every window — what `agentsStore.runTurn` did when the window ran it. */
export interface RunnerTurnEvent {
  phase: "start" | "end";
  runId: string;
  teamRunId: string;
  itemId: string;
  taskId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  ok: boolean;
  error: string;
}

void listen<RunnerTurnEvent>("runner:turn", (event) => {
  const turn = event.payload;
  const runs = useAiRunStore.getState();
  if (turn.phase === "start") {
    runs.register(turn.runId, {
      kindKey: "team.liveKind",
      detail: turn.title,
      workspaceId: turn.workspaceId,
      target: { view: "agents", projectId: turn.projectId },
    });
    useAgentsStore.getState().markRunnerTurn(turn.taskId, turn.runId);
  } else {
    runs.finish(turn.runId);
    useAgentsStore.getState().markRunnerTurn(turn.taskId, null);
  }
});

// A task or a chain taking the middle column puts the run away.
useAgentsStore.subscribe((s, prev) => {
  if (s.selectedId && s.selectedId !== prev.selectedId && useTeamStore.getState().selectedRunId) useTeamStore.setState({ selectedRunId: null });
});
useChainStore.subscribe((s, prev) => {
  if ((s.selectedId && s.selectedId !== prev.selectedId) || (s.selectedTemplateId && s.selectedTemplateId !== prev.selectedTemplateId)) {
    if (useTeamStore.getState().selectedRunId) useTeamStore.setState({ selectedRunId: null });
  }
});
