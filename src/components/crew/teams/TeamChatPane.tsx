import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { ListPlus, Loader2, MessageSquare, MessageSquarePlus, Phone, X } from "lucide-react";
import { openTeamChatWindow, useTeamChatStore, teamChatBusy } from "../../../state/teamChatStore";
import { showingTeamChat } from "../../../state/teamChatWindowStore";
import { pushErrorToast } from "../../../state/toastStore";
import { AgentComposer } from "../../agents/AgentTaskDetail";
import { ChatMessageBubble } from "../../chat/ChatMessageBubble";
import { AiRunLog } from "../../ai/AiRunLog";
import { iconButtonClass } from "../../common/Button";
import { teamChatDraft, teamChatHistory, type TeamChatSummary } from "../../../lib/tauri/teamCommands";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { nextChat, TeamChatHistory } from "./TeamChatHistory";
import { Btn } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { callTeam, chatWithTeam, openInAgents } from "../../../lib/agents/talk";
import { scrollBehavior } from "../../../lib/motion";
import type { ChatAttachment } from "../../../lib/tauri/chatCommands";

// Where these live now, for whoever still asks for them here.
export { callTeam, chatWithTeam };

/**
 * A team conversation: its header, its messages and its composer.
 *
 * Drawn by the floating window and by an existing task opened in the workshop, so every entry
 * point keeps coordination. The window hands in what makes it a window: `grip` turns the header
 * into its handle, `controls` are its buttons, and `shown` is false while it is minimised — the
 * conversation stays mounted then, so a draft, the scroll and a turn in progress survive.
 */
