import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, MessageSquarePlus, X } from "lucide-react";
import { useTeamChatStore, teamChatBusy } from "../../../state/teamChatStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { pushErrorToast } from "../../../state/toastStore";
import { AgentComposer } from "../../agents/AgentTaskDetail";
import { ChatMessageBubble } from "../../chat/ChatMessageBubble";
import { AiRunLog } from "../../ai/AiRunLog";
import { iconButtonClass } from "../../common/Button";
import { Select } from "../../common/Select";
import { teamChatHistory, type TeamChatSummary } from "../../../lib/tauri/teamCommands";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { Drawer } from "../kit/ui";
import { lNow, useCrewStore, useL } from "../state";
import { scrollBehavior } from "../../../lib/motion";
import type { ChatAttachment } from "../../../lib/tauri/chatCommands";

export async function chatWithTeam(teamId: string, fresh = false, projectId = useWorkspaceStore.getState().activeProjectId): Promise<void> {
  if (!projectId) {
    pushErrorToast(lNow("Abre un repositorio para conversar con el equipo.", "Open a repository to chat with the team."));
    return;
  }
  try {
    const id = await useTeamChatStore.getState().open(teamId, projectId, fresh);
    useCrewStore.getState().open({ kind: "teamChat", id });
  } catch (error) { pushErrorToast(String(error)); }
}

export function TeamChatPane({ chatId }: { chatId: string }) {
  const l = useL();
  const close = useCrewStore((s) => s.close);
  return <Drawer onClose={close} width={820} label={l("Chat del equipo", "Team chat")}><TeamChatContent chatId={chatId} onClose={close} /></Drawer>;
}

/** Also used by an existing task opened in the workshop, so every entry point keeps coordination. */
export function TeamChatContent({ chatId, onClose }: { chatId: string; onClose?: () => void }) {
  const l = useL();
  const state = useTeamChatStore((s) => s.states[chatId]);
  const [loading, setLoading] = useState(!state);
  const [history, setHistory] = useState<TeamChatSummary[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const busy = teamChatBusy(state);
  useEffect(() => {
    let active = true;
    void useTeamChatStore.getState().refresh(chatId).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId]);
  // Events keep all windows current. Poll only while an exchange is running, also recovering an
  // event missed while this drawer was closed or its window was being reloaded.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void useTeamChatStore.getState().refresh(chatId), 2500);
    return () => window.clearInterval(timer);
  }, [chatId, busy]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: scrollBehavior() });
  }, [state?.messages.length, state?.chat.activeRunId]);
  const send = useCallback((text: string, files?: ChatAttachment[]) => useTeamChatStore.getState().send(chatId, text, files), [chatId]);
  const stop = useCallback(() => void useTeamChatStore.getState().cancel(chatId), [chatId]);

  const chat = state?.chat;
  const lead = chat?.members.find((m) => m.id === chat.leadId);
  const active = chat?.members.find((m) => m.id === chat.activeMemberId);
  useEffect(() => {
    if (!chat) return;
    let valid = true;
    void teamChatHistory(chat.teamId, chat.projectId).then((list) => { if (valid) setHistory(list); }).catch(() => {});
    return () => { valid = false; };
  }, [chat?.teamId, chat?.projectId, chatId, state?.messages.length]);
  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-4 py-3">
        <TeamAvatar size={32} />
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px]">{chat?.teamName ?? l("Chat del equipo", "Team chat")}</b>
          {chat && <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">{chat.projectName} · {l(`Lidera ${lead?.name ?? ""}`, `Led by ${lead?.name ?? ""}`)}</span>}
        </div>
        {history.length > 1 && <Select value={chatId} size="sm" ariaLabel={l("Historial de chats del equipo", "Team chat history")} className="max-w-[120px] sm:max-w-[200px]" onChange={(id) => useCrewStore.getState().open({ kind: "teamChat", id })} options={history.map((item) => ({ value: item.id, label: item.title || new Date(item.createdAt).toLocaleString() }))} />}
        {chat && <button type="button" disabled={busy} onClick={() => void chatWithTeam(chat.teamId, true, chat.projectId)} title={l("Nueva conversación con el equipo", "New conversation with the team")} className={iconButtonClass({ size: "sm" })}><MessageSquarePlus className="h-4 w-4" /></button>}
        {onClose && <button type="button" onClick={onClose} title={l("Cerrar", "Close")} aria-label={l("Cerrar chat del equipo", "Close team chat")} className={iconButtonClass({ size: "sm" })}><X className="h-4 w-4" /></button>}
      </div>
      {!state ? (
        <div className="grid flex-1 place-items-center p-6 text-[12.5px] text-[var(--cf-text-muted)]">{loading ? <Loader2 className="h-5 w-5 animate-spin" /> : l("No se pudo abrir la conversación.", "The conversation could not be opened.")}</div>
      ) : (
        <>
          <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="mx-auto w-full max-w-[760px] space-y-4">
              {state.messages.length === 0 && <div className="rounded-xl border border-dashed border-[var(--cf-border-strong)] p-5 text-[12.5px] leading-relaxed text-[var(--cf-text-muted)]">
                <MessageSquare className="mb-2 h-5 w-5 text-[var(--cf-accent)]" />
                <b className="block text-[var(--cf-text)]">{l("Conversa y trabaja con tu equipo", "Chat and work with your team")}</b>
                {l(`Escríbele a ${lead?.name ?? "tu líder"}: responderá directamente o elegirá al miembro indicado. Puedes hacer preguntas, adjuntar archivos y pedir que escriban o editen en ${chat?.projectName}.`, `Write to ${lead?.name ?? "your lead"}: they will answer directly or choose the right member. Ask questions, attach files, or ask the team to write and edit in ${chat?.projectName}.`)}
              </div>}
              {state.messages.map((message, index) => {
                const member = chat?.members.find((m) => m.id === message.memberId);
                return <div key={message.id}>
                  {message.role === "assistant" && <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
                    <AgentAvatar agent={{ id: member?.agent_id ?? message.memberId, icon: member?.icon, color: member?.color }} size={20} />
                    <b className="font-medium text-[var(--cf-text)]">{message.memberName}</b>
                    {message.memberId === chat?.leadId && <span>· {l("Líder", "Lead")}</span>}
                  </div>}
                  <ChatMessageBubble
                    message={{ ...message, traceId: message.traceId ?? undefined }}
                    stamp="compact"
                    actions={!busy && index === state.messages.length - 1 && message.role === "assistant" ? { onAnswer: send } : undefined}
                  />
                </div>;
              })}
              {busy && <div className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{chat?.status === "cancelling" ? l("Deteniendo al equipo…", "Stopping the team…") : active ? l(`${active.name} está trabajando…`, `${active.name} is working…`) : l("El líder está coordinando…", "The lead is coordinating…")}</div>}
              {busy && chat?.activeRunId && <AiRunLog runId={chat.activeRunId} running />}
              {chat?.error && <p role="status" className="rounded-lg border border-[var(--cf-border)] p-3 text-[12px] text-[var(--cf-text-muted)]">{chat.error}</p>}
            </div>
          </div>
          <AgentComposer key={state.task.id} taskId={state.task.id} onSend={send} onStop={stop} busy={busy} stopping={chat?.status === "cancelling"} activeRunId={chat?.activeRunId || null} showModel={false} />
        </>
      )}
    </>
  );
}
