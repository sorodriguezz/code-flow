import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import { useAgentsStore } from "../../state/agentsStore";
import { useTeamStore } from "../../state/teamStore";
import { isPersonalAgent } from "../../lib/agents/personalAgents";
import { useSlots } from "./kit/slots";
import { AgentAvatar, TeamAvatar } from "./kit/Avatar";
import { useDragSource, useDragStore } from "./kit/drag";
import { fieldClass } from "../common/recipes";
import { iconButtonClass } from "../common/Button";
import { money, useAgentStates, useCrewStore, useL } from "./state";
import type { WorkspaceAgent } from "../../types/domain";
import type { Team } from "../../types/team";

const STATE_TEXT: Record<string, [string, string]> = {
  idle: ["Libre", "Free"],
  thinking: ["Trabajando", "Working"],
  waiting: ["Te espera", "Waiting on you"],
  error: ["Con error", "Has an error"],
};

/** Width of one dock tile including the gap after it. */
const SLOT = 48;
const DIVIDER_SLOT = 17;
const IDLE_AGENT_STATE = "idle";

/** Busy first: whoever waits on you, then errors, then work in progress — what you look for in a long row. */
const STATE_ORDER: Record<string, number> = { waiting: 0, error: 1, thinking: 2, idle: 3 };

function AgentTile({ agent, state, labelled = false, teams = [], currentTeamId, onOpen }: {
  agent: WorkspaceAgent;
  state: string;
  labelled?: boolean;
  teams?: Team[];
  currentTeamId?: string;
  onOpen?: () => void;
}) {
  const l = useL();
  const crew = useCrewStore();
  const drag = useDragSource({ kind: "agent", id: agent.id }, () => (
    <span className="flex items-center gap-2 rounded-[12px] border border-[var(--cf-accent)] bg-[var(--cf-surface)] py-1 pl-1 pr-3 text-[12.5px] font-medium">
      <AgentAvatar agent={agent} size={26} />
      {agent.name}
    </span>
  ));
  const [es, en] = STATE_TEXT[state] ?? STATE_TEXT.idle;
  const names = teams.map((team) => team.name).join(", ");
  const membership = names ? l(`Equipos · ${names}`, `Teams · ${names}`) : l("Sin equipo", "No team");
  const others = currentTeamId ? teams.filter((team) => team.id !== currentTeamId).map((team) => team.name).join(", ") : "";
  const details = currentTeamId ? (others ? l(`También en ${others}`, `Also in ${others}`) : null) : membership;
  return (
    <motion.button
      type="button"
      {...drag}
      onClick={() => {
        onOpen?.();
        crew.set({ focus: agent.id });
        crew.setSpace("agentes");
      }}
      title={[
        agent.name,
        [agent.model, agent.effort, l(es, en)].filter(Boolean).join(" · "),
        membership,
        l("Clic para abrir. Arrastra a una tarjeta.", "Click to open. Drag onto a card."),
      ].filter(Boolean).join("\n")}
      aria-label={agent.name}
      className={
        labelled
          ? "flex w-full min-w-0 cursor-grab touch-none items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[var(--cf-hover)] active:cursor-grabbing"
          : "relative shrink-0 cursor-grab touch-none rounded-[13px] transition-shadow hover:shadow-[0_0_0_2px_var(--cf-accent-line)] active:cursor-grabbing"
      }
    >
      <span className="relative shrink-0">
        <AgentAvatar agent={agent} size={labelled ? 30 : 40} state={state as "idle"} />
        <span
          className="absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full border-2 border-[var(--cf-surface)]"
          style={{ background: state === "thinking" ? "var(--cf-accent)" : state === "waiting" ? "var(--cf-warning)" : state === "error" ? "var(--cf-danger)" : "var(--cf-success)" }}
        />
      </span>
      {labelled && (
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] font-medium">{agent.name}</span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{l(es, en)} · {agent.model}</span>
          {details && <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{details}</span>}
        </span>
      )}
    </motion.button>
  );
}

