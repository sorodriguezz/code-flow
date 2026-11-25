/**
 * «Miembros»: one lane per member, side by side — what it is doing this second (its live log),
 * what waits for it, and what it already handed over. A lane opens the member's chat.
 */
import { Hourglass, Link2Off, MessageSquare, RotateCw, ShieldCheck, SquareTerminal } from "lucide-react";
import { SeatTag } from "./SharedRun";
import { useAgentsStore } from "../../../state/agentsStore";
import { AiRunLog } from "../../ai/AiRunLog";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { INFRA_PROVIDER, type TeamRunState } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { Chip } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { ITEM_KIND, isWorking, itemLook, since } from "./look";

export function Lanes({ state, onOpenItem }: { state: TeamRunState; onOpenItem: (id: string) => void }) {
  const l = useL();
  const crew = useCrewStore();
  const live = useAgentsStore((s) => s.live);
  const roster = useAgentsStore((s) => s.roster);
  const { run } = state;

  return (
    <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto p-3">
      {run.members.map((m) => {
        const agent = roster.find((a) => a.id === m.agent_id);
        const mine = state.items.filter((i) => i.member_id === m.id);
        const running = mine.filter((i) => i.status === "running" || i.status === "waiting");
        const queued = mine.filter((i) => i.status === "pending" || i.status === "gated");
        const done = mine.filter((i) => ["done", "error", "skipped", "cancelled", "delegated"].includes(i.status)).reverse();
        return (
          <section key={m.id} className="flex w-[310px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface)]">
            <header className="flex items-center gap-2.5 border-b border-[var(--cf-border)] px-3 py-2.5">
              <AgentAvatar agent={{ id: m.agent_id, icon: m.icon || agent?.icon, color: m.color || agent?.color }} size={34} state={running.some(isWorking) ? "thinking" : running.length ? "waiting" : "idle"} />
              <span className="min-w-0 flex-1">
                <b className="block truncate text-[12.5px]">{m.name}</b>
                <span className="flex items-center gap-1 truncate text-[11px] text-[var(--cf-text-muted)]">
                  <ProviderGlyph providerId={m.provider} size={11} />
                  {m.model}
                  {m.effort ? ` · ${m.effort}` : ""}
                  {m.run_in === "terminal" && <SquareTerminal className="h-3 w-3" />}
                  <SeatTag runId={run.id} memberId={m.id} />
                </span>
              </span>
              <button type="button" onClick={() => crew.open({ kind: "chat", runId: run.id, memberId: m.id })} title={l("Su chat", "Its chat")} className="grid h-7 w-7 place-items-center rounded-[8px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-accent)]">
                <MessageSquare className="h-4 w-4" />
              </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-2.5">
              {running.map((i) => {
                const lv = i.task_id ? live[i.task_id] : undefined;
                const phase = i.status === "running" ? i.intelligence?.phase : "";
                const recovery = i.status === "waiting" ? i.intelligence?.recovery : null;
                // The card's frame says what is going on before a word is read: the accent is an
                // agent at work, a dashed outline a turn that has not started, blue the app
                // checking what the agent left.
                const frame = phase === "queued" || recovery
                  ? "border-dashed border-[var(--cf-border-strong)] bg-[var(--cf-surface-raised)]"
                  : phase === "verifying"
                    ? "border-[color-mix(in_oklab,var(--cf-blue)_40%,var(--cf-border))] bg-[color-mix(in_oklab,var(--cf-blue)_7%,var(--cf-surface))]"
                    : "border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)]";
                const at = recovery?.resume_at ? new Date(recovery.resume_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
                return (
                  <div key={i.id} className={`flex flex-col gap-1.5 rounded-[10px] border p-2 ${frame}`}>
                    <button type="button" title={l("Abre el detalle de esta tarea", "Opens this task's details")} onClick={() => onOpenItem(i.id)} className="truncate text-left text-[12px] font-semibold hover:underline">{i.title}</button>
                    {phase === "queued" ? (
                      <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]"><Hourglass className="h-3 w-3 shrink-0" />{l("En cola: espera un cupo para empezar.", "Queued: waiting for a slot to start.")}</span>
                    ) : phase === "verifying" ? (
                      <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-blue)]"><ShieldCheck className="h-3 w-3 shrink-0" />{l("Terminó. CodeFlow corre las pruebas.", "Finished. CodeFlow is running the tests.")}</span>
                    ) : recovery ? (
                      <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
                        <RotateCw className="h-3 w-3 shrink-0" />
                        {recovery.provider === INFRA_PROVIDER
                          ? l("CodeFlow prepara su carpeta de nuevo.", "CodeFlow is preparing its folder again.")
                          : at
                            ? l(`Espera a ${recovery.provider}: sigue a las ${at}.`, `Waiting on ${recovery.provider}: resumes at ${at}.`)
                            : l(`Espera a ${recovery.provider}: necesita que lo revises.`, `Waiting on ${recovery.provider}: it needs you.`)}
                      </span>
                    ) : i.status === "waiting" ? (
                      <span className="text-[11.5px] text-[var(--cf-warning)]">{l("Hizo una pregunta: mírala en el canal.", "It asked a question: see the channel.")}</span>
                    ) : lv?.sending && lv.runId ? (
                      <AiRunLog runId={lv.runId} running startedAt={lv.runStartedAt} density="panel" defaultOpen />
                    ) : (
                      <span className="text-[11.5px] text-[var(--cf-text-muted)]">{i.run_in === "terminal" ? l("Trabajando en su terminal, en el Taller.", "Working in its terminal, in the Workshop.") : l(`Arrancando · ${since(i.started_at)}`, `Starting · ${since(i.started_at)}`)}</span>
                    )}
                  </div>
                );
              })}
              {queued.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Le espera", "Up next")}</span>
                  {queued.map((i) => (
                    <button key={i.id} type="button" title={l("Abre el detalle de esta tarea", "Opens this task's details")} onClick={() => onOpenItem(i.id)} className="flex items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-left text-[12px] hover:bg-[var(--cf-hover)]">
                      {i.intelligence?.missing_deps?.length ? <Link2Off className="h-3 w-3 shrink-0 text-[var(--cf-warning)]" /> : <Hourglass className="h-3 w-3 shrink-0 text-[var(--cf-text-faint)]" />}
                      <span className="min-w-0 flex-1 truncate">{i.title}</span>
                      {i.status === "gated" && <Chip tone="warn" title={l("La tarea espera tu aprobación para seguir", "The task waits for your approval to go on")}>{l("tu OK", "your OK")}</Chip>}
                      {!!i.intelligence?.missing_deps?.length && <Chip tone="warn" title={l("Depende de una tarea que no existe en el plan: ábrela para decidir", "It depends on a task that is in no plan: open it to decide")}>{l("bloqueada", "blocked")}</Chip>}
                    </button>
                  ))}
                </div>
              )}
              {done.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Entregado", "Handed over")}</span>
                  {done.map((i) => {
                    const [es, en, tone] = itemLook(i);
                    const [kes, ken] = ITEM_KIND[i.kind];
                    return (
                      <button key={i.id} type="button" title={l("Abre el detalle de esta tarea", "Opens this task's details")} onClick={() => onOpenItem(i.id)} className="flex items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-left text-[12px] hover:bg-[var(--cf-hover)]">
                        <span className="min-w-0 flex-1 truncate">{i.title}</span>
                        <span className="text-[10.5px] text-[var(--cf-text-faint)]">{l(kes, ken)}</span>
                        <Chip tone={tone} title={l("Estado de la tarea", "Task status")}>{l(es, en)}</Chip>
                      </button>
                    );
                  })}
                </div>
              )}
              {mine.length === 0 && <span className="p-2 text-[12px] text-[var(--cf-text-muted)]">{m.advisor ? l("En guardia: aconseja antes del plan, ante errores repetidos y al cerrar.", "On watch: advises before the plan, on repeated errors and at the end.") : l("Aún sin trabajo en esta corrida.", "No work in this run yet.")}</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
