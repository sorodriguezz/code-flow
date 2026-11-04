/**
 * The run's channel: every plan, handoff, question, note, decision and piece of advice, in order.
 * Questions for you are answered right here; a note goes to everyone, the lead or one member.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Send } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useAgentsStore } from "../../../state/agentsStore";
import type { TeamMessage, TeamRunState } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { Btn, Chip, ToggleChip, field } from "../kit/ui";
import { useL } from "../state";
import { MESSAGE_KIND } from "./look";

function Message({ m, state, compact }: { m: TeamMessage; state: TeamRunState; compact?: boolean }) {
  const l = useL();
  const roster = useAgentsStore((s) => s.roster);
  const [answer, setAnswer] = useState("");
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
      <p className="m-0 flex items-center gap-1.5 py-0.5 pl-9 text-[11px] text-[var(--cf-text-faint)]">
        <span className="h-1 w-1 rounded-full bg-[var(--cf-text-faint)]" />
        <b className="font-medium text-[var(--cf-text-muted)]">{m.from_name}</b> {m.body}
      </p>
    );
  }

  return (
    <motion.div layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`flex gap-2 ${fromUser ? "flex-row-reverse" : ""}`}>
      {member ? (
        <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={28} />
      ) : (
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-[9px] text-[10px] font-semibold ${fromUser ? "bg-[var(--cf-accent)] text-[var(--cf-on-accent)]" : "bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]"}`}>{fromUser ? l("Tú", "You") : "·"}</span>
      )}
      <div className={`min-w-0 max-w-[88%] rounded-[12px] border px-2.5 py-1.5 ${asking ? "cf-crew-waiting border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))]" : fromUser ? "border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)]" : "border-[var(--cf-border)] bg-[var(--cf-surface-raised)]"}`} style={{ ["--cf-crew-c" as string]: "var(--cf-warning)" }}>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <b>{fromUser ? l("Tú", "You") : m.from_name}</b>
          <ArrowRight className="h-2.5 w-2.5 text-[var(--cf-text-faint)]" />
          <span className="text-[var(--cf-text-muted)]">{m.to_id === "user" ? l("ti", "you") : m.to_id === "all" ? l("todos", "everyone") : m.to_name}</span>
          <Chip tone={tone} className="!h-[18px] !px-1.5 !text-[10px]">{l(kes, ken)}</Chip>
          <span className="ml-auto text-[10px] text-[var(--cf-text-faint)]">{new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <p className={`m-0 mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed ${compact ? "line-clamp-6" : ""}`}>{m.body}</p>
        {m.answer && <p className="m-0 mt-1 border-l-2 border-[var(--cf-accent)] pl-2 text-[12px] text-[var(--cf-text-muted)]">{l("Respondida", "Answered")}: {m.answer}</p>}
        {asking && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {m.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {m.options.map((o) => (
                  <button key={o} type="button" onClick={() => send(o)} className="h-[26px] rounded-full border border-[var(--cf-border-strong)] bg-[var(--cf-surface)] px-2.5 text-[12px] hover:border-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]">
                    {o}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <input value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(answer)} placeholder={l("Tu respuesta…", "Your answer…")} className={`${field} h-[28px]`} />
              <Btn small kind="primary" disabled={!answer.trim()} onClick={() => send(answer)}>{l("Responder", "Answer")}</Btn>
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!memberId && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1.5">
          <ToggleChip on={filter === "all"} onClick={() => setFilter("all")}>{l("Todo", "All")}</ToggleChip>
          <ToggleChip on={filter === "talk"} onClick={() => setFilter("talk")}>{l("Conversación", "Talk")}</ToggleChip>
          <ToggleChip on={filter === "you"} onClick={() => setFilter("you")}>
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
        <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] p-2">
          {!memberId && (
            <select value={to} onChange={(e) => setTo(e.target.value)} className={`${field} h-[30px] w-[120px]`} aria-label={l("Para", "To")}>
              <option value="all">{l("Todos", "Everyone")}</option>
              {run.lead && <option value="lead">{l("Líder", "Lead")}</option>}
              {run.members.filter((m) => m.id !== run.lead).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}
          <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={memberId ? l("Una nota para este miembro…", "A note for this member…") : l("Una nota para el equipo…", "A note for the team…")} className={`${field} h-[30px]`} />
          <button type="button" aria-label={l("Enviar", "Send")} disabled={!body.trim()} onClick={send} className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] bg-[var(--cf-accent)] text-[var(--cf-on-accent)] disabled:opacity-40">
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
