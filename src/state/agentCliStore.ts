import { create } from "zustand";
import { agentCliAnswer, agentCliFocus } from "../lib/tauri/commands";
import { onAgentCliAsk, onAgentCliNotify, onAgentCliReview, type AgentCliAsk } from "../lib/tauri/events";
import { taskForCwd } from "../lib/agents/terminalTask";
import { isMainWindow } from "../lib/windowIdentity";
import { useAgentsStore } from "./agentsStore";
import { useTaskReviewStore } from "./taskReviewStore";
import { useToastStore } from "./toastStore";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * The window's half of `cf` — the command an agent runs inside one of this app's shells.
 *
 * Three things arrive from the endpoint (`src-tauri/src/agentcli.rs`) and one goes back:
 *
 * - `notify` becomes a line in the app, wherever the user is.
 * - `ask` becomes a question in front of them: Yes or No is the exit code, what they typed is what
 *   `cf ask` prints. Questions queue — several agents can ask at once (a race is several of them)
 *   and each shell is blocked on its own, so a second one must never take the first one's place.
 * - `review` opens the diff of the task that owns the folder the agent is standing in — the same
 *   match the terminal's own menu makes, so "my worktree" means one thing everywhere.
 * - and what the window has in focus goes the other way, so `cf status` can answer.
 *
 * One subscription set, in the main window only: the events reach every window because the endpoint
 * has no business knowing which one is the console.
 */

interface AgentCliState {
  /** The questions `cf ask` is waiting on, oldest first. The first is the one on screen. */
  asks: AgentCliAsk[];
  init: () => void;
  /** Answers the question on screen and shows the next. `yes` is what `cf` exits 0 on. */
  answer: (yes: boolean, text: string) => void;
}

let started = false;

export const useAgentCliStore = create<AgentCliState>((set, get) => ({
  asks: [],

  init: () => {
    if (started || !isMainWindow()) return;
    started = true;

    void onAgentCliNotify((text) => {
      // The agent's own words, said as the agent: a line from a process the user started, not an
      // event of the app's.
      useToastStore.getState().pushToast(text, "info");
    });

    void onAgentCliAsk((ask) => set((state) => ({ asks: [...state.asks, ask] })));

    void onAgentCliReview((cwd) => {
      const task = taskForCwd(useAgentsStore.getState().tasks, cwd);
      if (!task) return;
      // The request first — the pane reads it as it lands on the task — then the two moves that put
      // that pane on screen. See `taskReviewStore.openRequest`.
      useTaskReviewStore.getState().requestTab(task.id, "review");
      void useAgentsStore.getState().select(task.id);
      useUiStore.getState().setActiveView("agents");
    });

    // What `cf status` answers. Pushed on change rather than asked for, because the endpoint has no
    // way into the renderer: a subscription per store, each firing only when its own value moves.
    const report = () => {
      const workspace = useWorkspaceStore.getState();
      const agents = useAgentsStore.getState();
      const task = agents.tasks.find((candidate) => candidate.id === agents.selectedId) ?? null;
      void agentCliFocus(
        workspace.activeWorkspaceId ?? "",
        workspace.activeProject()?.name ?? "",
        task?.title ?? "",
      ).catch(() => undefined);
    };
    report();
    useWorkspaceStore.subscribe((state, previous) => {
      if (state.activeWorkspaceId !== previous.activeWorkspaceId || state.activeProjectId !== previous.activeProjectId) {
        report();
      }
    });
    useAgentsStore.subscribe((state, previous) => {
      if (state.selectedId !== previous.selectedId) report();
    });
  },

  answer: (yes, text) => {
    const [open, ...rest] = get().asks;
    if (!open) return;
    set({ asks: rest });
    void agentCliAnswer(open.id, yes, text).catch(() => undefined);
  },
}));

/** Starts the subscriptions from the app shell. Safe to call more than once — see `init`. */
export function startAgentCli(): void {
  useAgentCliStore.getState().init();
}
