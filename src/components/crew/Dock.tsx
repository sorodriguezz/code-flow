import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search } from "lucide-react";
import { useAgentsStore } from "../../state/agentsStore";
import { useTeamStore } from "../../state/teamStore";
import { useSlots } from "./kit/slots";
import { AgentAvatar, TeamAvatar } from "./kit/Avatar";
import { useDragSource, useDragStore } from "./kit/drag";
import { fieldClass } from "../common/recipes";
import { money, useAgentStates, useCrewStore, useL } from "./state";
import type { WorkspaceAgent } from "../../types/domain";
import type { Team } from "../../types/team";

const STATE_TEXT: Record<string, [string, string]> = {
  idle: ["Libre", "Free"],
  thinking: ["Trabajando", "Working"],
  waiting: ["Te espera", "Waiting on you"],
  error: ["Con error", "Has an error"],
};

/** One slot of the dock's row: a tile and the gap after it. */
const SLOT = 48;

/** Busy first: whoever waits on you, then errors, then work in progress — what you look for in a long row. */
const STATE_ORDER: Record<string, number> = { waiting: 0, error: 1, thinking: 2, idle: 3 };

function AgentTile({ agent, state, labelled = false }: { agent: WorkspaceAgent; state: string; labelled?: boolean }) {
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
      onClick={() => {
        crew.set({ focus: agent.id });
        crew.setSpace("agentes");
      }}
      title={`${agent.name} · ${agent.model}${agent.effort ? ` · ${agent.effort}` : ""} · ${l(es, en)} · ${l("clic para abrir, arrastra a una tarjeta", "click to open, drag onto a card")}`}
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
        </span>
      )}
    </motion.button>
  );
}

function TeamTile({ team, labelled = false }: { team: Team; labelled?: boolean }) {
  const l = useL();
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
      onClick={() => {
        crew.set({ selectedTeamId: team.id, selectedMemberId: null });
        crew.setSpace("equipos");
      }}
      title={`${team.name} · ${team.members.length} ${l("miembros", "members")} · ${l("clic para abrir, arrastra a una tarjeta", "click to open, drag onto a card")}`}
      aria-label={team.name}
      className={
        labelled
          ? "flex w-full min-w-0 cursor-grab touch-none items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[var(--cf-hover)] active:cursor-grabbing"
          : "shrink-0 cursor-grab touch-none rounded-[13px] transition-shadow hover:shadow-[0_0_0_2px_var(--cf-accent-line)] active:cursor-grabbing"
      }
    >
      <TeamAvatar size={labelled ? 30 : 42} />
      {labelled && (
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] font-medium">{team.name}</span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{team.members.length} {l("miembros", "members")}</span>
        </span>
      )}
    </motion.button>
  );
}

/** Everyone, when the row cannot hold them: searchable, and dragged from here like from the row. It
 *  closes as a drag starts, so the cards under it are free to drop on. */
function Everyone({ agents, teams, states, onClose }: { agents: WorkspaceAgent[]; teams: Team[]; states: Map<string, string>; onClose: () => void }) {
  const l = useL();
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const dragging = useDragStore((s) => s.payload !== null);
  useEffect(() => {
    if (dragging) onClose();
  }, [dragging, onClose]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-dock-more]")) onClose();
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
  const someAgents = agents.filter((a) => match(a.name, a.role, a.model));
  const someTeams = teams.filter((t) => match(t.name, t.description ?? ""));
  return (
    <motion.div
      ref={box}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.12 }}
      className="absolute bottom-full left-3.5 z-30 mb-2 flex max-h-[min(420px,60vh)] w-[min(560px,calc(100%-28px))] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-lg,0_12px_32px_rgba(0,0,0,0.18))]"
    >
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
                <AgentTile key={a.id} agent={a} state={states.get(a.id) ?? "idle"} labelled />
              ))}
            </div>
          </>
        )}
        {someTeams.length > 0 && (
          <>
            <b className="mt-2 block px-1.5 pb-1 text-[11px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Equipos", "Teams")} · {someTeams.length}</b>
            <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {someTeams.map((t) => (
                <TeamTile key={t.id} team={t} labelled />
              ))}
            </div>
          </>
        )}
        {someAgents.length + someTeams.length === 0 && <p className="m-0 p-3 text-center text-[12px] text-[var(--cf-text-muted)]">{l("Nada coincide.", "Nothing matches.")}</p>}
      </div>
    </motion.div>
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
  const agents = useMemo(
    () => roster.filter((a) => a.enabled).sort((a, b) => (STATE_ORDER[states.get(a.id) ?? "idle"] ?? 3) - (STATE_ORDER[states.get(b.id) ?? "idle"] ?? 3)),
    [roster, states],
  );

  // As many tiles as the row holds; the rest behind «+N», which lists everyone.
  const row = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(99);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => setRoom(Math.max(1, Math.floor((el.clientWidth + 8) / SLOT)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const total = agents.length + teams.length;
  // The line between agents and teams costs a little room, «+N» a slot.
  const usable = room - (agents.length && teams.length ? 1 : 0);
  const shown = total <= usable ? total : Math.max(0, usable - 1);
  const shownAgents = agents.slice(0, shown);
  const shownTeams = teams.slice(0, Math.max(0, shown - shownAgents.length));
  const hidden = total - shownAgents.length - shownTeams.length;
  const [all, setAll] = useState(false);

  return (
    <footer className="relative flex shrink-0 items-center gap-3 border-t border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_60%,var(--cf-surface))] px-3.5 py-2.5" data-tour="agents-roster">
      <div className="hidden shrink-0 flex-col sm:flex">
        <b className="text-[11px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Agentes", "Agents")}</b>
        <span className="text-[11px] text-[var(--cf-text-faint)]">{l("arrástralos a una tarjeta", "drag them onto a card")}</span>
      </div>
      <div ref={row} className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-0.5 py-1">
        {shownAgents.map((a) => (
          <AgentTile key={a.id} agent={a} state={states.get(a.id) ?? "idle"} />
        ))}
        {agents.length === 0 && (
          <button type="button" onClick={() => crew.open({ kind: "wizard" })} title={l("Abre el asistente para crear un agente", "Opens the wizard to create an agent")} className="shrink-0 rounded-[10px] border border-dashed border-[var(--cf-border-strong)] px-3 py-2 text-[12px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]">
            {l("Crea tu primer agente", "Create your first agent")}
          </button>
        )}
        {shownTeams.length > 0 && shownAgents.length > 0 && <span className="mx-1 h-8 w-px shrink-0 bg-[var(--cf-border)]" />}
        {shownTeams.map((t) => (
          <TeamTile key={t.id} team={t} />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            aria-expanded={all}
            data-dock-more
            title={l(`Ver los ${total} agentes y equipos, con buscador`, `See all ${total} agents and teams, with search`)}
            className="grid h-10 min-w-10 shrink-0 place-items-center rounded-[13px] border border-dashed border-[var(--cf-border-strong)] px-2 text-[12.5px] font-semibold text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            +{hidden}
          </button>
        )}
      </div>
      <AnimatePresence>{all && <Everyone agents={agents} teams={teams} states={states} onClose={() => setAll(false)} />}</AnimatePresence>
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
