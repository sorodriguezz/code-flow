import { create } from "zustand";
import {
  createAgentTask,
  deleteAgentTask,
  deleteChatConversation,
  getChatConversation,
  isRepoBusy,
  listAgentTasks,
  listWorkspaceAgents,
  renameAgentTask,
  sendChatMessage,
  setAgentTaskProject,
  updateAgentTaskRun,
  REPO_BUSY_MARKER,
} from "../lib/tauri/commands";
import { notifyTurnSettled } from "./agentEvents";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { parseTrace, type ChatMessage } from "./chatStore";
import { translate } from "./languageStore";
import { pushErrorToast } from "./toastStore";
import type { AgentTask, AgentTaskStatus, WorkspaceAgent } from "../types/domain";

/** The repository name the backend put after its busy marker, for the "not now" message. */
function busyRepoName(error: string): string {
  const at = error.indexOf(REPO_BUSY_MARKER);
  return at < 0 ? "" : error.slice(at + REPO_BUSY_MARKER.length).replace(/"$/, "").trim();
}

/** How a turn ended, for whoever asked for it. `busy` means it never ran at all. */
export type TurnOutcome =
  | { kind: "ok"; text: string; model: string | null; createdAt: string }
  | { kind: "error"; message: string; busy: boolean }
  | { kind: "cancelled" };

/** How much of the goal names the task until the user renames it. Long enough to tell two apart,
 * short enough for a list row. */
const TITLE_MAX = 64;

export function taskTitleFrom(goal: string): string {
  const oneLine = goal.replace(/\s+/g, " ").trim();
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX)}…` : oneLine;
}

/** An agent that can actually run: enabled, and pointed at both a provider and a model.
 *
 * The model half is not a nicety — the backend only takes the agent's routing when *both* are
 * non-blank (`load_ai_config_for`), so an agent missing one silently runs on the normal chat
 * routing instead. Offering it would mean the picker naming one engine while another answers. */
export function isRunnableAgent(agent: WorkspaceAgent): boolean {
  return agent.enabled && agent.provider.trim() !== "" && agent.model.trim() !== "";
}

/** The live half of a task: everything that only exists while the app is running. The persisted
 * half is the `AgentTask` row; these two are keyed by the same task id. */
export interface AgentTaskLive {
  messages: ChatMessage[];
  /** The engine's own resume token from the last reply — what carries the CLI's context forward. */
  sessionId: string | null;
  runId: string | null;
  runStartedAt: number | null;
  sending: boolean;
  /** Whether the transcript has been read back from disk yet. */
  loaded: boolean;
}

const EMPTY_LIVE: AgentTaskLive = {
  messages: [],
  sessionId: null,
  runId: null,
  runStartedAt: null,
  sending: false,
  loaded: false,
};

export type TaskGrouping = "date" | "status" | "agent";

interface AgentsState {
  workspaceId: string | null;
  tasks: AgentTask[];
  roster: WorkspaceAgent[];
  live: Record<string, AgentTaskLive>;
  selectedId: string | null;
  groupBy: TaskGrouping;
  query: string;
  /** Whether the roster rail is open. A view state, so it lives here rather than in `uiStore` —
   * nothing outside this view needs to open it. */
  rosterOpen: boolean;
  loading: boolean;

  setWorkspace: (id: string | null) => Promise<void>;
  reloadRoster: () => Promise<void>;
  setGroupBy: (grouping: TaskGrouping) => void;
  setQuery: (query: string) => void;
  toggleRoster: () => void;
  select: (taskId: string | null) => Promise<void>;
  create: (input: { projectId: string; agent: WorkspaceAgent; goal: string }) => Promise<AgentTask>;
  /** Adds a task created outside this store (a chain step). Unlike `create` it does **not** touch
   * `selectedId`: a background step must not yank the detail pane out from under the user. */
  adopt: (task: AgentTask) => void;
  send: (taskId: string, message: string) => void;
  /** `send` without its guards, for a caller that has already decided. Always settles. */
  runTurn: (
    taskId: string,
    message: string,
    opts?: { runId?: string; onSettle?: (outcome: TurnOutcome) => void },
  ) => Promise<void>;
  stop: (taskId: string) => Promise<void>;
  setModel: (taskId: string, model: string) => Promise<void>;
  setProject: (taskId: string, projectId: string) => Promise<void>;
  setStatus: (taskId: string, status: AgentTaskStatus) => Promise<void>;
  rename: (taskId: string, title: string) => Promise<void>;
  remove: (taskId: string) => Promise<void>;
  /** The task currently running in `projectId`, if any — the one-agent-per-repository guard. */
  runningInProject: (projectId: string, exceptTaskId?: string) => AgentTask | null;
  liveFor: (taskId: string | null) => AgentTaskLive;
}

/**
 * The agent console's state: the workspace's task list, its agent roster, and the live half of
 * every task that has been opened this session.
 *
 * Deliberately *not* built on `chatStore`, even though a turn goes through the same backend
 * command. That store is keyed by "which conversation is this project showing", which is the
 * question the AI panel asks; a task is not a project's current conversation and must not become
 * one, or opening a task would move the panel out from under whatever the user was reading.
 */
export const useAgentsStore = create<AgentsState>((set, get) => ({
  workspaceId: null,
  tasks: [],
  roster: [],
  live: {},
  selectedId: null,
  groupBy: "date",
  query: "",
  rosterOpen: false,
  loading: false,

  setWorkspace: async (id) => {
    if (get().workspaceId === id) return;
    // Entries for turns still in flight are kept, everything else is dropped. Task ids are UUIDs,
    // so nothing collides across workspaces — and a run does not stop just because the user looked
    // at another workspace. Throwing its entry away would take the spinner, the stop button and
    // the one-run-per-repository guard with it, and would leave `settle` with nowhere to file the
    // reply when it lands.
    set((s) => ({
      workspaceId: id,
      tasks: [],
      roster: [],
      live: Object.fromEntries(Object.entries(s.live).filter(([, entry]) => entry.sending)),
      selectedId: null,
      query: "",
      loading: id !== null,
    }));
    if (!id) return;
    const [tasks, roster] = await Promise.all([
      listAgentTasks(id).catch(() => [] as AgentTask[]),
      listWorkspaceAgents(id).catch(() => [] as WorkspaceAgent[]),
    ]);
    set((s) => {
      if (s.workspaceId !== id) return s;
      // A row still marked `running` with nothing live behind it was written by a session that was
      // killed mid-turn: there is no process there any more, and leaving it would show a spinner
      // that never resolves. One whose run *is* still in flight is left alone.
      const settled = tasks.map((task) =>
        task.status === "running" && !s.live[task.id]?.sending ? { ...task, status: "idle" as const } : task,
      );
      for (const task of tasks) {
        if (task.status === "running" && !s.live[task.id]?.sending) {
          void updateAgentTaskRun(task.id, "idle", task.model, task.turns, "");
        }
      }
      return { tasks: settled, roster, loading: false };
    });
  },

  reloadRoster: async () => {
    const id = get().workspaceId;
    if (!id) return;
    const roster = await listWorkspaceAgents(id).catch(() => [] as WorkspaceAgent[]);
    set((s) => (s.workspaceId === id ? { roster } : s));
  },

  setGroupBy: (groupBy) => set({ groupBy }),
  setQuery: (query) => set({ query }),
  toggleRoster: () => set((s) => ({ rosterOpen: !s.rosterOpen })),

  liveFor: (taskId) => (taskId ? (get().live[taskId] ?? EMPTY_LIVE) : EMPTY_LIVE),

  select: async (taskId) => {
    set({ selectedId: taskId });
    if (!taskId) return;
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task || get().live[taskId]?.loaded) return;
    // Mark it loaded up front so a second click while the read is in flight doesn't start another.
    set((s) => ({ live: { ...s.live, [taskId]: { ...(s.live[taskId] ?? EMPTY_LIVE), loaded: true } } }));

    const entries = await getChatConversation(task.project_id, task.conversation_id).catch(() => []);
    // One stored row is one exchange, so both halves carry its timestamp — the question was never
    // recorded separately, and splitting hairs there would mean inventing a time.
    const messages: ChatMessage[] = entries.flatMap((entry) => [
      { role: "user" as const, content: entry.question, createdAt: entry.created_at },
      {
        role: "assistant" as const,
        content: entry.answer,
        responseTimeMs: entry.response_time_ms ?? undefined,
        createdAt: entry.created_at,
        provider: entry.provider ?? undefined,
        model: entry.model ?? undefined,
        engineVersion: entry.engine_version ?? undefined,
        isError: entry.is_error,
        trace: parseTrace(entry.trace),
      },
    ]);
    const engineSession = entries.reduce<string | null>((last, e) => e.engine_session_id ?? last, null);
    set((s) => {
      const current = s.live[taskId] ?? EMPTY_LIVE;
      // Re-checked after the await: a turn could have been started while the read was in flight,
      // and the freshly loaded copy would clobber its optimistic message.
      if (current.sending || current.messages.length > 0) return s;
      return { live: { ...s.live, [taskId]: { ...current, messages, sessionId: engineSession, loaded: true } } };
    });
  },

  create: async ({ projectId, agent, goal }) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) throw new Error("no workspace");
    const task = await createAgentTask(
      workspaceId,
      projectId,
      agent.id,
      agent.name,
      agent.provider,
      agent.model,
      agent.prompt,
      goal,
      taskTitleFrom(goal),
    );
    // Newest first, matching the backend's ordering so the list doesn't reshuffle on next load.
    set((s) => ({
      tasks: [task, ...s.tasks],
      selectedId: task.id,
      live: { ...s.live, [task.id]: { ...EMPTY_LIVE, loaded: true } },
    }));
    return task;
  },

  runningInProject: (projectId, exceptTaskId) => {
    const { tasks, live } = get();
    return (
      tasks.find(
        (task) => task.project_id === projectId && task.id !== exceptTaskId && (live[task.id]?.sending ?? false),
      ) ?? null
    );
  },

  adopt: (task) =>
    set((s) => {
      if (s.tasks.some((candidate) => candidate.id === task.id)) return s;
      return {
        tasks: [task, ...s.tasks],
        live: { ...s.live, [task.id]: { ...EMPTY_LIVE, loaded: true } },
      };
    }),

  send: (taskId, message) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if ((get().live[taskId] ?? EMPTY_LIVE).sending) return;
    // One agent at a time per repository. Two runs on one working copy would edit the same files
    // with independent restore points and race over the per-workspace MCP config the CLI reads.
    // The backend takes a real lease on the folder, which is what actually enforces this; refusing
    // here as well is what keeps the user from watching a send bounce.
    if (get().runningInProject(task.project_id, taskId)) return;
    // Losing the race to the backend's lease is rare but real — another window of this app, or a
    // chain that claimed the folder a moment ago. It is not a failure and the turn never ran, so
    // it is said once, quietly, rather than filed in the transcript.
    void get().runTurn(taskId, trimmed, {
      onSettle: (outcome) => {
        if (outcome.kind === "error" && outcome.busy) {
          pushErrorToast(translate("agents.busyInRepo", { name: busyRepoName(outcome.message) }));
        }
      },
    });
  },

  /**
   * The turn itself, with none of `send`'s guards.
   *
   * **It always settles**: exactly one `onSettle` fires for every call, and the returned promise
   * never rejects. That is the contract the chain scheduler is built on — a silent early return
   * here would leave a step marked `running` on disk with nothing left to finish it.
   */
  runTurn: async (taskId, message, opts) => {
    const trimmed = message.trim();
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task || !trimmed) {
      opts?.onSettle?.({ kind: "error", message: "task not found", busy: false });
      return;
    }
    const current = get().live[taskId] ?? EMPTY_LIVE;

    const runId = opts?.runId ?? newRunId("agent");
    // Before the invoke, or the first lines the engine prints have nowhere to land.
    useAiRunStore.getState().start(runId);
    const startedAt = Date.now();

    set((s) => ({
      live: {
        ...s.live,
        [taskId]: {
          ...current,
          // Stamped client-side: the turn isn't persisted until the reply lands, and the question
          // was asked now, not whenever the engine finishes answering it.
          messages: [...current.messages, { role: "user", content: trimmed, createdAt: new Date().toISOString() }],
          sending: true,
          runId,
          runStartedAt: startedAt,
          loaded: true,
        },
      },
      tasks: s.tasks.map((candidate) =>
        candidate.id === taskId ? { ...candidate, status: "running" as const } : candidate,
      ),
    }));

    /** Writes the outcome into *this* task, wherever the user happens to be looking. The selection
     * is never touched here — moving the pane out from under someone because a background answer
     * arrived is the whole reason this is fire-and-forget.
     *
     * `patchRow` is handed the row as it is **now**, not the copy captured when the turn started.
     * A turn takes minutes, and the row can move underneath it: picking a different model from the
     * composer mid-run writes to the row, and patching from the stale copy would quietly put the
     * old model back — on screen and on disk. The same read decides what is persisted, so the two
     * can't disagree. */
    const settle = (
      patchLive: (live: AgentTaskLive) => AgentTaskLive,
      patchRow: (row: AgentTask) => AgentTask,
    ) => {
      let persisted: AgentTask | null = null;
      set((s) => {
        const currentLive = s.live[taskId];
        // No live entry means the task was deleted while it ran; there is nothing to file under.
        if (!currentLive) return s;
        // The row being absent is *not* the same thing: `setWorkspace` empties `tasks` while
        // deliberately keeping the turns still in flight, so a reply landing after the user
        // switched workspace finds a live entry and no row. It still has to settle — bailing here
        // left the entry `sending` forever, which kept the spinner up, held this repository's only
        // slot until a restart, and never recorded the turn. The copy captured when the turn
        // started is the right fallback in exactly that case: the row is off-screen, so nothing
        // could have edited it in the meantime.
        const currentRow = s.tasks.find((candidate) => candidate.id === taskId);
        persisted = patchRow(currentRow ?? task);
        return {
          live: { ...s.live, [taskId]: patchLive(currentLive) },
          tasks: currentRow
            ? s.tasks.map((candidate) => (candidate.id === taskId ? persisted! : candidate))
            : s.tasks,
        };
      });
      if (persisted) {
        const row: AgentTask = persisted;
        void updateAgentTaskRun(taskId, row.status, row.model, row.turns, row.last_error);
      }
    };

    await sendChatMessage(task.project_id, trimmed, current.sessionId, task.conversation_id, runId, {
      id: task.agent_id,
      provider: task.provider,
      model: task.model,
      prompt: task.prompt,
    })
      .then((reply) => {
        // The live log is already in memory and formatted; attaching it to the message is what
        // keeps "what did it actually do?" answerable after the run ends.
        const trace = useAiRunStore.getState().linesFor(runId);
        settle(
          (live) => ({
            ...live,
            messages: [
              ...live.messages,
              {
                role: "assistant",
                content: reply.text,
                responseTimeMs: reply.response_time_ms,
                createdAt: reply.created_at,
                provider: reply.provider,
                model: reply.model ?? undefined,
                engineVersion: reply.engine_version ?? undefined,
                trace: trace.length > 0 ? trace : undefined,
              },
            ],
            sessionId: reply.session_id,
            sending: false,
            runId: null,
            runStartedAt: null,
          }),
          (row) => ({
            ...row,
            status: "idle",
            // The engine reports what it actually ran on; a blank reply means it never said, so
            // whatever the row points at now stands.
            model: reply.model ?? row.model,
            turns: row.turns + 1,
            last_error: "",
            updated_at: reply.created_at,
          }),
        );
        opts?.onSettle?.({
          kind: "ok",
          text: reply.text,
          model: reply.model,
          createdAt: reply.created_at,
        });
      })
      .catch((e: unknown) => {
        const cancelled = isCancellation(e);
        const trace = useAiRunStore.getState().linesFor(runId);

        // The repository was already taken, so this turn never reached an engine: nothing was
        // recorded, nothing was edited, no restore point was taken. Treating it as a failure would
        // put a red bubble in the transcript for something that did not happen — so the optimistic
        // question is rolled back instead and the caller decides how to say "not now".
        if (isRepoBusy(e)) {
          set((s) => {
            const entry = s.live[taskId];
            if (!entry) return s;
            return {
              live: {
                ...s.live,
                [taskId]: {
                  ...entry,
                  messages: entry.messages.slice(0, -1),
                  sending: false,
                  runId: null,
                  runStartedAt: null,
                },
              },
              tasks: s.tasks.map((candidate) =>
                candidate.id === taskId ? { ...candidate, status: task.status } : candidate,
              ),
            };
          });
          opts?.onSettle?.({ kind: "error", message: String(e), busy: true });
          return;
        }

        const status: AgentTaskStatus = cancelled ? "cancelled" : "error";
        const lastError = cancelled ? "" : String(e);
        settle(
          (live) => ({
            ...live,
            // The failure joins the transcript rather than sitting in a banner the next message
            // would wipe. Raw text is kept so the bubble can still re-derive a quota link.
            messages: [
              ...live.messages,
              cancelled
                ? { role: "assistant", content: "", isCancelled: true, createdAt: new Date().toISOString(), trace: trace.length > 0 ? trace : undefined }
                : { role: "assistant", content: String(e), isError: true, createdAt: new Date().toISOString(), trace: trace.length > 0 ? trace : undefined },
            ],
            sending: false,
            runId: null,
            runStartedAt: null,
          }),
          // A failed turn still counts: the backend records it in `activity_log` before returning
          // the error, so the transcript has a row filed under this task's project. Leaving `turns`
          // at zero would keep the repository selector unlocked and let the task be pointed
          // somewhere else, orphaning what was already written. A *stopped* turn is never written
          // to disk, so that one really is a non-event.
          (row) => ({
            ...row,
            status,
            turns: cancelled ? row.turns : row.turns + 1,
            last_error: lastError,
          }),
        );
        opts?.onSettle?.(
          cancelled ? { kind: "cancelled" } : { kind: "error", message: String(e), busy: false },
        );
      })
      .finally(() => {
        useAiRunStore.getState().finish(runId);
        // After the state is written, never before: a listener asking "is this repository free
        // now?" has to get the answer from after the run.
        notifyTurnSettled(task.project_id);
      });
  },

  stop: async (taskId) => {
    const runId = get().live[taskId]?.runId;
    if (!runId) return;
    await useAiRunStore.getState().cancel(runId);
  },

  setModel: async (taskId, model) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.model === model) return;
    set((s) => ({
      tasks: s.tasks.map((candidate) => (candidate.id === taskId ? { ...candidate, model } : candidate)),
    }));
    await updateAgentTaskRun(taskId, task.status, model, task.turns, task.last_error);
  },

  setProject: async (taskId, projectId) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    // The backend refuses this once the task has turns; refusing it here too keeps the select from
    // showing a repository the row never moved to.
    if (!task || task.turns > 0 || task.project_id === projectId) return;
    set((s) => ({
      tasks: s.tasks.map((candidate) =>
        candidate.id === taskId ? { ...candidate, project_id: projectId } : candidate,
      ),
    }));
    await setAgentTaskProject(taskId, projectId);
  },

  setStatus: async (taskId, status) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    set((s) => ({
      tasks: s.tasks.map((candidate) => (candidate.id === taskId ? { ...candidate, status } : candidate)),
    }));
    await updateAgentTaskRun(taskId, status, task.model, task.turns, task.last_error);
  },

  rename: async (taskId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => ({
      tasks: s.tasks.map((candidate) => (candidate.id === taskId ? { ...candidate, title: trimmed } : candidate)),
    }));
    await renameAgentTask(taskId, trimmed);
  },

  remove: async (taskId) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    // Stop it first. The live entry is the only place the run id exists, so dropping the task
    // while its turn is in flight would strand an engine that is still editing the working copy —
    // with no stop button left anywhere, and no longer counting against the one-run-per-repository
    // guard, so the next task in that repo could start on top of it.
    const runId = get().live[taskId]?.runId;
    if (runId) await useAiRunStore.getState().cancel(runId);
    set((s) => {
      const { [taskId]: _dropped, ...live } = s.live;
      return {
        tasks: s.tasks.filter((candidate) => candidate.id !== taskId),
        live,
        selectedId: s.selectedId === taskId ? null : s.selectedId,
      };
    });
    await deleteAgentTask(taskId);
    // The turns live in `activity_log`, which only cascades on project delete — without this the
    // task's transcript would outlive it and surface as an orphan conversation in the AI panel.
    await deleteChatConversation(task.project_id, task.conversation_id).catch(() => undefined);
  },
}));
