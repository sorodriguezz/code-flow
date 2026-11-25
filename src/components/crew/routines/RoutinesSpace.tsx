/**
 * «Rutinas»: the agents and teams that work without being asked each time — every Monday, when a
 * pull request opens, when a pipeline fails.
 *
 * A routine is a flow: its trigger, an agent or team node and whatever else it does are built in
 * Flujos, and run by the flows engine with the team's own budgets. This page builds nothing and
 * runs nothing. It answers the question the Agents app could not: *which of my agents work on
 * their own, started by what, and how did the last time go* — and lets you arm or disarm one
 * without leaving.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  AlarmClock, AlertTriangle, ArrowUpRight, Bell, CalendarClock, CheckCircle2, CircleDashed, FileText, GitPullRequest, Globe, Hand, Inbox, Loader2, Mail, MessageCircle, MousePointerClick,
  RefreshCw, Rocket, Search, Users, Webhook, Workflow, XCircle, Zap, type LucideIcon,
} from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamStore } from "../../../state/teamStore";
import { useFlowsStore } from "../../../state/flowsStore";
import { pushErrorToast } from "../../../state/toastStore";
import { flowsSetActive } from "../../../lib/tauri/flowsCommands";
import { teamRoutines, type TeamRoutine, type TeamRoutineWorker } from "../../../lib/tauri/teamCommands";
import { showAppHere } from "../../../lib/codi/actions/shared";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { Btn, Chip, Empty, SOFT, Switch, field, type Tone } from "../kit/ui";
import { ago } from "../kit/time";
import { useL } from "../state";

type L = (es: string, en: string) => string;

/** What starts a routine, in the reader's words. Unknown triggers read as their own id. */
function triggerLook(type: string, l: L): { label: string; icon: LucideIcon } {
  const known: Record<string, [string, string, LucideIcon]> = {
    "trigger.manual": ["A mano", "By hand", MousePointerClick],
    "trigger.schedule": ["Por horario", "On a schedule", AlarmClock],
    "trigger.webhook": ["Webhook", "Webhook", Webhook],
    "trigger.github": ["GitHub", "GitHub", GitPullRequest],
    "trigger.pr": ["Pull request", "Pull request", GitPullRequest],
    "trigger.pipeline": ["Pipeline", "Pipeline", Rocket],
    "trigger.repo": ["Cambios en el repositorio", "Repository changes", GitPullRequest],
    "trigger.bot": ["Mensaje a un bot", "Bot message", MessageCircle],
    "trigger.chat": ["Chat", "Chat", MessageCircle],
    "trigger.email": ["Correo", "Email", Mail],
    "trigger.form": ["Formulario", "Form", FileText],
    "trigger.file": ["Archivo", "File", FileText],
    "trigger.queue": ["Cola", "Queue", Inbox],
    "trigger.feed": ["Feed", "Feed", Bell],
    "trigger.flow": ["Otro flujo", "Another flow", Workflow],
    "trigger.remote": ["Equipo remoto", "Remote host", Globe],
  };
  const hit = known[type];
  if (hit) return { label: l(hit[0], hit[1]), icon: hit[2] };
  return { label: type.replace(/^trigger\./, ""), icon: Zap };
}

function lastRunLook(status: string, l: L): { label: string; tone: Tone; icon: LucideIcon } {
  switch (status) {
    case "success":
      return { label: l("Terminó bien", "Finished well"), tone: "ok", icon: CheckCircle2 };
    case "error":
    case "failed":
      return { label: l("Falló", "Failed"), tone: "bad", icon: XCircle };
    case "running":
      return { label: l("Corriendo", "Running"), tone: "accent", icon: Loader2 };
    case "waiting":
      return { label: l("Te espera", "Waiting on you"), tone: "warn", icon: Hand };
    case "cancelled":
    case "canceled":
      return { label: l("Cancelada", "Cancelled"), tone: "neutral", icon: CircleDashed };
    default:
      return { label: status, tone: "neutral", icon: CircleDashed };
  }
}

