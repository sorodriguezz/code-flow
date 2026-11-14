/**
 * The run's channel: every plan, handoff, question, note, decision and piece of advice, in order.
 * Questions for you are answered right here; a note goes to everyone, the lead or one member.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Bookmark, GitMerge, Send } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { teamAmend, teamRemember } from "../../../lib/tauri/teamCommands";
import { pushErrorToast } from "../../../state/toastStore";
import type { TeamMessage, TeamRunState } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { SelectBox, Btn, Chip, ToggleChip, field } from "../kit/ui";
import { useL } from "../state";
import { MESSAGE_KIND } from "./look";
import { Markdown } from "../../common/Markdown";
import { ExternalTag } from "./SharedRun";
import { authorName } from "../../../lib/team/externalNotes";
import { readableTeamText } from "../../../lib/team/teamText";

function Message({ m, state, compact }: { m: TeamMessage; state: TeamRunState; compact?: boolean }) {
  const l = useL();
  const roster = useAgentsStore((s) => s.roster);
  const [answer, setAnswer] = useState("");
  const [memoryRepo, setMemoryRepo] = useState("");
  const [saving, setSaving] = useState(false);
  const itemRepo = state.items.find((item) => item.id === m.item_id)?.project_id;
  const targetRepo = itemRepo ?? (state.repos.length === 1 ? state.repos[0].project_id : memoryRepo);
  const remembered = state.memories?.some((memory) => memory.message_id === m.id && memory.project_id === targetRepo) ?? false;
  const canRemember = m.from_id !== "system" && (m.kind === "decision" || m.kind === "note" || (m.kind === "question" && Boolean(m.answered_at)));
  const remember = async () => {
    if (!targetRepo) return;
    setSaving(true);
    try {
      await teamRemember(m.run_id, m.id, targetRepo, !remembered);
      await useTeamStore.getState().refresh(m.run_id);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setSaving(false);
    }
  };
  const member = state.run.members.find((x) => x.id === m.from_id);
  const agent = roster.find((a) => a.id === member?.agent_id);
  const asking = m.kind === "question" && m.to_id === "user" && !m.answered_at;
  const fromUser = m.from_id === "user";
  const [kes, ken, tone] = MESSAGE_KIND[m.kind] ?? MESSAGE_KIND.note;
  const send = (text: string) => {
    if (!text.trim()) return;
    void useTeamStore.getState().answer(m.run_id, m.id, text.trim());
    setAnswer("");
  };

  if (m.kind === "status") {
    return (
      <p className="m-0 flex shrink-0 items-center gap-1.5 py-0.5 pl-9 text-[11px] text-[var(--cf-text-faint)]">
        <span className="h-1 w-1 rounded-full bg-[var(--cf-text-faint)]" />
        <b className="font-medium text-[var(--cf-text-muted)]">{m.from_name}</b> {m.body}
      </p>
    );
  }

  return (
    <motion.div layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`flex shrink-0 gap-2 ${fromUser ? "flex-row-reverse" : ""}`}>
      {member ? (
        <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={28} />
      ) : (
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-[9px] text-[10px] font-semibold ${fromUser ? "bg-[var(--cf-accent)] text-[var(--cf-on-accent)]" : "bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]"}`}>{fromUser ? l("Tú", "You") : <GitMerge className="h-3.5 w-3.5" />}</span>
      )}
      <div className={`min-w-0 max-w-[88%] rounded-[12px] border px-2.5 py-1.5 ${asking ? "cf-crew-waiting border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))]" : fromUser ? "border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)]" : "border-[var(--cf-border)] bg-[var(--cf-surface-raised)]"}`} style={{ ["--cf-crew-c" as string]: "var(--cf-warning)" }}>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <b>{fromUser ? l("Tú", "You") : authorName(m.from_name)}</b>
          <ArrowRight className="h-2.5 w-2.5 text-[var(--cf-text-faint)]" />
          <span className="text-[var(--cf-text-muted)]">{m.to_id === "user" ? l("ti", "you") : m.to_id === "all" ? l("todos", "everyone") : m.to_name}</span>
          <Chip tone={tone} title={l("Tipo de mensaje", "Message type")} className="!h-[18px] !px-1.5 !text-[10px]">{l(kes, ken)}</Chip>
          <ExternalTag fromName={m.from_name} />
          <span className="ml-auto text-[10px] text-[var(--cf-text-faint)]">{new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <Markdown source={readableTeamText(m.body)} className={`cf-markdown-chat cf-crew-msg mt-0.5 select-text break-words text-[12.5px] ${compact ? "line-clamp-6" : ""}`} />
        {m.answer && <p className="m-0 mt-1 border-l-2 border-[var(--cf-accent)] pl-2 text-[12px] text-[var(--cf-text-muted)]">{l("Respondida", "Answered")}: {m.answer}</p>}
        {canRemember && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {!itemRepo && state.repos.length > 1 && (
              <SelectBox value={memoryRepo} onChange={setMemoryRepo} ariaLabel={l("Repositorio de la memoria", "Memory repository")}>
                <option value="">{l("Elige repositorio", "Choose repository")}</option>
                {state.repos.map((repo) => <option key={repo.project_id} value={repo.project_id}>{repo.name}</option>)}
              </SelectBox>
            )}
            <Btn small icon={Bookmark} disabled={!targetRepo || saving} title={l("Este equipo puede usar el acuerdo en otras corridas de ese repositorio", "This team can reuse the agreement in later runs of this repository")} onClick={() => void remember()}>
              {remembered ? l("Quitar de memoria", "Remove from memory") : l("Recordar acuerdo", "Remember agreement")}
            </Btn>
          </div>
        )}
        {asking && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {m.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {m.options.map((o) => (
                  <button key={o} type="button" title={l("Responde con esta opción", "Answer with this option")} onClick={() => send(o)} className="h-[26px] rounded-full border border-[var(--cf-border-strong)] bg-[var(--cf-surface)] px-2.5 text-[12px] hover:border-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]">
                    {o}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <input value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(answer)} placeholder={l("Tu respuesta…", "Your answer…")} className={`${field} h-[28px]`} />
              <Btn small kind="primary" title={l("Envía tu respuesta a quien preguntó", "Sends your answer to whoever asked")} disabled={!answer.trim()} onClick={() => send(answer)}>{l("Responder", "Answer")}</Btn>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/** `memberId` narrows it to what one member said or was told — the member's chat uses it. */
