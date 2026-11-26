/**
 * How a call ends, in the same room: the minutes the lead wrote, and — when work was agreed —
 * the few seconds before the team starts on it, which the user can cut short or call off.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, ListChecks, Loader2, MessageSquareText, Play, Rocket } from "lucide-react";
import type { CallState } from "../../../lib/tauri/teamCallCommands";
import { agentColorVar } from "../../../lib/agents/agentColors";
import { followInMain } from "../../../lib/agents/talk";
import { openTeamChatWindow } from "../../../state/teamChatStore";
import { useTeamCallStore } from "../../../state/teamCallStore";
import { AgentAvatar } from "../kit/Avatar";
import { Btn } from "../kit/ui";
import { useL } from "../state";

/** The seconds left until `endsMs`, re-read as they pass. */
function useSecondsLeft(endsMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsMs === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [endsMs]);
  return endsMs === null ? 0 : Math.max(0, Math.ceil((endsMs - now) / 1000));
}

/** The ring that empties as the team is about to start. */
function Countdown({ seconds, of }: { seconds: number; of: number }) {
  const radius = 20;
  const around = 2 * Math.PI * radius;
  return (
    <span className="relative grid h-12 w-12 shrink-0 place-items-center">
      <svg viewBox="0 0 48 48" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="24" cy="24" r={radius} fill="none" stroke="var(--cf-border)" strokeWidth="3" />
        <circle cx="24" cy="24" r={radius} fill="none" stroke="var(--cf-accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray={around} strokeDashoffset={around * (1 - Math.min(1, seconds / of))} style={{ transition: "stroke-dashoffset 0.25s linear" }} />
      </svg>
      <b className="text-[15px] tabular-nums">{seconds}</b>
    </span>
  );
}