function WorkerRow({ worker }: { worker: TeamRoutineWorker }) {
  const l = useL();
  const teams = useTeamStore((s) => s.teams);
  const roster = useAgentsStore((s) => s.roster);
  const team = worker.kind === "team" ? teams.find((t) => t.id === worker.refs[0]) : undefined;
  const agents = worker.kind === "team" ? [] : worker.refs.map((id) => roster.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  const gone = worker.refs.length > 0 && !team && agents.length === 0;
  const who = team?.name
    ?? (agents.length > 0
      ? agents.map((a) => a.name).join(", ")
      : worker.refs.length === 0
        ? l("Se decide al correr", "Decided when it runs")
        : worker.kind === "team" ? l("Un equipo que ya no existe", "A team that no longer exists") : l("Un agente que ya no existe", "An agent that no longer exists"));
  const what = worker.kind === "team" ? l("Equipo", "Team") : worker.kind === "agents" ? l("Varios a la vez", "Several at once") : worker.kind === "lead" ? l("Líder con ayudantes", "Lead with helpers") : l("Agente", "Agent");
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex shrink-0 -space-x-1.5">
        {team ? <TeamAvatar size={26} /> : agents.length > 0
          ? agents.slice(0, 3).map((a) => <AgentAvatar key={a.id} agent={a} size={26} />)
          : <span className="grid h-[26px] w-[26px] place-items-center rounded-[8px] border border-dashed border-[var(--cf-border-strong)] text-[var(--cf-text-faint)]">{gone ? <AlertTriangle className="h-3.5 w-3.5 text-[var(--cf-warning)]" /> : <Users className="h-3.5 w-3.5" />}</span>}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <b className={`truncate text-[12.5px] ${gone ? "text-[var(--cf-warning)]" : ""}`}>{who}</b>
          <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">{what}</span>
        </span>
        {worker.ask && <span className="line-clamp-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]" title={worker.ask}>{worker.ask}</span>}
      </span>
    </li>
  );
}

