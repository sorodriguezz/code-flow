/**
 * Starting a conversation with a team or with one agent, from wherever the button is: the Agents
 * view, the assistant's panel, a chat's own header. Each opens a window that floats over the view
 * on screen (`crew/teams/TeamChatWindow`), so none of this needs the Agents view to be showing.
 *
 * Stores only — no component — so the panel can offer these without loading the chat itself.
 */
import type { AgentTask, WorkspaceAgent } from "../../types/domain";
import { useAgentsStore } from "../../state/agentsStore";
import { useLanguageStore } from "../../state/languageStore";
import { useTeamCallStore } from "../../state/teamCallStore";
import { useTeamChatStore } from "../../state/teamChatStore";
import { useTeamChatWindowStore } from "../../state/teamChatWindowStore";
import { pushErrorToast } from "../../state/toastStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

const say = (es: string, en: string) => (useLanguageStore.getState().language === "es" ? es : en);

/** The chat is the team's, in its workspace: the open repository only says where members prefer to
 *  work, and having none open is fine. It opens as the team's floating window, so the view behind
 *  it — the org chart, a run, the code — stays in sight and in use. */
export async function chatWithTeam(teamId: string, fresh = false, projectId: string | null = useWorkspaceStore.getState().activeProjectId): Promise<void> {
  try {
    const id = await useTeamChatStore.getState().open(teamId, projectId, fresh);
    useTeamChatWindowStore.getState().open(id, teamId);
  } catch (error) {
    pushErrorToast(String(error));
  }
}

/** Calls the team: a voice call with its agents, in a window of its own (`call/TeamCallWindow`).
 *  Like its chat, the call is the team's in its workspace; the open repository is a preference. */
export function callTeam(teamId: string, projectId: string | null = useWorkspaceStore.getState().activeProjectId): void {
  void useTeamCallStore.getState().start(teamId, projectId);
}

/**
 * Whether a task is a conversation with its agent rather than a job handed to it: started with
 * nothing to do, on its own — not a team's turn, a race or a chain's step — and not put away.
 */
export function isAgentChat(task: Pick<AgentTask, "goal" | "batch_id" | "archived">): boolean {
  return task.goal.trim() === "" && !(task.batch_id ?? "") && !task.archived;
}

/** The conversations held with `agentId`, the one last written in first. */
export function agentChats(tasks: AgentTask[], agentId: string): AgentTask[] {
  if (!agentId) return [];
  return tasks.filter((task) => task.agent_id === agentId && isAgentChat(task)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * What a conversation is called in the agent's list. Every one starts out named after the agent,
 * which tells none apart: until it is given a name of its own it goes by the day it was started.
 */
export function conversationName(task: Pick<AgentTask, "title" | "agent_name" | "created_at">, lang: string): string {
  const title = task.title.trim();
  const stock = [`Conversación con ${task.agent_name}`, `Chat with ${task.agent_name}`];
  if (title && !stock.includes(title)) return title;
  const day = new Date(task.created_at).toLocaleString(lang === "es" ? "es" : "en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return lang === "es" ? `Conversación del ${day}` : `Conversation of ${day}`;
}

/** Unfolds the agent's floating window on `task`, its conversation. */
export function openAgentChat(task: Pick<AgentTask, "id" | "agent_id" | "workspace_id">): void {
  useTeamChatWindowStore.getState().openAgent(task.id, task.agent_id, task.workspace_id);
  void useAgentsStore.getState().ensureLoaded(task.id);
}

/**
 * A conversation with one agent: a task with no goal, opened on its composer in the agent's
 * floating window. Everything the repository chat brings (context, memory, images) comes with it.
 *
 * It goes back to the last one held with that agent unless `fresh` asks for another. A new one
 * runs in the repository on screen — an agent has to have a folder to work in — so it needs one.
 */
export async function chatWithAgent(agent: WorkspaceAgent, fresh = false): Promise<void> {
  const agents = useAgentsStore.getState();
  // The tasks on record are the workspace's whose agents are being talked to.
  if (agents.workspaceId !== agent.workspace_id) await agents.setWorkspace(agent.workspace_id);
  if (!fresh) {
    const last = agentChats(useAgentsStore.getState().tasks, agent.id)[0];
    if (last) {
      openAgentChat(last);
      return;
    }
  }
  const projectId = useWorkspaceStore.getState().activeProjectId;
  if (!projectId) {
    pushErrorToast(say("Abre un repositorio para conversar con el agente.", "Open a repository to chat with the agent."));
    return;
  }
  try {
    const task = await useAgentsStore.getState().create({ projectId, agent, goal: "" });
    await useAgentsStore.getState().rename(task.id, say(`Conversación con ${agent.name}`, `Chat with ${agent.name}`));
    openAgentChat(task);
  } catch (error) {
    pushErrorToast(String(error));
  }
}

/** Brings the Agents view to the front — for what only it can show: the launcher, a run, the roster. */
export function showAgentsView(): void {
  useUiStore.getState().setActiveView("agents");
}