function TeamTile({ team, expanded = false, labelled = false, onToggle }: { team: Team; expanded?: boolean; labelled?: boolean; onToggle: () => void }) {
  const l = useL();
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
      onClick={onToggle}
      data-dock-toggle
      aria-expanded={expanded}
      title={`${team.name} · ${team.members.length} ${l("miembros", "members")}\n${l("Clic para ver integrantes. Arrastra a una tarjeta para asignar el equipo.", "Click to see members. Drag onto a card to assign the team.")}`}
      aria-label={team.name}
      className={
        labelled
          ? "flex w-full min-w-0 cursor-grab touch-none items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[var(--cf-hover)] active:cursor-grabbing"
          : `shrink-0 cursor-grab touch-none rounded-[13px] transition-shadow hover:shadow-[0_0_0_2px_var(--cf-accent-line)] active:cursor-grabbing ${expanded ? "bg-[var(--cf-accent-soft)]" : ""}`
      }
    >
      <TeamAvatar size={labelled ? 30 : 40} />
      {labelled && (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">{team.name}</span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{team.members.length} {l("miembros", "members")}</span>
        </span>
      )}
      {labelled && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-muted)]" />}
    </motion.button>
  );
}

/** The overflow list or one team's members. Closing on drag leaves the cards underneath free to drop on. */
function DockPicker({ agents, teams, team, agentsById, memberships, states, onTeam, onBack, onClose }: {
  agents: WorkspaceAgent[];
  teams: Team[];
  team?: Team;
  agentsById: Map<string, WorkspaceAgent>;
  memberships: Map<string, Team[]>;
  states: Map<string, string>;
  onTeam: (id: string) => void;
  onBack?: () => void;
  onClose: () => void;
}) {
  const l = useL();
  const crew = useCrewStore();
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const dragging = useDragStore((s) => s.payload !== null);
  useEffect(() => {
    if (dragging) onClose();
  }, [dragging, onClose]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && box.current && !box.current.contains(target) && !target.closest("[data-dock-toggle]")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const q = query.trim().toLowerCase();
  const match = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const someAgents = agents.filter((a) => match(a.name, a.role, a.model, ...(memberships.get(a.id) ?? []).map((team) => team.name)));
  const someTeams = teams.filter((t) => match(t.name, t.description ?? "") || t.members.some((member) => {
    const agent = agentsById.get(member.agent_id);
    return match(member.name, agent?.name ?? "", agent?.model ?? "");
  }));
  return (
    <motion.div
      ref={box}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.12 }}
      style={{ pointerEvents: dragging ? "none" : undefined }}
      className="absolute bottom-full left-3.5 z-30 mb-2 flex max-h-[min(420px,60vh)] w-[min(560px,calc(100%-28px))] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-lg,0_12px_32px_rgba(0,0,0,0.18))]"
    >
      {team ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] p-2">
            {onBack && (
              <button type="button" aria-label={l("Volver al listado", "Back to the list")} title={l("Volver al listado", "Back to the list")} onClick={onBack} className={iconButtonClass({ size: "sm" })}>
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <TeamAvatar size={30} />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-[12.5px]">{team.name}</b>
              <span className="block text-[11px] text-[var(--cf-text-muted)]">
                {team.members.length === 1 ? l("1 integrante", "1 member") : l(`${team.members.length} integrantes`, `${team.members.length} members`)}
              </span>
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-[11.5px] text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
              onClick={() => {
                onClose();
                crew.set({ selectedTeamId: team.id, selectedMemberId: null });
                crew.setSpace("equipos");
              }}
            >
              {l("Abrir equipo", "Open team")}
            </button>
          </div>
          <div className="grid min-h-0 grid-cols-1 gap-0.5 overflow-y-auto p-2 sm:grid-cols-2">
            {team.members.map((member) => {
              const agent = agentsById.get(member.agent_id);
              const memberTeams = memberships.get(member.agent_id) ?? [];
              if (agent?.enabled) return <AgentTile key={member.id} agent={agent} state={states.get(agent.id) ?? "idle"} labelled teams={memberTeams} currentTeamId={team.id} onOpen={onClose} />;
              const others = memberTeams.filter((entry) => entry.id !== team.id).map((entry) => entry.name).join(", ");
              const alsoIn = others ? l(`También en ${others}`, `Also in ${others}`) : undefined;
              return (
                <div key={member.id} title={alsoIn} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[var(--cf-text-muted)]">
                  <AgentAvatar agent={agent ?? { id: member.id, icon: member.icon, color: member.color }} size={30} />
                  <span className="min-w-0">
                    <b className="block truncate text-[12.5px] font-medium">{agent?.name || member.name || l("Puesto vacante", "Unassigned seat")}</b>
                    <span className="block text-[11px]">{agent ? l("Desactivado", "Disabled") : l("Sin agente asignado", "No agent assigned")}</span>
                    {alsoIn && <span className="block truncate text-[11px]">{alsoIn}</span>}
                  </span>
                </div>
              );
            })}
            {team.members.length === 0 && <p className="col-span-full m-0 p-3 text-center text-[12px] text-[var(--cf-text-muted)]">{l("Sin integrantes todavía.", "No members yet.")}</p>}
          </div>
        </>
      ) : (
        <>
          <div className="relative shrink-0 border-b border-[var(--cf-border)] p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={l("Buscar agente o equipo", "Search agent or team")} className={fieldClass({ size: "sm", className: "w-full pl-7" })} />
          </div>
          <div className="min-h-0 overflow-y-auto p-2">
            {someAgents.length > 0 && (
              <>
                <b className="block px-1.5 pb-1 text-[11px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Agentes", "Agents")} · {someAgents.length}</b>
                <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                  {someAgents.map((a) => (
                    <AgentTile key={a.id} agent={a} state={states.get(a.id) ?? "idle"} labelled teams={memberships.get(a.id)} onOpen={onClose} />
                  ))}
                </div>
              </>
            )}
            {someTeams.length > 0 && (
              <>
                <b className="mt-2 block px-1.5 pb-1 text-[11px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Equipos", "Teams")} · {someTeams.length}</b>
                <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                  {someTeams.map((t) => (
                    <TeamTile key={t.id} team={t} labelled onToggle={() => onTeam(t.id)} />
                  ))}
                </div>
              </>
            )}
            {someAgents.length + someTeams.length === 0 && <p className="m-0 p-3 text-center text-[12px] text-[var(--cf-text-muted)]">{l("Nada coincide.", "Nothing matches.")}</p>}
          </div>
        </>
      )}
    </motion.div>
  );
}

