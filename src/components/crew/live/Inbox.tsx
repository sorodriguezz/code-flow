/**
 * «Te necesitan»: everything waiting on you, from every run, in one list — approve a plan, answer a
 * question, open a gated flow — without going run by run.
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, ExternalLink, Hand, MessageCircleQuestion, Workflow } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useChainStore } from "../../../state/chainStore";
import { recoveryNeedsUser, runIsLive, type TeamMessage, type TeamRun } from "../../../types/team";
import { Btn, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";

function gateTitle(run: TeamRun, l: (es: string, en: string) => string): string {
  if (run.gate.startsWith("impact:")) return l("Revisar cambios de impacto", "Review high-impact changes");
  if (run.gate.startsWith("amend:") || run.gate.startsWith("amend_failed:")) return l("Revisar ajuste del plan", "Review plan amendment");
  if (run.gate === "plan") return l("Aprobar el plan", "Approve the plan");
  if (run.gate === "merge") return l("Listo para integrar", "Ready to merge");
  if (run.gate === "budget") return l("Llegó al presupuesto", "Budget reached");
  if (run.gate.startsWith("stuck:")) return l("Se atascó", "It got stuck");
  return l("Espera tu OK", "Needs your OK");
}

function Question({ m }: { m: TeamMessage }) {
  const l = useL();
  const [text, setText] = useState("");
  const send = (answer: string) => answer.trim() && void useTeamStore.getState().answer(m.run_id, m.id, answer.trim());
  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 whitespace-pre-wrap text-[12.5px]">{m.body}</p>
      {m.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {m.options.map((o) => (
            <button key={o} type="button" onClick={() => send(o)} className="h-[26px] rounded-full border border-[var(--cf-border-strong)] px-2.5 text-[12px] hover:border-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]">{o}</button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(text)} placeholder={l("Tu respuesta…", "Your answer…")} className={`${field} h-[28px]`} />
        <Btn small kind="primary" disabled={!text.trim()} title={l("Envía tu respuesta", "Sends your answer")} onClick={() => send(text)}>{l("Responder", "Answer")}</Btn>
      </div>
    </div>
  );
}

export function Inbox({ onClose }: { onClose: () => void }) {
  const l = useL();
  const crew = useCrewStore();
  const runs = useTeamStore((s) => s.runs);
  const states = useTeamStore((s) => s.states);
  const chains = useChainStore((s) => s.chains);
  const box = useRef<HTMLDivElement>(null);
  const [comment, setComment] = useState<Record<string, string>>({});

  // A gated run this window has not opened yet has no state loaded: fetch it so its note shows.
  useEffect(() => {
    for (const run of runs) if ((run.status === "gated" || run.status === "running") && !states[run.id]) void useTeamStore.getState().refresh(run.id);
  }, [runs, states]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (box.current && !box.current.contains(target) && !target.closest("[data-inbox-toggle]")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const gated = runs.filter((r) => r.status === "gated");
  const questions = runs.flatMap((r) => (states[r.id]?.messages ?? []).filter((m) => m.kind === "question" && m.to_id === "user" && !m.answered_at).map((m) => ({ run: r, m })));
  const flows = chains.filter((c) => c.status === "gated");
  const recoveries = runs.filter(runIsLive).flatMap((run) => {
    const [first, ...others] = recoveryNeedsUser(states[run.id]);
    return first ? [{ run, first, count: 1 + others.length }] : [];
  });
  const open = (runId: string) => {
    crew.setSpace("en-vivo");
    void useTeamStore.getState().select(runId);
    onClose();
  };
  const empty = gated.length + questions.length + flows.length + recoveries.length === 0;

  return (
    <motion.div
      ref={box}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.12 }}
      className="absolute right-3 top-full z-40 mt-2 flex max-h-[min(560px,70vh)] w-[min(440px,92vw)] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2.5">
        <Hand className="h-4 w-4 text-[var(--cf-warning)]" />
        <b className="text-[13px]">{l("Te necesitan", "Waiting on you")}</b>
      </header>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2.5">
        {empty && <p className="m-0 p-3 text-center text-[12px] text-[var(--cf-text-muted)]">{l("Nada pendiente.", "Nothing pending.")}</p>}
        {gated.map((run) => {
          const note = states[run.id]?.run.gate_note ?? run.gate_note;
          const requiresReview = /^(impact|amend|amend_failed):/.test(run.gate);
          return (
            <section key={`g:${run.id}`} className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_6%,var(--cf-surface))] p-2.5">
              <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
                <b className="text-[12.5px] text-[var(--cf-text)]">{gateTitle(run, l)}</b>· <span className="min-w-0 flex-1 truncate">{run.title || run.goal} · {run.team_name}</span>
                <button type="button" title={l("Abre la corrida", "Opens the run")} onClick={() => open(run.id)} className="grid h-6 w-6 place-items-center rounded-md hover:bg-[var(--cf-hover)]"><ExternalLink className="h-3.5 w-3.5" /></button>
              </div>
              {note && <p className="m-0 line-clamp-4 whitespace-pre-wrap text-[12px]">{note}</p>}
              {requiresReview ? <Btn small onClick={() => open(run.id)}>{l("Revisar en la corrida", "Review in the run")}</Btn> : <>
                <input value={comment[run.id] ?? ""} onChange={(e) => setComment((c) => ({ ...c, [run.id]: e.target.value }))} placeholder={l("Comentario (opcional)", "Comment (optional)")} className={`${field} h-[28px]`} />
                <div className="flex justify-end gap-1.5">
                  <Btn small kind="ghost" onClick={() => void useTeamStore.getState().decide(run.id, false, comment[run.id] ?? "", run.gate)}>{l("No", "No")}</Btn>
                  <Btn small kind="primary" icon={CheckCircle2} onClick={() => void useTeamStore.getState().decide(run.id, true, comment[run.id] ?? "", run.gate)}>{l("Aprobar", "Approve")}</Btn>
                </div>
              </>}
            </section>
          );
        })}
        {questions.map(({ run, m }) => (
          <section key={`q:${m.id}`} className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--cf-border)] p-2.5">
            <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
              <MessageCircleQuestion className="h-3.5 w-3.5 text-[var(--cf-warning)]" />
              <b className="text-[12.5px] text-[var(--cf-text)]">{m.from_name}</b>· <span className="min-w-0 flex-1 truncate">{run.title || run.goal}</span>
              <button type="button" title={l("Abre la corrida", "Opens the run")} onClick={() => open(run.id)} className="grid h-6 w-6 place-items-center rounded-md hover:bg-[var(--cf-hover)]"><ExternalLink className="h-3.5 w-3.5" /></button>
            </div>
            <Question m={m} />
          </section>
        ))}
        {recoveries.map(({ run, first, count }) => (
          <section key={`provider:${run.id}`} className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--cf-warning)] p-2.5">
            <b className="text-[12.5px]">{run.title} · {l("Tareas esperando a un motor", "Tasks waiting on an engine")} ({count})</b>
            <p className="m-0 line-clamp-3 text-[12px]">{first.last_error}</p>
            <div className="flex justify-end gap-1">
              <Btn small onClick={() => open(run.id)}>{l("Ver corrida", "View run")}</Btn>
              {run.status === "running" && <Btn small onClick={() => void useTeamStore.getState().control(run.id, `retry:${first.id}`)}>{l("Reintentar", "Retry")}</Btn>}
            </div>
          </section>
        ))}
        {flows.map((c) => (
          <button key={`c:${c.id}`} type="button" onClick={() => { crew.open({ kind: "chain", id: c.id }); onClose(); }} className="flex items-center gap-2 rounded-[10px] border border-[var(--cf-border)] p-2.5 text-left hover:bg-[var(--cf-hover)]">
            <Workflow className="h-4 w-4 text-[var(--cf-warning)]" />
            <span className="min-w-0 flex-1 truncate text-[12.5px]">{c.title || c.goal}</span>
            <span className="text-[11px] text-[var(--cf-text-muted)]">{l("Espera tu OK", "Needs your OK")}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
