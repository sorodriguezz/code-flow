/**
 * The right side of a live run beyond the channel: what it costs against its budget and the
 * workspace's slots, what the watch noticed, what the decision layer settled (and saved), what the
 * advisor said, and who talks to whom.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Brain, Coins, Gauge, Lightbulb, MessagesSquare, Repeat, Snail, TrendingUp } from "lucide-react";
import { teamRunMetrics, teamRunPolicy } from "../../../lib/tauri/teamCommands";
import { decisionsForRun } from "../../../lib/tauri/crewCommands";
import { useTeamStore } from "../../../state/teamStore";
import { pushErrorToast } from "../../../state/toastStore";
import type { TeamAlert, TeamRunMetrics, TeamRunState } from "../../../types/team";
import type { DecisionRow } from "../../../types/crew";
import { AgentAvatar } from "../kit/Avatar";
import { useSlots } from "../kit/slots";
import { Btn, Chip, Label, Meter, Panel } from "../kit/ui";
import { compact, money, useCrewStore, useL } from "../state";

/** Re-read when the run moves, at most every 1.5 s. */
function useThrottled<T>(load: () => Promise<T>, stamp: string): T | null {
  const [value, setValue] = useState<T | null>(null);
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const run = () => {
      last.current = Date.now();
      void loader.current().then(setValue).catch(() => undefined);
    };
    const wait = 1500 - (Date.now() - last.current);
    if (wait <= 0) run();
    else {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(run, wait);
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [stamp]);
  return value;
}

export function useRunInsights(state: TeamRunState) {
  const stamp = `${state.run.id}:${state.run.updated_at}:${state.items.length}:${state.messages.length}:${state.items.filter((i) => i.status === "done").length}`;
  const metrics = useThrottled<TeamRunMetrics>(() => teamRunMetrics(state.run.id), stamp);
  const decisions = useThrottled<DecisionRow[]>(() => decisionsForRun(state.run.id, 60), stamp);
  return { metrics, decisions: decisions ?? [] };
}