/** Agents and teams are both within reach from every space. Teams also open their member list. */
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
  const agentsById = useMemo(() => new Map(roster.map((agent) => [agent.id, agent])), [roster]);
  const memberships = useMemo(() => {
    const byAgent = new Map<string, Team[]>();
    for (const team of teams) {
      const ids = new Set(team.members.map((member) => member.agent_id).filter(Boolean));
      for (const id of ids) {
        const assigned = byAgent.get(id);
        if (assigned) assigned.push(team);
        else byAgent.set(id, [team]);
      }
    }
    return byAgent;
  }, [teams]);
  const agents = useMemo(
    () => {
      const personalAgents = roster.filter(isPersonalAgent);
      const enabledAgents = personalAgents.filter((agent) => agent.enabled);
      return enabledAgents.sort((firstAgent, secondAgent) => {
        const firstState = states.get(firstAgent.id) ?? IDLE_AGENT_STATE;
        const secondState = states.get(secondAgent.id) ?? IDLE_AGENT_STATE;
        const firstPriority = STATE_ORDER[firstState] ?? STATE_ORDER.idle;
        const secondPriority = STATE_ORDER[secondState] ?? STATE_ORDER.idle;
        return firstPriority - secondPriority;
      });
    },
    [roster, states],
  );

  // As many top-level tiles as the row holds; the rest are behind «+N».
  const row = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    // The row has 4px of horizontal padding and no trailing 8px gap.
    const measure = () => setRoom(el.clientWidth + 4);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const total = agents.length + teams.length;
  const fullWidth = total * SLOT + (agents.length && teams.length ? DIVIDER_SLOT : 0);
  const usable = fullWidth <= room ? room : Math.max(0, room - SLOT);
  const teamRoom = agents.length && teams.length && usable >= 2 * SLOT + DIVIDER_SLOT ? SLOT + DIVIDER_SLOT : 0;
  const shownAgents = agents.slice(0, Math.floor((usable - teamRoom) / SLOT));
  const remaining = usable - shownAgents.length * SLOT - (shownAgents.length ? DIVIDER_SLOT : 0);
  const shownTeams = teams.slice(0, Math.max(0, Math.floor(remaining / SLOT)));
  const hidden = total - shownAgents.length - shownTeams.length;
  const [menu, setMenu] = useState<{ kind: "all" } | { kind: "team"; id: string; fromAll?: boolean } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const activeTeam = menu?.kind === "team" ? teams.find((team) => team.id === menu.id) : undefined;
  const rowLabel = shownTeams.length && !shownAgents.length ? l("Equipos", "Teams") : l("Agentes", "Agents");

  return (
    <footer className="relative flex shrink-0 items-center gap-3 border-t border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_60%,var(--cf-surface))] px-3.5 py-2.5" data-tour="agents-roster">
      <div className="hidden w-[124px] shrink-0 flex-col sm:flex">
        <b className="text-[11px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{rowLabel}</b>
        <span className="text-[11px] text-[var(--cf-text-faint)]">{l("arrástralos a una tarjeta", "drag them onto a card")}</span>
      </div>
      <div ref={row} className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-0.5 py-1">
        {shownAgents.length > 0 && (
          <div role="group" aria-label={l("Agentes", "Agents")} className="flex shrink-0 items-center gap-2">
            {shownAgents.map((a) => (
              <AgentTile key={a.id} agent={a} state={states.get(a.id) ?? "idle"} teams={memberships.get(a.id)} />
            ))}
          </div>
        )}
        {total === 0 && (
          <button type="button" onClick={() => crew.open({ kind: "wizard" })} title={l("Abre el asistente para crear un agente", "Opens the wizard to create an agent")} className="shrink-0 rounded-[10px] border border-dashed border-[var(--cf-border-strong)] px-3 py-2 text-[12px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]">
            {l("Crea tu primer agente", "Create your first agent")}
          </button>
        )}
        {shownTeams.length > 0 && shownAgents.length > 0 && <span className="mx-1 h-8 w-px shrink-0 bg-[var(--cf-border)]" />}
        {shownTeams.length > 0 && (
          <div role="group" aria-label={l("Equipos", "Teams")} className="flex shrink-0 items-center gap-2">
            {shownTeams.map((t) => (
              <TeamTile key={t.id} team={t} expanded={activeTeam?.id === t.id} onToggle={() => setMenu(activeTeam?.id === t.id ? null : { kind: "team", id: t.id })} />
            ))}
          </div>
        )}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setMenu(menu?.kind === "all" ? null : { kind: "all" })}
            aria-expanded={menu?.kind === "all"}
            data-dock-toggle
            title={l(`Ver los ${total} agentes y equipos, con buscador`, `See all ${total} agents and teams, with search`)}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[13px] border border-dashed border-[var(--cf-border-strong)] text-[12.5px] font-semibold text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            +{hidden}
          </button>
        )}
      </div>
      <AnimatePresence>
        {(menu?.kind === "all" || activeTeam) && (
          <DockPicker
            agents={agents}
            teams={teams}
            team={activeTeam}
            agentsById={agentsById}
            memberships={memberships}
            states={states}
            onTeam={(id) => setMenu({ kind: "team", id, fromAll: true })}
            onBack={menu?.kind === "team" && menu.fromAll ? () => setMenu({ kind: "all" }) : undefined}
            onClose={closeMenu}
          />
        )}
      </AnimatePresence>
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