function RoutineCard({ routine, onChanged }: { routine: TeamRoutine; onChanged: () => void }) {
  const l = useL();
  const [busy, setBusy] = useState(false);
  const armed = routine.triggers.some((type) => type !== "trigger.manual");
  const last = routine.lastRun ? lastRunLook(routine.lastRun.status, l) : null;
  const openInFlows = () => {
    showAppHere("flows");
    void useFlowsStore.getState().openFlow(routine.flowId);
  };
  const setActive = async (active: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await flowsSetActive(routine.flowId, active);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <motion.article layout transition={SOFT} className={`flex min-w-0 flex-col gap-3 rounded-[14px] border bg-[var(--cf-surface-raised)] p-3.5 ${routine.active ? "border-[var(--cf-border)]" : "border-dashed border-[var(--cf-border-strong)]"}`}>
      <header className="flex items-start gap-2.5">
        <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] ${routine.active ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "bg-[var(--cf-sunken)] text-[var(--cf-text-faint)]"}`}>
          <CalendarClock className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px]" title={routine.name}>{routine.name}</b>
          <span className="line-clamp-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {routine.description || (routine.active ? l("Activa: corre sola cuando ocurre lo que la dispara.", "Active: it runs on its own when its trigger fires.") : l("Apagada: solo corre si la inicias a mano.", "Off: it only runs when you start it by hand."))}
          </span>
        </span>
        {armed && (
          <span className="w-[42px] shrink-0" title={routine.active ? l("Apágala: deja de correr sola", "Turn it off: it stops running on its own") : l("Actívala: vuelve a correr sola", "Turn it on: it runs on its own again")}>
            <Switch checked={routine.active} disabled={busy} onChange={(active) => void setActive(active)} />
          </span>
        )}
      </header>

      <div className="flex flex-wrap gap-1.5">
        {routine.triggers.length === 0 && <Chip tone="neutral" icon={MousePointerClick}>{l("A mano", "By hand")}</Chip>}
        {routine.triggers.map((type, index) => {
          const { label, icon } = triggerLook(type, l);
          return <Chip key={`${type}-${index}`} tone={routine.active && type !== "trigger.manual" ? "accent" : "neutral"} icon={icon} title={l("Lo que inicia esta rutina", "What starts this routine")}>{label}</Chip>;
        })}
        {routine.global && <Chip tone="neutral" icon={Globe} title={l("Disponible en todos tus workspaces", "Available in all your workspaces")}>{l("Global", "Global")}</Chip>}
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {routine.workers.map((worker) => <WorkerRow key={worker.nodeId} worker={worker} />)}
      </ul>

      {routine.lastRun?.error && last?.tone === "bad" && (
        <p className="m-0 line-clamp-2 rounded-[8px] bg-[color-mix(in_oklab,var(--cf-danger)_7%,transparent)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--cf-danger)]" title={routine.lastRun.error}>{routine.lastRun.error}</p>
      )}

      <footer className="mt-auto flex items-center gap-2 border-t border-[var(--cf-border)] pt-2.5 text-[11.5px] text-[var(--cf-text-muted)]">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {last && routine.lastRun ? (
            <>
              <Chip tone={last.tone} icon={last.icon} title={routine.lastRun.error || l("Resultado de la última corrida", "Result of the last run")}>{last.label}</Chip>
              <span className="whitespace-nowrap">{ago(routine.lastRun.startedAt, l)}</span>
            </>
          ) : (
            <span className="text-[var(--cf-text-faint)]">{l("Aún no ha corrido", "It has not run yet")}</span>
          )}
          {routine.runs > 0 && (
            <span className="whitespace-nowrap" title={l("Corridas de los últimos 30 días", "Runs in the last 30 days")}>
              {routine.runs === 1 ? l("1 corrida", "1 run") : l(`${routine.runs} corridas`, `${routine.runs} runs`)}
              {routine.failed > 0 && <span className="text-[var(--cf-danger)]"> · {routine.failed === 1 ? l("1 falló", "1 failed") : l(`${routine.failed} fallaron`, `${routine.failed} failed`)}</span>}
            </span>
          )}
        </span>
        <Btn small kind="ghost" icon={ArrowUpRight} className="shrink-0" title={l("Abre el flujo en Flujos para ver sus corridas o cambiarlo", "Opens the flow in Flows to see its runs or change it")} onClick={openInFlows}>{l("Abrir en Flujos", "Open in Flows")}</Btn>
      </footer>
    </motion.article>
  );
}

export function RoutinesSpace() {
  const l = useL();
  const workspaceId = useTeamStore((s) => s.workspaceId);
  const [routines, setRoutines] = useState<TeamRoutine[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setRoutines(await teamRoutines(workspaceId));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setRoutines(null);
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return routines ?? [];
    return (routines ?? []).filter((routine) => `${routine.name} ${routine.description} ${routine.workers.map((w) => `${w.nodeName} ${w.ask}`).join(" ")}`.toLowerCase().includes(q));
  }, [routines, query]);
  const active = (routines ?? []).filter((routine) => routine.active).length;
  const openFlows = () => showAppHere("flows");

  if (routines === null) {
    return error ? (
      <Empty icon={AlertTriangle} title={l("No se pudieron leer las rutinas", "The routines could not be read")} hint={error}>
        <Btn kind="primary" icon={RefreshCw} onClick={() => void load()}>{l("Reintentar", "Retry")}</Btn>
      </Empty>
    ) : (
      <div className="grid flex-1 place-items-center text-[12px] text-[var(--cf-text-muted)]">{l("Cargando rutinas…", "Loading routines…")}</div>
    );
  }

  if (routines.length === 0) {
    return (
      <Empty
        icon={CalendarClock}
        title={l("Ningún agente trabaja solo todavía", "No agent works on its own yet")}
        hint={l(
          "Una rutina pone a un agente o a un equipo a trabajar sin que se lo pidas cada vez: cada lunes, cuando se abre un pull request, cuando falla un pipeline. Se arma en Flujos, con un disparador y un nodo de agente o de equipo, y aparece aquí.",
          "A routine puts an agent or a team to work without you asking each time: every Monday, when a pull request opens, when a pipeline fails. It is built in Flows, with a trigger and an agent or team node, and shows up here.",
        )}
      >
        <Btn kind="primary" icon={Workflow} title={l("Abre Flujos para crear el flujo de la rutina", "Opens Flows to create the routine's flow")} onClick={openFlows}>{l("Crear una en Flujos", "Create one in Flows")}</Btn>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3.5 py-2.5">
        <label className="relative w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={l("Buscar rutina", "Search routine")} placeholder={l("Buscar rutina", "Search routine")} className={`${field} h-[30px] pl-8`} />
        </label>
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">
          {routines.length === 1 ? l("1 rutina", "1 routine") : l(`${routines.length} rutinas`, `${routines.length} routines`)}
          {" · "}
          {active === 1 ? l("1 activa", "1 active") : l(`${active} activas`, `${active} active`)}
        </span>
        <span className="flex-1" />
        <Btn small kind="ghost" icon={RefreshCw} disabled={loading} title={l("Vuelve a leer las rutinas", "Reads the routines again")} onClick={() => void load()}>{l("Actualizar", "Refresh")}</Btn>
        <Btn small icon={Workflow} title={l("Abre Flujos para crear o cambiar una rutina", "Opens Flows to create or change a routine")} onClick={openFlows}>{l("Abrir Flujos", "Open Flows")}</Btn>
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-3 overflow-y-auto p-3.5">
        {shown.map((routine) => <RoutineCard key={routine.flowId} routine={routine} onChanged={() => void load()} />)}
        {shown.length === 0 && <p className="col-span-full m-0 p-6 text-center text-[12.5px] text-[var(--cf-text-muted)]">{l("Ninguna rutina coincide.", "No routine matches.")}</p>}
      </div>
    </div>
  );
}
