/**
 * «Equipos»: pick a team, draw who answers to whom, say how it works. The palette on the left holds
 * the roster and the template library; both drag onto the chart.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Copy, FlaskConical, LayoutTemplate, MessageSquare, Network, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, Search, Trash2, WandSparkles, Workflow } from "lucide-react";
import { ResizeHandle } from "../../common/ResizeHandle";
import { iconButtonClass } from "../../common/Button";
import { useTeamStore } from "../../../state/teamStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useLibraryStore } from "../../../state/libraryStore";
import { useLanguageStore } from "../../../state/languageStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { confirmAction } from "../../../state/confirmStore";
import { emptyTeam, type Team } from "../../../types/team";
import type { LibraryItem } from "../../../types/crew";
import type { WorkspaceAgent } from "../../../types/domain";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { useDragSource } from "../kit/drag";
import { Btn, Empty, Label, Seg, SPRING, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { useTeamDraft } from "./teamDraft";
import { OrgCanvas } from "./OrgCanvas";
import { MemberInspector, TeamInspector } from "./Inspector";
import { ChecksTab, FlowTab } from "./FlowTab";
import { chatWithTeam } from "./TeamChatPane";

function PaletteAgent({ agent, inTeam }: { agent: WorkspaceAgent; inTeam: number }) {
  const l = useL();
  const drag = useDragSource({ kind: "agent", id: agent.id }, () => (
    <span className="flex items-center gap-2 rounded-[12px] border border-[var(--cf-accent)] bg-[var(--cf-surface)] py-1 pl-1 pr-3 text-[12.5px] font-medium">
      <AgentAvatar agent={agent} size={26} />
      {agent.name}
    </span>
  ));
  return (
    <motion.div {...drag} title={l("Arrastra al organigrama para añadirlo al equipo", "Drag onto the chart to add it to the team")} className="flex cursor-grab touch-none items-center gap-2 rounded-[10px] border border-transparent px-1.5 py-1 hover:border-[var(--cf-border)] hover:bg-[var(--cf-surface)] active:cursor-grabbing">
      <AgentAvatar agent={agent} size={30} />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[12.5px]">{agent.name}</b>
        <span className="block truncate text-[11px] text-[var(--cf-text-faint)]">{agent.model}</span>
      </span>
      {inTeam > 0 && <span title={l("Ya está en el equipo", "Already in the team")} className="rounded-full bg-[var(--cf-sunken)] px-1.5 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">×{inTeam}</span>}
    </motion.div>
  );
}

function PaletteTemplate({ item }: { item: LibraryItem }) {
  const l = useL();
  const drag = useDragSource({ kind: "template", id: item.id }, () => (
    <span className="flex items-center gap-2 rounded-[12px] border border-dashed border-[var(--cf-accent)] bg-[var(--cf-surface)] py-1 pl-1 pr-3 text-[12.5px] font-medium">
      <AgentAvatar agent={{ id: item.id, icon: item.icon, color: item.color }} size={26} />
      {item.name}
    </span>
  ));
  return (
    <motion.div {...drag} transition={SPRING} title={item.description || l("Arrastra al organigrama para crear un agente con esta plantilla", "Drag onto the chart to create an agent from this template")} className="flex cursor-grab touch-none items-center gap-2 rounded-[10px] border border-dashed border-transparent px-1.5 py-1 hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-surface)] active:cursor-grabbing">
      <AgentAvatar agent={{ id: item.id, icon: item.icon, color: item.color }} size={26} />
      <span className="min-w-0 flex-1 truncate text-[12px]">{item.name}</span>
    </motion.div>
  );
}

/** A side panel's width and whether it is folded, remembered on this machine. */
function useSide(key: string, initial: number) {
  const read = <T,>(name: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(`crew.teams.${key}.${name}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };
  const write = (name: string, value: unknown) => {
    try {
      localStorage.setItem(`crew.teams.${key}.${name}`, JSON.stringify(value));
    } catch {
      /* a private window: it is only a preference */
    }
  };
  const [width, setWidth] = useState(() => read("width", initial));
  const [open, setOpen] = useState(() => read("open", true));
  return {
    width,
    open,
    resize: setWidth,
    commit: (value: number) => {
      setWidth(value);
      write("width", value);
    },
    toggle: () =>
      setOpen((now) => {
        write("open", !now);
        return !now;
      }),
  };
}

function Palette({ team, width }: { team: Team; width: number }) {
  const l = useL();
  const crew = useCrewStore();
  const roster = useAgentsStore((s) => s.roster);
  const saved = useLibraryStore((s) => s.saved);
  const lang = useLanguageStore((s) => s.language);
  const templates = useMemo(() => useLibraryStore.getState().all().filter((t) => t.kind === "agent"), [saved, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const [q, setQ] = useState("");
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const agents = roster.filter((a) => a.enabled && (match(a.name) || match(a.role)));
  const tpl = templates.filter((t) => match(t.name) || match(t.description));

  return (
    <aside style={{ width }} className="hidden shrink-0 flex-col bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))] md:flex">
      <div className="p-2.5">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={l("Buscar", "Search")} className={`${field} pl-8`} />
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-2 pb-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center px-1.5 pb-1">
            <span className="flex-1"><Label>{l("Tus agentes", "Your agents")}</Label></span>
            <button type="button" onClick={() => crew.open({ kind: "wizard" })} title={l("Nuevo agente", "New agent")} className="grid h-5 w-5 place-items-center rounded-[5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {agents.map((a) => (
            <PaletteAgent key={a.id} agent={a} inTeam={team.members.filter((m) => m.agent_id === a.id).length} />
          ))}
          {agents.length === 0 && <span className="px-1.5 text-[11.5px] text-[var(--cf-text-muted)]">{l("Ninguno todavía.", "None yet.")}</span>}
        </div>
        <div className="flex flex-col gap-0.5">
          <div className="px-1.5 pb-1"><Label>{l("Plantillas (crean el agente)", "Templates (create the agent)")}</Label></div>
          {tpl.map((t) => (
            <PaletteTemplate key={t.id} item={t} />
          ))}
        </div>
      </div>
      <p className="m-0 border-t border-[var(--cf-border)] p-2.5 text-[11px] leading-snug text-[var(--cf-text-faint)]">
        {l("Arrastra al organigrama. Suelta sobre alguien para que le reporte.", "Drag onto the chart. Drop on someone to report to them.")}
      </p>
    </aside>
  );
}

function TeamEditor({ teamId }: { teamId: string }) {
  const l = useL();
  const crew = useCrewStore();
  const { team, update } = useTeamDraft(teamId);
  const [tab, setTab] = useState<"org" | "flow" | "checks">("org");
  const selectedMemberId = useCrewStore((s) => s.selectedMemberId);
  const member = team?.members.find((m) => m.id === selectedMemberId) ?? null;
  const left = useSide("palette", 232);
  const right = useSide("inspector", 330);
  if (!team) return null;
  const select = (id: string | null) => crew.set({ selectedMemberId: id });

  return (
    <div className="flex min-h-0 flex-1">
      {left.open && (
        <>
          <Palette team={team} width={left.width} />
          <span className="hidden md:contents">
            <ResizeHandle axis="x" value={left.width} min={180} max={420} onChange={left.resize} onCommit={left.commit} />
          </span>
        </>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <span className="hidden md:contents">
            <button
              type="button"
              onClick={left.toggle}
              title={left.open ? l("Ocultar agentes y plantillas", "Hide agents and templates") : l("Mostrar agentes y plantillas", "Show agents and templates")}
              aria-label={left.open ? l("Ocultar panel izquierdo", "Hide left panel") : l("Mostrar panel izquierdo", "Show left panel")}
              className={iconButtonClass({ size: "sm" })}
            >
              {left.open ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
            </button>
          </span>
          <Seg
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "org", label: l("Organigrama", "Org chart"), icon: Network, title: l("Quién lidera y quién reporta a quién. El líder arma el plan en cada corrida y lo reparte según esta jerarquía.", "Who leads and who reports to whom. The lead makes the plan on each run and hands it out along this hierarchy.") },
              { value: "flow", label: l("Flujo fijo", "Fixed flow"), icon: Workflow, title: l("Pasos en orden, con compuertas, para un equipo sin líder: cada corrida los sigue tal cual. Con líder no se usan: el líder arma el plan en cada corrida.", "Steps in order, with gates, for a team with no lead: each run follows them as they are. With a lead they are not used: the lead plans each run."), badge: team.lead ? <span className="rounded-full bg-[var(--cf-hover)] px-1.5 text-[10px] text-[var(--cf-text-faint)]">{l("no se usa", "unused")}</span> : team.plan.length ? <span className="text-[10.5px] text-[var(--cf-text-faint)]">{team.plan.length}</span> : undefined },
              { value: "checks", label: l("Verificaciones", "Checks"), icon: FlaskConical, title: l("Comandos de verificación (tests, lint, build). Cada uno corre «tras cada tarea», en su worktree antes del commit (si falla, vuelve a su autor con el error), o «al final», con todo integrado (si falla, el líder asigna el arreglo).", "Verification commands (tests, lint, build). Each runs «after each task», in its worktree before the commit (on failure it goes back to its author with the error), or «at the end», with everything merged (on failure the lead assigns the fix)."), badge: team.policy.checks.length ? <span className="text-[10.5px] text-[var(--cf-text-faint)]">{team.policy.checks.length}</span> : undefined },
            ]}
          />
          {/* One group, pinned right: on a narrow window it wraps whole, with the panel toggle last. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
          <Btn small icon={MessageSquare} disabled={!team.lead} title={team.lead ? l("Conversa con el equipo: el líder responde o delega a sus miembros", "Chat with the team: the lead answers or delegates to its members") : l("Elige un líder para conversar con el equipo", "Choose a lead to chat with the team")} onClick={() => void chatWithTeam(team.id)}>{l("Chat", "Chat")}</Btn>
          <span className="hidden text-[11.5px] text-[var(--cf-text-faint)] 2xl:inline">
            {l(`${team.members.filter((m) => !m.advisor).length} miembros`, `${team.members.filter((m) => !m.advisor).length} members`)}
            {team.members.some((m) => m.leads) ? l(" · con sub-líderes", " · with sub-leads") : ""}
            {team.members.some((m) => m.advisor) ? l(" · con asesor", " · with advisor") : ""}
          </span>
          <Btn small kind="primary" icon={WandSparkles} disabled={team.members.length === 0} title={team.members.length === 0 ? l("Añade miembros al equipo primero", "Add members to the team first") : l("Asigna una tarea al equipo entero", "Assigns a task to the whole team")} onClick={() => crew.open({ kind: "launch", assignee: { kind: "team", id: team.id } })}>
            <span className="hidden xl:inline">{l("Darle una tarea", "Hand it a task")}</span>
          </Btn>
          {tab === "org" && (
            <span className="hidden lg:contents">
              <button
                type="button"
                onClick={right.toggle}
                title={right.open ? l("Ocultar los ajustes del equipo", "Hide the team settings") : l("Mostrar los ajustes del equipo", "Show the team settings")}
                aria-label={right.open ? l("Ocultar panel derecho", "Hide right panel") : l("Mostrar panel derecho", "Show right panel")}
                className={iconButtonClass({ size: "sm" })}
              >
                {right.open ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
              </button>
            </span>
          )}
          </div>
        </div>
        <p className="m-0 shrink-0 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_40%,var(--cf-surface))] px-3 py-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
          {tab === "org"
            ? l(
                "Quiénes forman el equipo y a quién reporta cada uno. Se usa siempre. Las tres pestañas no son modos a elegir: son tres partes del mismo equipo.",
                "Who is on the team and who reports to whom. Always used. The three tabs are not modes to pick from: they are three parts of the same team.",
              )
            : tab === "flow"
              ? team.lead
                ? l(
                    "Este equipo tiene líder, así que estos pasos no se usan: el líder arma el plan en cada corrida. Para que el equipo siga estos pasos, elige «Ninguno» en Cómo trabaja › Líder.",
                    "This team has a lead, so these steps are not used: the lead plans each run. For the team to follow these steps, pick «None» in How it works › Lead.",
                  )
                : l("Este equipo no tiene líder: cada corrida sigue estos pasos en orden.", "This team has no lead: each run follows these steps in order.")
              : l(
                  "Se aplican siempre, con líder o sin él: verifican el trabajo tras cada tarea o al final, con todo integrado.",
                  "Always applied, with a lead or without: they check the work after each task or at the end, with everything merged.",
                )}
        </p>
        {tab === "org" && <OrgCanvas team={team} update={update} selected={member?.id ?? null} onSelect={select} />}
        {tab === "flow" && <FlowTab team={team} update={update} />}
        {tab === "checks" && <ChecksTab team={team} update={update} />}
      </div>
      {tab === "org" && right.open && (
        <span className="hidden lg:contents">
          <ResizeHandle axis="x" invert value={right.width} min={280} max={560} onChange={right.resize} onCommit={right.commit} />
        </span>
      )}
      {tab === "org" && right.open && (
        <aside style={{ width: right.width }} className="hidden shrink-0 overflow-auto bg-[var(--cf-surface)] p-3.5 lg:block">
          {member ? <MemberInspector key={member.id} team={team} member={member} update={update} onClose={() => select(null)} /> : <TeamInspector team={team} update={update} />}
        </aside>
      )}
    </div>
  );
}

export function TeamsSpace() {
  const l = useL();
  const crew = useCrewStore();
  const teams = useTeamStore((s) => s.teams);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const selectedTeamId = useCrewStore((s) => s.selectedTeamId);
  // No team is opened for you: the space starts on the list, and editing is a choice.
  const selected = teams.find((t) => t.id === selectedTeamId) ?? null;

  const create = async () => {
    if (!workspaceId) return;
    let n = teams.length + 1;
    const base = l("Equipo", "Team");
    while (teams.some((t) => t.name === `${base} ${n}`)) n++;
    const saved = await useTeamStore.getState().saveTeam({ ...emptyTeam(workspaceId), name: `${base} ${n}` });
    if (saved) crew.set({ selectedTeamId: saved.id, selectedMemberId: null });
  };
  const duplicate = async (team: Team) => {
    const ids = new Map(team.members.map((m) => [m.id, crypto.randomUUID()]));
    const map = (id: string) => ids.get(id) ?? id;
    const saved = await useTeamStore.getState().saveTeam({
      ...team,
      id: "",
      name: `${team.name} (${l("copia", "copy")})`,
      lead: team.lead ? map(team.lead) : "",
      members: team.members.map((m) => ({ ...m, id: map(m.id), reports_to: m.reports_to ? map(m.reports_to) : "", escalate_to: m.escalate_to ? map(m.escalate_to) : "", talks_to: m.talks_to.map(map) })),
      plan: team.plan.map((s) => ({ ...s, member: map(s.member) })),
      policy: { ...team.policy, conflicts: map(team.policy.conflicts), review: { ...team.policy.review, reviewer: team.policy.review.reviewer ? map(team.policy.review.reviewer) : "", of: team.policy.review.of.map(map) } },
    });
    if (saved) crew.set({ selectedTeamId: saved.id, selectedMemberId: null });
  };
  const remove = async (team: Team) => {
    if (!(await confirmAction(l(`¿Borrar el equipo «${team.name}»? Sus corridas pasadas se conservan.`, `Delete the team «${team.name}»? Its past runs are kept.`)))) return;
    await useTeamStore.getState().deleteTeam(team.id);
    crew.set({ selectedTeamId: null, selectedMemberId: null });
  };

  if (teams.length === 0) {
    return (
      <Empty icon={Network} title={l("Arma tu primer equipo", "Build your first team")} hint={l("Un líder que planifica y reparte, sub-líderes con su rama, y un asesor que mira desde arriba. Empieza en blanco o desde una plantilla.", "A lead that plans and hands out work, sub-leads with their branch, and an advisor looking from above. Start blank or from a template.")}>
        <div className="mt-2 flex gap-2">
          <Btn kind="primary" icon={LayoutTemplate} title={l("Elige un equipo ya armado y ajústalo", "Pick a ready-made team and tweak it")} onClick={() => crew.open({ kind: "teamTemplates" })}>{l("Desde plantilla", "From a template")}</Btn>
          <Btn icon={Plus} title={l("Crea un equipo vacío y arma el organigrama tú", "Creates an empty team; build the chart yourself")} onClick={() => void create()}>{l("En blanco", "Blank")}</Btn>
        </div>
      </Empty>
    );
  }

  const actions = (
    <>
      <Btn small icon={Plus} title={l("Crea un equipo en blanco", "Creates a blank team")} onClick={() => void create()}>{l("Nuevo", "New")}</Btn>
      <Btn small icon={LayoutTemplate} title={l("Crea un equipo desde una plantilla", "Creates a team from a template")} onClick={() => crew.open({ kind: "teamTemplates" })}>{l("Plantillas", "Templates")}</Btn>
    </>
  );

  if (!selected) return <TeamList teams={teams} actions={actions} onDuplicate={duplicate} onRemove={remove} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <button
          type="button"
          onClick={() => crew.set({ selectedTeamId: null, selectedMemberId: null })}
          title={l("Vuelve a la lista de equipos", "Back to the list of teams")}
          className="flex h-[30px] shrink-0 items-center gap-1 rounded-[8px] px-2 text-[12.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {l("Equipos", "Teams")}
        </button>
        <span className="text-[var(--cf-text-faint)]">/</span>
        <span className="flex min-w-0 items-center gap-2">
          <TeamAvatar size={24} />
          <b className="truncate text-[13px]">{selected.name}</b>
        </span>
        <span className="flex-1" />
        <button type="button" title={l("Crea una copia de este equipo", "Makes a copy of this team")} onClick={() => void duplicate(selected)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button type="button" title={l("Borra este equipo; sus corridas pasadas se conservan", "Deletes this team; its past runs are kept")} onClick={() => void remove(selected)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <TeamEditor key={selected.id} teamId={selected.id} />
    </div>
  );
}

/** The space's first view: every team as a card — what it is, who is in it — to open one or hand it work. */
function TeamList({ teams, actions, onDuplicate, onRemove }: { teams: Team[]; actions: React.ReactNode; onDuplicate: (t: Team) => void; onRemove: (t: Team) => void }) {
  const l = useL();
  const crew = useCrewStore();
  const roster = useAgentsStore((s) => s.roster);
  const runs = useTeamStore((s) => s.runs);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = teams.filter((t) => !q || `${t.name} ${t.description} ${t.members.map((m) => m.name).join(" ")}`.toLowerCase().includes(q));
  const open = (id: string) => crew.set({ selectedTeamId: id, selectedMemberId: null });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3.5 py-2.5">
        <div className="relative w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={l("Buscar equipo o miembro", "Search team or member")} className={`${field} h-[30px] pl-8`} />
        </div>
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">{l(`${teams.length} equipos`, `${teams.length} teams`)}</span>
        <span className="flex-1" />
        {actions}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3 overflow-y-auto p-3.5">
        {shown.map((t) => {
          const lead = t.members.find((m) => m.id === t.lead);
          const live = runs.filter((r) => r.team_id === t.id && (r.status === "running" || r.status === "gated")).length;
          const total = runs.filter((r) => r.team_id === t.id).length;
          return (
            <article
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => open(t.id)}
              onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && open(t.id)}
              title={l("Abre el equipo para editarlo", "Opens the team to edit it")}
              className="group flex cursor-pointer flex-col gap-2.5 rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3.5 text-left transition-colors hover:border-[var(--cf-accent-line)]"
            >
              <div className="flex items-start gap-2.5">
                <TeamAvatar size={36} />
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-[13.5px]">{t.name}</b>
                  <span className="line-clamp-2 text-[11.5px] text-[var(--cf-text-muted)]">{t.description || (lead ? l(`${lead.name} al mando`, `${lead.name} in charge`) : l("Flujo fijo, sin líder", "Fixed flow, no lead"))}</span>
                </div>
              </div>
              <div className="flex items-center">
                {t.members.slice(0, 7).map((m, i) => {
                  const agent = roster.find((a) => a.id === m.agent_id);
                  return (
                    <span key={m.id} title={m.name} className="rounded-[10px] ring-2 ring-[var(--cf-surface-raised)]" style={{ marginLeft: i ? -6 : 0 }}>
                      <AgentAvatar agent={{ id: m.agent_id, icon: agent?.icon, color: agent?.color }} size={26} />
                    </span>
                  );
                })}
                {t.members.length > 7 && <span className="ml-1.5 text-[11px] text-[var(--cf-text-faint)]">+{t.members.length - 7}</span>}
                {t.members.length === 0 && <span className="text-[11.5px] text-[var(--cf-text-faint)]">{l("Sin miembros todavía", "No members yet")}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--cf-text-faint)]">
                <span>{l(`${t.members.filter((m) => !m.advisor).length} miembros`, `${t.members.filter((m) => !m.advisor).length} members`)}</span>
                {t.members.some((m) => m.leads) && <span>· {l("sub-líderes", "sub-leads")}</span>}
                {t.members.some((m) => m.advisor) && <span>· {l("asesor", "advisor")}</span>}
                <span>· {live ? l(`${live} en marcha`, `${live} running`) : l(`${total} corridas`, `${total} runs`)}</span>
                <span className="flex-1" />
                <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                  <button type="button" title={t.lead ? l("Chat con el equipo", "Chat with the team") : l("Elige un líder para conversar con el equipo", "Choose a lead to chat with the team")} aria-label={l(`Chat con ${t.name}`, `Chat with ${t.name}`)} disabled={!t.lead} onClick={() => void chatWithTeam(t.id)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-accent)] hover:bg-[var(--cf-hover)] disabled:opacity-40"><MessageSquare className="h-3.5 w-3.5" /></button>
                  <button type="button" title={l("Darle una tarea", "Hand it a task")} disabled={t.members.length === 0} onClick={() => crew.open({ kind: "launch", assignee: { kind: "team", id: t.id } })} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-accent)] hover:bg-[var(--cf-hover)] disabled:opacity-40"><WandSparkles className="h-3.5 w-3.5" /></button>
                  <button type="button" title={l("Duplicar", "Duplicate")} onClick={() => onDuplicate(t)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"><Copy className="h-3.5 w-3.5" /></button>
                  <button type="button" title={l("Borrar", "Delete")} onClick={() => onRemove(t)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              </div>
            </article>
          );
        })}
        {shown.length === 0 && <p className="col-span-full m-0 p-6 text-center text-[12.5px] text-[var(--cf-text-muted)]">{l("Ningún equipo coincide.", "No team matches.")}</p>}
      </div>
    </div>
  );
}