export function TeamChatContent({ chatId, onClose, controls, grip, shown = true }: {
  chatId: string;
  onClose?: () => void;
  controls?: ReactNode;
  grip?: HTMLAttributes<HTMLDivElement>;
  shown?: boolean;
}) {
  const l = useL();
  const state = useTeamChatStore((s) => s.states[chatId]);
  const [loading, setLoading] = useState(!state);
  const [history, setHistory] = useState<TeamChatSummary[]>([]);
  const [preparing, setPreparing] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  /** Something arrived while this was folded away: go to it once it is back. */
  const behind = useRef(false);
  const busy = teamChatBusy(state);
  // Whoever decides if a finished turn must be announced asks whether this is in sight.
  useEffect(() => (shown && head.current ? showingTeamChat(chatId, head.current) : undefined), [chatId, shown]);
  useEffect(() => {
    let active = true;
    void useTeamChatStore.getState().refresh(chatId).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId]);
  // Events keep all windows current. Poll only while an exchange is running, also recovering an
  // event missed while this was closed or its window was being reloaded.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void useTeamChatStore.getState().refresh(chatId), 2500);
    return () => window.clearInterval(timer);
  }, [chatId, busy]);
  useEffect(() => {
    if (!shown) {
      behind.current = true;
      return;
    }
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: scrollBehavior() });
  }, [state?.messages.length, state?.chat.activeRunId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!shown || !behind.current) return;
    behind.current = false;
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [shown]);
  const send = useCallback((text: string, files?: ChatAttachment[]) => useTeamChatStore.getState().send(chatId, text, files), [chatId]);
  const stop = useCallback(() => void useTeamChatStore.getState().cancel(chatId), [chatId]);
  const convert = async () => {
    setPreparing(true);
    try {
      const draft = await teamChatDraft(chatId);
      // The launcher is the Agents view's, in the main window: this one comes forward on it.
      openInAgents(
        { kind: "launch" as const, goal: draft.goal, assignee: { kind: "team" as const, id: draft.teamId }, projectId: draft.projectId, attachments: draft.attachments },
        (overlay) => useCrewStore.getState().open(overlay),
      );
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setPreparing(false);
    }
  };

  const chat = state?.chat;
  const lead = chat?.members.find((m) => m.id === chat.leadId);
  // Where the team works: one name when everyone shares a repository, a count otherwise.
  const repoNames = chat ? [...new Set(Object.values(chat.memberRepos ?? {}).map((r) => r.name))] : [];
  const where = repoNames.length > 1 ? l(`${repoNames.length} repositorios`, `${repoNames.length} repositories`) : (repoNames[0] ?? chat?.projectName ?? "");
  const active = chat?.members.find((m) => m.id === chat.activeMemberId);
  const working = chat?.status === "cancelling" ? l("Deteniendo al equipo…", "Stopping the team…") : active ? l(`${active.name} está trabajando…`, `${active.name} is working…`) : l("El líder está coordinando…", "The lead is coordinating…");
  const teamId = chat?.teamId;
  useEffect(() => {
    if (!teamId) return;
    let valid = true;
    void teamChatHistory(teamId).then((list) => { if (valid) setHistory(list); }).catch(() => {});
    return () => { valid = false; };
  }, [teamId, chatId, state?.messages.length]);
  /** Deletes one of the team's conversations. Deleting the one on screen turns the window to the
   *  most recent of the others, and closes it when it was the last. */
  const remove = async (item: TeamChatSummary) => {
    const here = item.id === chatId;
    const done = await useTeamChatStore.getState().remove(item.id, here ? nextChat(history, item.id) : undefined);
    if (!done) return false;
    setHistory((list) => list.filter((entry) => entry.id !== item.id));
    // Not in a floating window (a task opened in the workshop): nothing else would close it.
    if (here && !nextChat(history, item.id)) onClose?.();
    return true;
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
        <TeamAvatar size={32} state={busy ? "thinking" : "idle"} />
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px]">{chat?.teamName ?? l("Chat del equipo", "Team chat")}</b>
          {chat && (busy
            ? <span className="block truncate text-[11.5px] font-medium text-[var(--cf-accent)]">{working}</span>
            : <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">{where} · {l(`Lidera ${lead?.name ?? ""}`, `Led by ${lead?.name ?? ""}`)}</span>)}
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">
          {/* In a window the team's name comes first: the history is down to its icon where it is narrow. */}
          {manage && <TeamChatHistory chatId={chatId} items={history} busy={busy} compact={Boolean(controls)} onPick={(id) => void openTeamChatWindow(id)} onNew={() => { if (chat) void chatWithTeam(chat.teamId, true); }} onDelete={remove} />}
          {state?.messages.some((message) => message.role === "user") && (
            <Btn small icon={ListPlus} disabled={busy || preparing} aria-label={l("Convertir en tarea", "Convert to task")} title={l("Convertir en tarea: abre el lanzador con el pedido, el contexto y los adjuntos del chat", "Convert to task: opens the launcher with the request, chat context and attachments")} onClick={() => void convert()}>
              <span className={controls ? "hidden @[640px]:inline" : ""}>{l("Convertir en tarea", "Convert to task")}</span>
            </Btn>
          )}
          {chat && <button type="button" onClick={() => callTeam(chat.teamId)} title={l("Llamar al equipo: habla con sus agentes por voz", "Call the team: talk to its agents by voice")} aria-label={l("Llamar al equipo", "Call the team")} className={iconButtonClass({ size: "sm" })}><Phone className="h-4 w-4" /></button>}
          {/* The menu offers it too: in a narrow window that is where it lives, so the team's name keeps its room. */}
          {chat && <span className={controls && manage ? "hidden shrink-0 @[440px]:inline-flex" : "inline-flex shrink-0"}><button type="button" disabled={busy} onClick={() => void chatWithTeam(chat.teamId, true)} title={l("Nueva conversación con el equipo", "New conversation with the team")} aria-label={l("Nueva conversación con el equipo", "New conversation with the team")} className={iconButtonClass({ size: "sm" })}><MessageSquarePlus className="h-4 w-4" /></button></span>}
        </div>
        {controls && <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--cf-border)]" />}
        {controls}
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
                {l(`Escríbele a ${lead?.name ?? "tu líder"}: responderá directamente o elegirá al miembro indicado. Puedes hacer preguntas, adjuntar archivos y pedir que escriban o editen en ${where}.`, `Write to ${lead?.name ?? "your lead"}: they will answer directly or choose the right member. Ask questions, attach files, or ask the team to write and edit in ${where}.`)}
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
                  {message.suggestRun && index === state.messages.length - 1 && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
                      {l("El líder propone llevar este encargo a una corrida.", "The lead suggests turning this request into a run.")}
                      <Btn small icon={ListPlus} disabled={busy || preparing} onClick={() => void convert()}>
                        {l("Revisar borrador de tarea", "Review task draft")}
                      </Btn>
                    </div>
                  )}
                </div>;
              })}
              {busy && <div className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{working}</div>}
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
