/**
 * A conversation with one agent, as its floating window draws it: who it is and where it works in
 * the header — which is the window's handle — and under it the very transcript and composer the
 * task has in the Agents view (`TaskConversation`), so nothing about a turn differs between them.
 *
 * The conversation is a task with no goal (`lib/agents/talk`). What the full task sheet adds — the
 * review of what the agent changed, its repository, its plan — is one button away, in Agents.
 */
import { useEffect, useMemo, useRef, type HTMLAttributes, type ReactNode } from "react";
import { MessageSquarePlus, PanelsTopLeft, X } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useLanguageStore } from "../../../state/languageStore";
import { showingTeamChat, useTeamChatWindowStore } from "../../../state/teamChatWindowStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import type { TeamChatSummary } from "../../../lib/tauri/teamCommands";
import { agentChats, chatWithAgent, conversationName, openAgentChat, showAgentsView } from "../../../lib/agents/talk";
import { TaskConversation } from "../../agents/AgentTaskDetail";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { iconButtonClass } from "../../common/Button";
import { AgentAvatar } from "../kit/Avatar";
import { shortModel } from "../kit/modelName";
import { useCrewStore, useL } from "../state";
import { nextChat, TeamChatHistory } from "./TeamChatHistory";

export function AgentChatContent({ taskId, onClose, controls, grip, shown = true }: {
  taskId: string;
  onClose?: () => void;
  controls?: ReactNode;
  grip?: HTMLAttributes<HTMLDivElement>;
  shown?: boolean;
}) {
  const l = useL();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === taskId) ?? null);
  const agent = useAgentsStore((s) => (task ? s.roster.find((candidate) => candidate.id === task.agent_id) ?? null : null));
  const tasks = useAgentsStore((s) => s.tasks);
  const busy = useAgentsStore((s) => (s.live[taskId]?.sending ?? false) || task?.status === "running");
  const repo = useWorkspaceStore((s) => (task ? ((s.projectsByWorkspace[task.workspace_id] ?? []).find((p) => p.id === task.project_id)?.name ?? "") : ""));
  const head = useRef<HTMLDivElement>(null);
  // Whoever decides if a finished turn must be announced asks whether this is in sight.
  useEffect(() => (shown && head.current ? showingTeamChat(taskId, head.current) : undefined), [taskId, shown]);
  // A window reopened on a conversation this session has not read yet.
  useEffect(() => void useAgentsStore.getState().ensureLoaded(taskId), [taskId]);

  const agentId = task?.agent_id ?? "";
  const lang = useLanguageStore((s) => s.language);
  const history = useMemo<TeamChatSummary[]>(
    () => agentChats(tasks, agentId).map((item) => ({ id: item.id, title: conversationName(item, lang), createdAt: item.updated_at, messages: item.turns })),
    [tasks, agentId, lang],
  );
  if (!task) return null;

  const name = agent?.name ?? task.agent_name;
  const remove = async (item: TeamChatSummary) => {
    const next = item.id === taskId ? nextChat(history, item.id) : undefined;
    // The window turns to another of the agent's conversations before this one goes, or closes.
    if (item.id === taskId) useTeamChatWindowStore.getState().drop(item.id, next);
    if (next) void useAgentsStore.getState().ensureLoaded(next);
    await useAgentsStore.getState().remove(item.id);
    return true;
  };
  const fresh = () => {
    if (agent) void chatWithAgent(agent, true);
  };
  const toSheet = () => {
    // The whole task — what it changed, its repository, its plan — is the Agents view's.
    showAgentsView();
    useCrewStore.getState().open({ kind: "task", id: taskId });
    const win = useTeamChatWindowStore.getState().windows.find((w) => w.kind === "agent" && w.chatId === taskId);
    if (win) useTeamChatWindowStore.getState().minimize(win.key);
  };
  // One conversation nobody has written in is nothing to go to nor to delete.
  const manage = history.length > 1 || history.some((item) => item.messages > 0);

  return (
    <>
      <div
        ref={head}
        {...grip}
        className={`@container flex shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-4 py-3 ${grip ? "cursor-grab touch-none select-none active:cursor-grabbing" : ""}`}
      >
        <AgentAvatar agent={{ id: task.agent_id || task.id, icon: agent?.icon, color: agent?.color }} size={32} state={busy ? "thinking" : "idle"} />
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px]">{name}</b>
          {busy ? (
            <span className="block truncate text-[11.5px] font-medium text-[var(--cf-accent)]">{l("Trabajando…", "Working…")}</span>
          ) : (
            <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-[var(--cf-text-muted)]">
              <ProviderGlyph providerId={task.provider} size={11} className="shrink-0" />
              <span className="truncate">{[shortModel(task.model), repo].filter(Boolean).join(" · ")}</span>
            </span>
          )}
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">
          {manage && (
            <TeamChatHistory
              agent
              chatId={taskId}
              items={history}
              busy={busy}
              compact={Boolean(controls)}
              onPick={(id) => {
                const picked = tasks.find((candidate) => candidate.id === id);
                if (picked) openAgentChat(picked);
              }}
              onNew={fresh}
              onDelete={remove}
            />
          )}
          <button
            type="button"
            onClick={toSheet}
            title={l("Abrir la tarea completa en Agentes: revisar lo que cambió, su repositorio y su plan", "Open the whole task in Agents: review what it changed, its repository and its plan")}
            aria-label={l("Abrir la tarea completa en Agentes", "Open the whole task in Agents")}
            className={iconButtonClass({ size: "sm" })}
          >
            <PanelsTopLeft className="h-4 w-4" />
          </button>
          {agent && (
            <span className={controls && manage ? "hidden shrink-0 @[440px]:inline-flex" : "inline-flex shrink-0"}>
              <button type="button" onClick={fresh} title={l(`Nueva conversación con ${name}`, `New conversation with ${name}`)} aria-label={l(`Nueva conversación con ${name}`, `New conversation with ${name}`)} className={iconButtonClass({ size: "sm" })}>
                <MessageSquarePlus className="h-4 w-4" />
              </button>
            </span>
          )}
        </div>
        {controls && <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--cf-border)]" />}
        {controls}
        {onClose && (
          <button type="button" onClick={onClose} title={l("Cerrar", "Close")} aria-label={l("Cerrar el chat con el agente", "Close the chat with the agent")} className={iconButtonClass({ size: "sm" })}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <TaskConversation taskId={taskId} />
    </>
  );
}
