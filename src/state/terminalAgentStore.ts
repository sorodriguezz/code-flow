import { create } from "zustand";
import { terminalAgentStates } from "../lib/tauri/commands";
import { onTerminalAgent } from "../lib/tauri/events";
import { AI_PROVIDERS } from "../lib/aiProviders";
import { isMainWindow } from "../lib/windowIdentity";
import { notify } from "./notificationStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { TerminalAgent } from "../types/domain";

/**
 * The agents running in the app's terminals, as the backend reads them (`agentstatus.rs`): one
 * snapshot per pty session, kept current by `terminal:agent`.
 *
 * Also the two things the rail needs that the backend cannot know:
 *
 * - **What the user has seen.** `seenAt` is when each session was last on screen; a line is unread
 *   while its turn started after that. Session-scoped, like the sessions themselves — a restart
 *   starts every shell afresh, so there is nothing to carry over.
 * - **What is on screen now** (`visible`), so a turn that ends where the user is looking does not
 *   also raise a notification about itself.
 */

interface TerminalAgentStoreState {
  agents: Record<string, TerminalAgent>;
  seenAt: Record<string, number>;
  /** Sessions whose card is the open one. */
  visible: string[];
  init: () => void;
  /** Marks these sessions seen, now. */
  ack: (sessions: readonly string[]) => void;
  setVisible: (sessions: readonly string[]) => void;
}

let started = false;

function agentLabel(provider: string | null): string {
  const found = AI_PROVIDERS.find((candidate) => candidate.id === provider);
  return found?.label ?? provider ?? "Agent";
}

export const useTerminalAgentStore = create<TerminalAgentStoreState>((set, get) => ({
  agents: {},
  seenAt: {},
  visible: [],

  init: () => {
    if (started) return;
    started = true;
    void terminalAgentStates()
      .then((list) => set((s) => ({ agents: { ...Object.fromEntries(list.map((agent) => [agent.session_id, agent])), ...s.agents } })))
      .catch(() => undefined);
    void onTerminalAgent((agent) => {
      const previous = get().agents[agent.session_id];
      set((s) => {
        const { [agent.session_id]: _old, ...rest } = s.agents;
        return { agents: agent.state ? { ...rest, [agent.session_id]: agent } : rest };
      });
      if (previous?.state === "working" && agent.state && agent.state !== "working") announce(agent);
    });
  },

  ack: (sessions) => {
    if (sessions.length === 0) return;
    const now = Date.now();
    set((s) => ({ seenAt: { ...s.seenAt, ...Object.fromEntries(sessions.map((id) => [id, now])) } }));
  },

  setVisible: (sessions) => {
    const current = get().visible;
    if (current.length === sessions.length && current.every((id, at) => id === sessions[at])) return;
    set({ visible: [...sessions] });
  },
}));

/** A turn that ended — finished, failed or stopped to ask — where the user is not looking. */
function announce(agent: TerminalAgent): void {
  // Once per machine, not once per window: every window follows the agents, only the main one tells.
  if (!isMainWindow()) return;
  const watching = useTerminalAgentStore.getState().visible.includes(agent.session_id) && !document.hidden;
  if (watching) return;
  const name = agentLabel(agent.agent);
  notify({
    source: "agents",
    workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
    target: { view: "agents" },
    titleKey: agent.state === "blocked" ? "notifications.terminalAgentAsks" : agent.state === "error" ? "notifications.terminalAgentFailed" : "notifications.terminalAgentDone",
    params: { name },
    status: agent.state === "error" ? "error" : agent.state === "blocked" ? "info" : "success",
    detail: (agent.prompt || agent.summary || agent.reply).slice(0, 160) || undefined,
  });
}

/** Starts following the terminals' agents from the app shell. Safe to call more than once. */
export function startTerminalAgents(): void {
  useTerminalAgentStore.getState().init();
}