export function Channel({ state, memberId, compact }: { state: TeamRunState; memberId?: string; compact?: boolean }) {
  const l = useL();
  const { run } = state;
  const [to, setTo] = useState(memberId ?? "all");
  const [body, setBody] = useState("");
  const [filter, setFilter] = useState<"all" | "you" | "talk">("all");
  const end = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => {
    let list = state.messages;
    if (memberId) list = list.filter((m) => m.from_id === memberId || m.to_id === memberId || (m.to_id === "lead" && memberId === run.lead) || m.to_id === "all");
    if (filter === "you") list = list.filter((m) => m.to_id === "user" || m.from_id === "user");
    if (filter === "talk") list = list.filter((m) => m.kind !== "status");
    return list;
  }, [state.messages, memberId, filter, run.lead]);
  const waiting = state.messages.filter((m) => m.kind === "question" && m.to_id === "user" && !m.answered_at).length;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const send = () => {
    if (!body.trim()) return;
    void useTeamStore.getState().note(run.id, to, body.trim());
    setBody("");
  };
  const live = run.status === "running" || run.status === "gated" || run.status === "paused";
  const [asking, setAsking] = useState(false);
  const canAmend = !memberId && !!run.lead && (run.status === "running" || run.gate === "merge")
    && state.items.some((item) => item.kind === "plan" && item.status === "done")
    && !state.items.some((item) => item.kind === "amend" && ["pending", "running", "waiting", "gated"].includes(item.status));
  const amend = async () => {
    if (!body.trim() || asking) return;
    setAsking(true);
    try {
      await teamAmend(run.id, body.trim());
      setBody("");
      await useTeamStore.getState().refresh(run.id);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setAsking(false);
    }
  };
  const followUp = async () => {
    if (!body.trim() || asking) return;
    setAsking(true);
    const id = await useTeamStore.getState().followUp(run.id, body.trim());
    setAsking(false);
    if (id) setBody("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!memberId && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1.5">
          <ToggleChip title={l("Muestra todos los mensajes del canal", "Shows every message in the channel")} on={filter === "all"} onClick={() => setFilter("all")}>{l("Todo", "All")}</ToggleChip>
          <ToggleChip title={l("Solo lo que se dicen los miembros", "Only what members say to each other")} on={filter === "talk"} onClick={() => setFilter("talk")}>{l("Conversación", "Talk")}</ToggleChip>
          <ToggleChip title={l("Solo lo que te piden o te dicen a ti", "Only what is asked of or said to you")} on={filter === "you"} onClick={() => setFilter("you")}>
            {l("Contigo", "With you")}
            {waiting > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-[var(--cf-warning)] px-1 text-[10px] text-white">{waiting}</span>}
          </ToggleChip>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-2.5 py-2.5">
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <Message key={m.id} m={m} state={state} compact={compact} />
          ))}
        </AnimatePresence>
        {messages.length === 0 && <span className="p-3 text-center text-[12px] text-[var(--cf-text-muted)]">{l("Nada todavía.", "Nothing yet.")}</span>}
        <div ref={end} />
      </div>
      {live && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[var(--cf-border)] p-2">
          {!memberId && (
            <SelectBox value={to} onChange={(v) => setTo(v)} ariaLabel={l("Para", "To")} title={l("Elige quién recibe tu nota", "Choose who receives your note")} className="w-[120px] shrink-0">
              <option value="all">{l("Todos", "Everyone")}</option>
              {run.lead && <option value="lead">{l("Líder", "Lead")}</option>}
              {run.members.filter((m) => m.id !== run.lead).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </SelectBox>
          )}
          <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={memberId ? l("Una nota para este miembro…", "A note for this member…") : l("Escribe una nota o un cambio al encargo…", "Write a note or a change to the request…")} className={`${field} h-[30px] min-w-[90px] flex-1`} />
          <button type="button" title={l("Envía la nota al equipo", "Sends the note to the team")} aria-label={l("Enviar", "Send")} disabled={!body.trim()} onClick={send} className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] bg-[var(--cf-accent)] text-[var(--cf-on-accent)] disabled:opacity-40">
            <Send className="h-3.5 w-3.5" />
          </button>
          {canAmend && <Btn small disabled={!body.trim() || asking} onClick={() => void amend()}
            title={l("Pide al líder un ajuste revisable de esta corrida", "Ask the lead for a reviewable change to this run")}>{l("Ajustar plan", "Amend plan")}</Btn>}
        </div>
      )}
      {!live && !memberId && (
        <div className="flex shrink-0 flex-col gap-1 border-t border-[var(--cf-border)] p-2">
          <span className="px-0.5 text-[11px] text-[var(--cf-text-faint)]">{l("Esta corrida terminó. Lo que escribas abre una de seguimiento con el mismo equipo, partiendo de lo que ya se integró.", "This run is over. What you write opens a follow-up run with the same team, starting from what was merged.")}</span>
          <div className="flex items-end gap-1.5">
            <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void followUp())} placeholder={l("Pídele algo más al equipo…", "Ask the team for something else…")} className={`${field} h-auto min-h-[52px] resize-y py-1.5`} />
            <Btn kind="primary" icon={Send} disabled={!body.trim() || asking} title={l("Abre una corrida de seguimiento con este pedido", "Opens a follow-up run with this request")} onClick={() => void followUp()}>{l("Seguir", "Follow up")}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
