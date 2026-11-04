/**
 * «Equipos»: pick a team, draw who answers to whom, say how it works. The palette on the left holds
 * the roster and the template library; both drag onto the chart.
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Copy, FlaskConical, LayoutTemplate, Network, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, Search, Trash2, WandSparkles, Workflow } from "lucide-react";
import { ResizeHandle } from "../../common/ResizeHandle";
import { ChipRow } from "../kit/ChipRow";
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
              { value: "checks", label: l("Checks", "Checks"), icon: FlaskConical, title: l("Comandos de verificación (tests, lint, build). Cada uno corre «tras cada tarea», en su worktree antes del commit (si falla, vuelve a su autor con el error), o «al final», con todo integrado (si falla, el líder asigna el arreglo).", "Verification commands (tests, lint, build). Each runs «after each task», in its worktree before the commit (on failure it goes back to its author with the error), or «at the end», with everything merged (on failure the lead assigns the fix)."), badge: team.policy.checks.length ? <span className="text-[10.5px] text-[var(--cf-text-faint)]">{team.policy.checks.length}</span> : undefined },
            ]}
          />
          <span className="flex-1" />
          <span className="hidden text-[11.5px] text-[var(--cf-text-faint)] lg:inline">
            {l(`${team.members.filter((m) => !m.advisor).length} miembros`, `${team.members.filter((m) => !m.advisor).length} members`)}
            {team.members.some((m) => m.leads) ? l(" · con sub-líderes", " · with sub-leads") : ""}
            {team.members.some((m) => m.advisor) ? l(" · con asesor", " · with advisor") : ""}
          </span>
          <Btn small kind="primary" icon={WandSparkles} disabled={team.members.length === 0} title={team.members.length === 0 ? l("Añade miembros al equipo primero", "Add members to the team first") : l("Asigna una tarea al equipo entero", "Assigns a task to the whole team")} onClick={() => crew.open({ kind: "launch", assignee: { kind: "team", id: team.id } })}>
            {l("Darle una tarea", "Hand it a task")}
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
  const selected = teams.find((t) => t.id === selectedTeamId) ?? teams[0] ?? null;

  useEffect(() => {
    if (selected && selected.id !== selectedTeamId) crew.set({ selectedTeamId: selected.id });
  }, [selected, selectedTeamId, crew]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <ChipRow
          active={selected?.id}
          noun={["equipos", "teams"]}
          onPick={(id) => crew.set({ selectedTeamId: id, selectedMemberId: null })}
          entries={teams.map((t) => ({ key: t.id, label: t.name, sub: l(`${t.members.length} miembros`, `${t.members.length} members`), leading: <TeamAvatar size={24} /> }))}
        >
          {teams.map((t) => {
            const on = t.id === selected?.id;
            return (
              <button
                key={t.id}
                type="button"
                data-chip={t.id}
                title={l("Abre este equipo", "Opens this team")}
                onClick={() => crew.set({ selectedTeamId: t.id, selectedMemberId: null })}
                className={`relative flex h-[32px] shrink-0 items-center gap-2 rounded-full border pl-1 pr-3 text-[12.5px] font-medium transition-colors ${on ? "border-[var(--cf-accent-line)] text-[var(--cf-text)]" : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-border-strong)]"}`}
              >
                {on && <motion.span layoutId="crew-team-pill" transition={SPRING} className="absolute inset-0 rounded-full bg-[var(--cf-accent-soft)]" />}
                <span className="relative"><TeamAvatar size={24} /></span>
                <span className="relative">{t.name}</span>
                <span className="relative text-[11px] tabular-nums text-[var(--cf-text-faint)]">{t.members.length}</span>
              </button>
            );
          })}
        </ChipRow>
        <Btn small icon={Plus} title={l("Crea un equipo en blanco", "Creates a blank team")} onClick={() => void create()}>{l("Nuevo", "New")}</Btn>
        <Btn small icon={LayoutTemplate} title={l("Crea un equipo desde una plantilla", "Creates a team from a template")} onClick={() => crew.open({ kind: "teamTemplates" })}>{l("Plantillas", "Templates")}</Btn>
        {selected && (
          <>
            <button type="button" title={l("Crea una copia de este equipo", "Makes a copy of this team")} onClick={() => void duplicate(selected)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button type="button" title={l("Borra este equipo; sus corridas pasadas se conservan", "Deletes this team; its past runs are kept")} onClick={() => void remove(selected)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {selected && <TeamEditor key={selected.id} teamId={selected.id} />}
    </div>
  );
}
