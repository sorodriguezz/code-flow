/**
 * «Equipos»: pick a team, draw who answers to whom, say how it works. The palette on the left holds
 * the roster and the template library; both drag onto the chart.
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Copy, FlaskConical, LayoutTemplate, Network, Plus, Search, Trash2, WandSparkles, Workflow } from "lucide-react";
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
    <motion.div {...drag} layout whileHover={{ x: 2 }} transition={SPRING} className="flex cursor-grab touch-none items-center gap-2 rounded-[10px] border border-transparent px-1.5 py-1 hover:border-[var(--cf-border)] hover:bg-[var(--cf-surface)] active:cursor-grabbing">
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
  const drag = useDragSource({ kind: "template", id: item.id }, () => (
    <span className="flex items-center gap-2 rounded-[12px] border border-dashed border-[var(--cf-accent)] bg-[var(--cf-surface)] py-1 pl-1 pr-3 text-[12.5px] font-medium">
      <AgentAvatar agent={{ id: item.id, icon: item.icon, color: item.color }} size={26} />
      {item.name}
    </span>
  ));
  return (
    <motion.div {...drag} whileHover={{ x: 2 }} transition={SPRING} title={item.description} className="flex cursor-grab touch-none items-center gap-2 rounded-[10px] border border-dashed border-transparent px-1.5 py-1 hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-surface)] active:cursor-grabbing">
      <AgentAvatar agent={{ id: item.id, icon: item.icon, color: item.color }} size={26} />
      <span className="min-w-0 flex-1 truncate text-[12px]">{item.name}</span>
    </motion.div>
  );
}

function Palette({ team }: { team: Team }) {
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
    <aside className="hidden w-[232px] shrink-0 flex-col border-r border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))] md:flex">
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
  if (!team) return null;
  const select = (id: string | null) => crew.set({ selectedMemberId: id });

  return (
    <div className="flex min-h-0 flex-1">
      <Palette team={team} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <Seg
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "org", label: l("Organigrama", "Org chart"), icon: Network },
              { value: "flow", label: l("Flujo fijo", "Fixed flow"), icon: Workflow, badge: team.plan.length ? <span className="text-[10.5px] text-[var(--cf-text-faint)]">{team.plan.length}</span> : undefined },
              { value: "checks", label: l("Checks", "Checks"), icon: FlaskConical, badge: team.policy.checks.length ? <span className="text-[10.5px] text-[var(--cf-text-faint)]">{team.policy.checks.length}</span> : undefined },
            ]}
          />
          <span className="flex-1" />
          <span className="hidden text-[11.5px] text-[var(--cf-text-faint)] lg:inline">
            {l(`${team.members.filter((m) => !m.advisor).length} miembros`, `${team.members.filter((m) => !m.advisor).length} members`)}
            {team.members.some((m) => m.leads) ? l(" · con sub-líderes", " · with sub-leads") : ""}
            {team.members.some((m) => m.advisor) ? l(" · con asesor", " · with advisor") : ""}
          </span>
          <Btn small kind="primary" icon={WandSparkles} disabled={team.members.length === 0} onClick={() => crew.open({ kind: "launch", assignee: { kind: "team", id: team.id } })}>
            {l("Darle una tarea", "Hand it a task")}
          </Btn>
        </div>
        {tab === "org" && <OrgCanvas team={team} update={update} selected={member?.id ?? null} onSelect={select} />}
        {tab === "flow" && <FlowTab team={team} update={update} />}
        {tab === "checks" && <ChecksTab team={team} update={update} />}
      </div>
      {tab === "org" && (
        <aside className="hidden w-[330px] shrink-0 overflow-auto border-l border-[var(--cf-border)] bg-[var(--cf-surface)] p-3.5 lg:block">
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
          <Btn kind="primary" icon={LayoutTemplate} onClick={() => crew.open({ kind: "teamTemplates" })}>{l("Desde plantilla", "From a template")}</Btn>
          <Btn icon={Plus} onClick={() => void create()}>{l("En blanco", "Blank")}</Btn>
        </div>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {teams.map((t) => {
            const on = t.id === selected?.id;
            return (
              <button
                key={t.id}
                type="button"
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
        </div>
        <Btn small icon={Plus} onClick={() => void create()}>{l("Nuevo", "New")}</Btn>
        <Btn small icon={LayoutTemplate} onClick={() => crew.open({ kind: "teamTemplates" })}>{l("Plantillas", "Templates")}</Btn>
        {selected && (
          <>
            <button type="button" title={l("Duplicar", "Duplicate")} onClick={() => void duplicate(selected)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button type="button" title={l("Borrar equipo", "Delete team")} onClick={() => void remove(selected)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {selected && <TeamEditor key={selected.id} teamId={selected.id} />}
    </div>
  );
}