export function CallWrapUp({ call, onClose }: { call: CallState; onClose: () => void }) {
  const l = useL();
  const left = useSecondsLeft(call.phase === "countdown" ? call.countdownEndsMs : null);
  const wrap = call.wrap;
  const { startNow, cancelStart } = useTeamCallStore.getState();
  const openChat = () => {
    void openTeamChatWindow(call.chatId);
    onClose();
  };
  const seeRun = () => {
    if (call.runId) followInMain(call.workspaceId, { view: "agents", select: { kind: "teamRun", id: call.runId } });
    onClose();
  };

  if (call.phase === "closing" && !wrap) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center rounded-xl bg-[var(--cf-sunken)] p-6 text-center">
        <div>
          <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-[var(--cf-accent)]" />
          <b className="block text-[13.5px]">{l("El líder está escribiendo el acta…", "The lead is writing the minutes…")}</b>
          <span className="mt-1 block text-[12px] text-[var(--cf-text-muted)]">{l("Qué se acordó y quién hace qué.", "What was agreed and who does what.")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-[var(--cf-sunken)] px-4 py-3.5">
        {!wrap ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <CircleDashed className="mx-auto mb-2 h-5 w-5 text-[var(--cf-text-muted)]" />
              <b className="block text-[13.5px]">{l("La llamada terminó", "The call ended")}</b>
              <span className="mt-1 block max-w-[420px] text-[12px] text-[var(--cf-text-muted)]">{call.error || l("No se dijo nada, así que no hay nada que anotar.", "Nothing was said, so there is nothing to write down.")}</span>
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[720px] space-y-4">
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{l("Acta de la llamada", "Call minutes")}</div>
              {wrap.title && <b className="block text-[15px] leading-snug">{wrap.title}</b>}
              {wrap.summary && <p className="mt-1 text-[13px] leading-relaxed text-[var(--cf-text)]">{wrap.summary}</p>}
            </div>
            {wrap.tasks.length > 0 && (
              <section>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold"><ListChecks className="h-3.5 w-3.5 text-[var(--cf-accent)]" />{l("Lo que el equipo va a hacer", "What the team will do")}</h3>
                <ul className="space-y-1.5">
                  {wrap.tasks.map((task, index) => {
                    const seat = call.seats.find((s) => s.memberId === task.member);
                    return (
                      <li key={`${task.title}-${index}`} className="flex items-start gap-2.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2">
                        {seat
                          ? <AgentAvatar agent={{ id: seat.agentId, icon: seat.icon, color: seat.color }} size={26} className="mt-0.5" />
                          : <span className="mt-0.5 grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]"><CircleDashed className="h-3.5 w-3.5" /></span>}
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium leading-snug">{task.title}</span>
                          {task.detail && <span className="block text-[12px] leading-snug text-[var(--cf-text-muted)]">{task.detail}</span>}
                          <span className="mt-0.5 block text-[11px]" style={seat ? { color: agentColorVar(seat.color, seat.agentId) } : { color: "var(--cf-text-muted)" }}>
                            {seat ? seat.name : l("El líder lo asigna", "The lead assigns it")}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {wrap.decisions.length > 0 && (
              <section>
                <h3 className="mb-1 text-[12px] font-semibold">{l("Acuerdos", "Agreed")}</h3>
                <ul className="space-y-1 text-[12.5px] leading-relaxed">
                  {wrap.decisions.map((decision, index) => <li key={index} className="flex gap-2"><CheckCircle2 className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--cf-success)]" /><span>{decision}</span></li>)}
                </ul>
              </section>
            )}
            {wrap.open.length > 0 && (
              <section>
                <h3 className="mb-1 text-[12px] font-semibold">{l("Quedó sin decidir", "Left undecided")}</h3>
                <ul className="space-y-1 text-[12.5px] leading-relaxed text-[var(--cf-text-muted)]">
                  {wrap.open.map((item, index) => <li key={index} className="flex gap-2"><CircleDashed className="mt-[3px] h-3.5 w-3.5 shrink-0" /><span>{item}</span></li>)}
                </ul>
              </section>
            )}
            {call.error && <p role="alert" className="rounded-lg border border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-danger)_7%,var(--cf-surface))] px-3 py-2 text-[12px]">{call.error}</p>}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3.5 py-2.5">
        {call.phase === "closing" && (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--cf-accent)]" />
            <span className="min-w-0 flex-1 text-[12.5px]">{l("El líder está cerrando la llamada…", "The lead is closing the call…")}</span>
          </>
        )}
        {call.phase === "countdown" && (
          <>
            <Countdown seconds={left} of={8} />
            <span className="min-w-0 flex-1">
              <b className="block text-[13px]">{l(`El equipo empieza en ${left} s`, `The team starts in ${left} s`)}</b>
              <span className="block text-[11.5px] text-[var(--cf-text-muted)]">{l("Trabaja en ramas aparte y sigue pidiéndote las aprobaciones del equipo.", "It works on branches of its own and still asks for the team's approvals.")}</span>
            </span>
            <Btn onClick={cancelStart}>{l("Cancelar", "Cancel")}</Btn>
            <Btn kind="primary" icon={Play} onClick={startNow}>{l("Empezar ya", "Start now")}</Btn>
          </>
        )}
        {call.phase === "starting" && (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--cf-accent)]" />
            <span className="min-w-0 flex-1 text-[12.5px]">{l("Poniendo al equipo en marcha…", "Getting the team started…")}</span>
          </>
        )}
        {call.phase === "started" && (
          <>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--cf-success)_14%,var(--cf-surface))] text-[var(--cf-success)]"><Rocket className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <b className="block text-[13px]">{l("El equipo está trabajando", "The team is working")}</b>
              <span className="block text-[11.5px] text-[var(--cf-text-muted)]">{l("Lo acordado ya es una corrida: síguela en «En vivo».", "What was agreed is a run now: follow it under “Live”.")}</span>
            </span>
            <Btn onClick={onClose}>{l("Cerrar", "Close")}</Btn>
            <Btn kind="primary" onClick={seeRun}>{l("Ver la corrida", "See the run")}</Btn>
          </>
        )}
        {call.phase === "ended" && (
          <>
            <span className="min-w-0 flex-1 text-[12.5px] text-[var(--cf-text-muted)]">
              {wrap
                ? wrap.tasks.length > 0 ? l("El equipo no empezó. El acta y la conversación quedaron en el chat del equipo.", "The team did not start. The minutes and the conversation are in the team's chat.") : l("No se acordó trabajo. El acta y la conversación quedaron en el chat del equipo.", "No work was agreed. The minutes and the conversation are in the team's chat.")
                : l("Puedes volver a llamar cuando quieras.", "You can call again whenever you like.")}
            </span>
            {wrap && <Btn icon={MessageSquareText} onClick={openChat}>{l("Abrir en el chat", "Open in the chat")}</Btn>}
            <Btn kind="primary" onClick={onClose}>{l("Cerrar", "Close")}</Btn>
          </>
        )}
      </div>
    </div>
  );
}
