import { motion } from "framer-motion";
import { useAgentsStore } from "../../state/agentsStore";
import { useTeamStore } from "../../state/teamStore";
import { useSlots } from "./kit/slots";
import { AgentAvatar, TeamAvatar } from "./kit/Avatar";
import { useDragSource } from "./kit/drag";
import { SPRING } from "./kit/ui";
import { money, useAgentStates, useCrewStore, useL } from "./state";
import type { WorkspaceAgent } from "../../types/domain";
import type { Team } from "../../types/team";

const STATE_TEXT: Record<string, [string, string]> = {
  idle: ["Libre", "Free"],
  thinking: ["Trabajando", "Working"],
  waiting: ["Te espera", "Waiting on you"],
  error: ["Con error", "Has an error"],
};

function AgentTile({ agent, state }: { agent: WorkspaceAgent; state: string }) {
  const l = useL();
  const crew = useCrewStore();
  const drag = useDragSource({ kind: "agent", id: agent.id }, () => (
    <span className="flex items-center gap-2 rounded-[12px] border border-[var(--cf-accent)] bg-[var(--cf-surface)] py-1 pl-1 pr-3 text-[12.5px] font-medium">
      <AgentAvatar agent={agent} size={26} />
      {agent.name}
    </span>
  ));
  const [es, en] = STATE_TEXT[state] ?? STATE_TEXT.idle;
  return (
    <motion.button
      type="button"
      {...drag}
      whileHover={{ y: -3, scale: 1.06 }}
      transition={SPRING}
      onClick={() => {
        crew.set({ focus: agent.id });
        crew.setSpace("agentes");
      }}
      title={`${agent.name} · ${agent.model}${agent.effort ? ` · ${agent.effort}` : ""} · ${l(es, en)}`}
      aria-label={agent.name}
      className="relative shrink-0 cursor-grab touch-none rounded-[13px] active:cursor-grabbing"
    >
      <AgentAvatar agent={agent} size={40} state={state as "idle"} />
      <span
        className="absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full border-2 border-[var(--cf-surface)]"
        style={{ background: state === "thinking" ? "var(--cf-accent)" : state === "waiting" ? "var(--cf-warning)" : state === "error" ? "var(--cf-danger)" : "var(--cf-success)" }}
      />
    </motion.button>
  );
}

function TeamTile({ team }: { team: Team }) {
  const crew = useCrewStore();
  const drag = useDragSource({ kind: "team", id: team.id }, () => (
    <span className="flex items-center gap-2 rounded-[12px] border border-[var(--cf-accent)] bg-[var(--cf-surface)] py-1 pl-1 pr-3 text-[12.5px] font-medium">
      <TeamAvatar size={26} />
      {team.name}
    </span>
  ));
  return (
    <motion.button
      type="button"
      {...drag}
      whileHover={{ y: -3, scale: 1.06 }}
      transition={SPRING}
      onClick={() => {
        crew.set({ selectedTeamId: team.id, selectedMemberId: null });
        crew.setSpace("equipos");
      }}
      title={`${team.name} · ${team.members.length}`}
      aria-label={team.name}
      className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
    >
      <TeamAvatar size={42} />
    </motion.button>
  );
}

/** The roster within reach from every space: drag an agent or a team onto a card to hand it work,
 * click to open it. On the right, how much of the workspace's capacity is in use. */
export function Dock() {
  const l = useL();
  const roster = useAgentsStore((s) => s.roster);
  const tasks = useAgentsStore((s) => s.tasks);
  const teams = useTeamStore((s) => s.teams);
  const states = useAgentStates();
  const crew = useCrewStore();
  const slots = useSlots();

  const today = new Date().toISOString().slice(0, 10);
  const spentToday = tasks.filter((t) => t.updated_at.startsWith(today)).reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
  const busy = [...states.values()].filter((s) => s === "thinking").length;
  const max = slots?.max_turns ?? 6;
  const running = Math.max(slots?.running ?? 0, busy);
  const agents = roster.filter((a) => a.enabled);

  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_60%,var(--cf-surface))] px-3.5 py-2.5" data-tour="agents-roster">
      <div className="hidden shrink-0 flex-col sm:flex">
        <b className="text-[11px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Agentes", "Agents")}</b>
        <span className="text-[11px] text-[var(--cf-text-faint)]">{l("arrástralos a una tarjeta", "drag them onto a card")}</span>
      </div>
      <div className="flex min-w-0 gap-2 overflow-x-auto px-0.5 py-1 [scrollbar-width:thin]">
        {agents.map((a) => (
          <AgentTile key={a.id} agent={a} state={states.get(a.id) ?? "idle"} />
        ))}
        {agents.length === 0 && (
          <button type="button" onClick={() => crew.open({ kind: "wizard" })} className="rounded-[10px] border border-dashed border-[var(--cf-border-strong)] px-3 py-2 text-[12px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]">
            {l("Crea tu primer agente", "Create your first agent")}
          </button>
        )}
      </div>
      {teams.length > 0 && (
        <>
          <span className="hidden w-px self-stretch bg-[var(--cf-border)] sm:block" />
          <div className="hidden max-w-[40%] shrink-0 gap-2 overflow-x-auto px-0.5 py-1 sm:flex">
            {teams.map((t) => (
              <TeamTile key={t.id} team={t} />
            ))}
          </div>
        </>
      )}
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => crew.open({ kind: "governor" })}
        title={l("Turnos de agentes a la vez en este workspace. Lo que no cabe espera en cola.", "Agent turns at once in this workspace. What does not fit waits in line.")}
        className="flex shrink-0 items-center gap-2.5 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 hover:border-[var(--cf-border-strong)]"
      >
        <span className="flex gap-[3px]">
          {Array.from({ length: Math.min(max, 12) }, (_, i) => (
            <motion.i key={i} className="block h-[18px] w-[7px] rounded-[3px]" animate={{ backgroundColor: i < running ? "var(--cf-accent)" : i < running + (slots?.waiting ?? 0) ? "var(--cf-warning)" : "var(--cf-border)" }} />
          ))}
        </span>
        <span className="hidden flex-col text-left sm:flex">
          <b className="text-[12px] tabular-nums">
            {Math.min(running, max)}/{max} {l("a la vez", "at once")}
          </b>
          <span className="text-[11px] text-[var(--cf-text-faint)]">
            {money(spentToday)} {l("hoy", "today")}
            {slots?.waiting ? ` · ${slots.waiting} ${l("en cola", "queued")}` : ""}
          </span>
        </span>
      </button>
    </footer>
  );
}