function AlertRow({ alert, state }: { alert: TeamAlert; state: TeamRunState }) {
  const l = useL();
  const names = alert.members.map((id) => state.run.members.find((m) => m.id === id)?.name ?? id).join(" ↔ ");
  const raise = async () => {
    const p = state.run.policy;
    try {
      await teamRunPolicy(state.run.id, {
        ...p,
        budget_usd: p.budget_usd ? Math.round(p.budget_usd * 150) / 100 : 0,
        budget_tokens: p.budget_tokens ? Math.round(p.budget_tokens * 1.5) : 0,
        budget_minutes: p.budget_minutes ? Math.round(p.budget_minutes * 1.5) : 0,
      });
      void useTeamStore.getState().refresh(state.run.id);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  const info: Record<TeamAlert["kind"], { icon: typeof AlertTriangle; es: string; en: string; tone: "warn" | "bad" | "info" }> = {
    budget_warn: { icon: Coins, es: `Va en el ${Math.round(alert.value)}% del presupuesto`, en: `At ${Math.round(alert.value)}% of the budget`, tone: "warn" },
    budget_hit: { icon: Coins, es: "Llegó al tope del presupuesto", en: "Hit the budget cap", tone: "bad" },
    ping_pong: { icon: Repeat, es: `${names}: ${alert.value} idas y vueltas`, en: `${names}: ${alert.value} back-and-forths`, tone: "warn" },
    stalled: { icon: Snail, es: `${names}: ${Math.round(alert.value)} min sin avanzar`, en: `${names}: ${Math.round(alert.value)} min without progress`, tone: "warn" },
    idle: { icon: Snail, es: `${names} sin trabajo`, en: `${names} has no work`, tone: "info" },
  };
  const { icon: Icon, es, en, tone } = info[alert.kind];
  return (
    <div className="flex items-center gap-2 rounded-[9px] border border-[var(--cf-border)] px-2.5 py-1.5">
      <Icon className={`h-4 w-4 shrink-0 ${tone === "bad" ? "text-[var(--cf-danger)]" : tone === "warn" ? "text-[var(--cf-warning)]" : "text-[var(--cf-blue)]"}`} />
      <span className="min-w-0 flex-1 text-[12px]">{l(es, en)}</span>
      {(alert.kind === "budget_hit" || alert.kind === "budget_warn") && <Btn small title={l("Sube el tope de presupuesto un 50%", "Raises the budget cap by 50%")} onClick={() => void raise()}>{l("Subir ×1,5", "Raise ×1.5")}</Btn>}
    </div>
  );
}

function CommsMatrix({ metrics, state }: { metrics: TeamRunMetrics; state: TeamRunState }) {
  const l = useL();
  const members = state.run.members.filter((m) => metrics.edges.some((e) => e.from === m.id || e.to === m.id));
  const max = Math.max(1, ...metrics.edges.map((e) => e.count));
  if (members.length < 2) return <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Todavía no hablan entre ellos.", "They have not talked yet.")}</span>;
  return (
    <div className="overflow-auto">
      <table className="border-separate border-spacing-[3px] text-[10.5px]">
        <thead>
          <tr>
            <th />
            {members.map((m) => (
              <th key={m.id} title={m.name} className="w-6 font-normal text-[var(--cf-text-faint)]">
                <AgentAvatar agent={{ id: m.agent_id, icon: m.icon, color: m.color }} size={18} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {members.map((from) => (
            <tr key={from.id}>
              <th className="pr-1 text-left font-medium" title={from.name}>
                <span className="block max-w-[80px] truncate">{from.name}</span>
              </th>
              {members.map((to) => {
                const count = metrics.edges.find((e) => e.from === from.id && e.to === to.id)?.count ?? 0;
                return (
                  <td key={to.id} title={`${from.name} → ${to.name}: ${count}`} className="h-6 w-6 rounded-[5px] text-center tabular-nums" style={{ background: count ? `color-mix(in oklab, var(--cf-accent) ${Math.round(15 + (count / max) * 70)}%, var(--cf-surface))` : "var(--cf-sunken)", color: count / max > 0.5 ? "var(--cf-on-accent)" : "var(--cf-text-muted)" }}>
                    {from.id === to.id ? "" : count || ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 mt-1 text-[10.5px] text-[var(--cf-text-faint)]">{l("Fila: quién escribe. Columna: a quién.", "Row: who writes. Column: to whom.")}</p>
    </div>
  );
}

export function Insights({ state, onOpenItem }: { state: TeamRunState; onOpenItem: (id: string) => void }) {
  const l = useL();
  const crew = useCrewStore();
  const { metrics, decisions } = useRunInsights(state);
  const slots = useSlots();
  const [open, setOpen] = useState<Set<string>>(() => new Set(["cost", "watch", "decisions", "advisor"]));
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const advisor = state.run.members.find((m) => m.advisor);
  const advice = useMemo(() => state.messages.filter((m) => m.kind === "advice"), [state.messages]);
  const adviseItems = state.items.filter((i) => i.kind === "advise");
  const saved = decisions.filter((d) => d.sharp).reduce((sum, d) => sum + d.saved_tokens, 0);

  return (
    <div className="flex flex-col gap-2 p-2.5">
      <Panel title={l("Costo y recursos", "Cost and resources")} icon={Gauge} open={open.has("cost")} onToggle={() => toggle("cost")}>
        {metrics ? (
          <>
            <Meter label={l("Gasto", "Spend")} value={metrics.usd} max={metrics.budget_usd} format={(n) => money(n)} warnAt={state.run.policy.budget_warn_pct / 100} />
            <Meter label="Tokens" value={metrics.tokens} max={metrics.budget_tokens} format={compact} warnAt={state.run.policy.budget_warn_pct / 100} />
            <Meter label={l("Minutos de agente", "Agent minutes")} value={Math.round(metrics.minutes)} max={metrics.budget_minutes} format={(n) => `${Math.round(n)}`} warnAt={state.run.policy.budget_warn_pct / 100} />
            {slots && <Meter label={l("Turnos del workspace", "Workspace turns")} value={slots.running} max={slots.max_turns} format={(n) => `${n}`} warnAt={1} />}
            {slots && slots.waiting > 0 && <span className="text-[11.5px] text-[var(--cf-warning)]">{l(`${slots.waiting} turnos esperan un hueco.`, `${slots.waiting} turns wait for a slot.`)}</span>}
            <div className="flex flex-col gap-1">
              {metrics.members
                .filter((m) => m.usd > 0 || m.tokens > 0 || m.running > 0)
                .sort((a, b) => b.usd - a.usd)
                .map((m) => {
                  const member = state.run.members.find((x) => x.id === m.member_id);
                  return (
                    <div key={m.member_id} className="flex items-center gap-2 text-[11.5px]">
                      {member && <AgentAvatar agent={{ id: member.agent_id, icon: member.icon, color: member.color }} size={18} state={m.running ? "thinking" : "idle"} />}
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="tabular-nums text-[var(--cf-text-muted)]">{compact(m.tokens)}</span>
                      <b className="w-[52px] text-right tabular-nums">{money(m.usd)}</b>
                    </div>
                  );
                })}
            </div>
            <Btn small title={l("Define cuántos turnos pueden correr en paralelo", "Set how many turns can run in parallel")} onClick={() => crew.open({ kind: "governor" })}>{l("Turnos a la vez…", "Turns at once…")}</Btn>
          </>
        ) : (
          <span className="text-[12px] text-[var(--cf-text-muted)]">…</span>
        )}
      </Panel>

      <Panel title={<span className="inline-flex items-center gap-2">{l("Vigilancia", "Watch")}{metrics && metrics.alerts.length > 0 && <Chip tone="warn" title={l("Alertas activas en esta corrida", "Active alerts in this run")}>{metrics.alerts.length}</Chip>}</span>} icon={AlertTriangle} open={open.has("watch")} onToggle={() => toggle("watch")}>
        {metrics && metrics.alerts.length > 0 ? metrics.alerts.map((a, i) => (
          <div key={`${a.kind}-${i}`} onClick={() => a.item_id && onOpenItem(a.item_id)} className={a.item_id ? "cursor-pointer" : ""}>
            <AlertRow alert={a} state={state} />
          </div>
        )) : <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Todo en orden: sin bucles, sin atascos, dentro del presupuesto.", "All in order: no loops, nothing stuck, within budget.")}</span>}
      </Panel>

      <Panel title={<span className="inline-flex items-center gap-2">{l("Decisiones", "Decisions")}{saved > 0 && <Chip tone="ok" icon={TrendingUp} title={l("Tokens que no gastaste gracias a decisiones automáticas", "Tokens saved by automatic decisions")}>{l(`~${compact(saved)} tokens ahorrados`, `~${compact(saved)} tokens saved`)}</Chip>}</span>} icon={Brain} open={open.has("decisions")} onToggle={() => toggle("decisions")}>
        {decisions.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{state.run.policy.decider ? l("Aún no hubo decisiones cerradas que votar.", "No closed choices to vote on yet.") : l("La capa de decisión está apagada en este equipo.", "The decision layer is off for this team.")}</span>}
        <div className="flex flex-col gap-1 font-mono text-[11px]">
          {decisions.map((d) => (
            <motion.div key={d.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-0.5 rounded-[8px] border border-[var(--cf-border)] px-2 py-1.5" title={d.question}>
              <span className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.sharp ? "bg-[var(--cf-success)]" : "bg-[var(--cf-warning)]"}`} />
                <b className="text-[var(--cf-text)]">{d.kind}</b>
                <span className="text-[var(--cf-text-muted)]">→</span>
                <span className="min-w-0 flex-1 truncate text-[var(--cf-accent)]">{d.choice || "—"}</span>
                <span className="tabular-nums text-[var(--cf-text-muted)]">p={d.p.toFixed(2)}</span>
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-[var(--cf-text-faint)]">
                {d.sharp ? l("claro · actuó el código", "sharp · the code acted") : l("dividido · decidió el líder", "split · the lead decided")}
                <span>· {d.source}</span>
                <span>· {d.ms} ms</span>
                {d.votes.length > 0 && <span className="truncate">· [{d.votes.join(", ")}]</span>}
              </span>
            </motion.div>
          ))}
        </div>
        <Btn small title={l("Ajusta quién resuelve las dudas sin molestarte", "Adjust who settles doubts without bothering you")} onClick={() => crew.open({ kind: "decider" })}>{l("Configurar decisor…", "Set up the decider…")}</Btn>
      </Panel>

      {advisor && (
        <Panel title={l("Asesor", "Advisor")} icon={Lightbulb} open={open.has("advisor")} onToggle={() => toggle("advisor")}>
          <div className="flex items-center gap-2">
            <AgentAvatar agent={{ id: advisor.agent_id, icon: advisor.icon, color: advisor.color }} size={30} state={adviseItems.some((i) => i.status === "running") ? "thinking" : "idle"} />
            <span className="min-w-0 flex-1 text-[12px]">
              <b>{advisor.name}</b>
              <span className="block text-[11px] text-[var(--cf-text-muted)]">
                {adviseItems.some((i) => i.status === "running") ? l("Pensando un consejo…", "Thinking up advice…") : l("En guardia", "On watch")} · {l(`${adviseItems.length} llamadas`, `${adviseItems.length} calls`)}
                {metrics ? ` · ${compact(metrics.members.find((m) => m.member_id === advisor.id)?.tokens ?? 0)} tokens` : ""}
              </span>
            </span>
          </div>
          {advice.length > 0 ? (
            <div className="rounded-[10px] border border-dashed border-[color-mix(in_oklab,var(--cf-violet)_45%,var(--cf-surface))] bg-[color-mix(in_oklab,var(--cf-violet)_6%,var(--cf-surface))] p-2.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-violet)]">{l("Último consejo", "Latest advice")} · {advice[advice.length - 1].to_name}</span>
              <p className="m-0 mt-1 line-clamp-[10] whitespace-pre-wrap text-[12px] leading-relaxed">{advice[advice.length - 1].body}</p>
            </div>
          ) : (
            <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Aconseja antes del plan, ante el mismo error dos veces y antes de cerrar.", "Advises before the plan, on the same error twice and before closing.")}</span>
          )}
        </Panel>
      )}

      <Panel title={l("Quién habla con quién", "Who talks to whom")} icon={MessagesSquare} open={open.has("comms")} onToggle={() => toggle("comms")}>
        {metrics ? <CommsMatrix metrics={metrics} state={state} /> : <span className="text-[12px] text-[var(--cf-text-muted)]">…</span>}
        <Label>{l(`Comunicación: ${state.run.policy.comms === "open" ? "abierta" : state.run.policy.comms === "tree" ? "por jerarquía" : "jerarquía y pares"}`, `Communication: ${state.run.policy.comms === "open" ? "open" : state.run.policy.comms === "tree" ? "chain of command" : "chain and peers"}`)}</Label>
      </Panel>
    </div>
  );
}
