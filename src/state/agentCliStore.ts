import { create } from "zustand";
import { agentCliAnswer, agentCliFocus } from "../lib/tauri/commands";
import { onAgentCliAsk, onAgentCliDone, onAgentCliNotify, onAgentCliOpen, onAgentCliReview, type AgentCliAsk } from "../lib/tauri/events";
import { focusEditorOn } from "../lib/editorIslands";
import { taskForCwd } from "../lib/agents/terminalTask";
import { isMainWindow } from "../lib/windowIdentity";
import { useAgentsStore } from "./agentsStore";
import { useTaskReviewStore } from "./taskReviewStore";
import { useToastStore } from "./toastStore";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";
import { translate } from "./languageStore";

/**
 * The window's half of `cf` — the command an agent runs inside one of this app's shells.
 *
 * What arrives from the endpoint (`src-tauri/src/agentcli.rs`), and the one thing that goes back:
 *
 * - `notify` becomes a line in the app, wherever the user is; `done` the same, said as an agent
 *   finishing (its card on the rail turns Done on the backend's side).
 * - `ask` becomes a question in front of them: Yes or No is the exit code, what they typed is what
 *   `cf ask` prints. The same queue carries `choose` (one of several answers), the guard's
 *   destructive commands, and every use of a saved credential (`secret`, `db`, `http`) — see
 *   `AgentAskModal`. Questions queue — several agents can ask at once (a race is several of them)
 *   and each shell is blocked on its own, so a second one must never take the first one's place.
 * - `review` opens the diff of the task that owns the folder the agent is standing in — the same
 *   match the terminal's own menu makes, so "my worktree" means one thing everywhere.
 * - `open` puts a project's file on screen in the editor, at a line.
 * - and what the window has in focus goes the other way, so `cf status` can answer.
 *
 * One subscription set, in the main window only: the events reach every window because the endpoint
 * has no business knowing which one is the console.
 */

interface AgentCliState {
  /** The questions `cf ask` is waiting on, oldest first. The first is the one on screen. */
  asks: AgentCliAsk[];
  init: () => void;
  /** Answers the question on screen and shows the next. `yes` is what `cf` exits 0 on; `always` is
   *  "allow in this terminal" where the question offered it. */
  answer: (yes: boolean, text: string, always?: boolean) => void;
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

    void onAgentCliDone(({ text }) => {
      const said = text.trim();
      useToastStore.getState().pushToast(said ? translate("agentcli.doneWith", { text: said }) : translate("agentcli.done"), "info");
    });

    void onAgentCliAsk((ask) => set((state) => ({ asks: [...state.asks, { ...ask, kind: ask.kind ?? "ask" }] })));

    void onAgentCliOpen(({ projectId, path, line }) => {
      void focusEditorOn(projectId).then(() => useUiStore.getState().openInEditor(path, line ?? undefined));
    });

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

  answer: (yes, text, always = false) => {
    const [open, ...rest] = get().asks;
    if (!open) return;
    set({ asks: rest });
    void agentCliAnswer(open.id, yes, text, always && open.always).catch(() => undefined);
  },
}));

/** Starts the subscriptions from the app shell. Safe to call more than once — see `init`. */
export function startAgentCli(): void {
  useAgentCliStore.getState().init();
}
