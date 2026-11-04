/**
 * A team from a template: each seat is filled by an agent you already have or by a new one made
 * from the seat's agent template, and the hierarchy (who leads, who reports to whom, the advisor)
 * comes with it.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Crown, LayoutTemplate, Lightbulb, Sparkles, Star } from "lucide-react";
import { useLibraryStore } from "../../../state/libraryStore";
import { useLanguageStore } from "../../../state/languageStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamStore } from "../../../state/teamStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { pushErrorToast } from "../../../state/toastStore";
import { draftFromTemplate, type TeamSlot, type TeamTemplateBody } from "../../../lib/agents/builtinTemplates";
import { defaultPolicy, emptyTeam, type TeamMember } from "../../../types/team";
import type { LibraryItem } from "../../../types/crew";
import type { WorkspaceAgent } from "../../../types/domain";
import { TemplateActions } from "../roster/TemplateEditor";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { SelectBox, Btn, Label, Modal, SPRING, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { memberFromAgent } from "./teamDraft";

function templateFor(key: string, all: LibraryItem[]): LibraryItem | undefined {
  return all.find((t) => t.kind === "agent" && (t.id === `builtin:${key}` || t.based_on === `builtin:${key}` || t.id === key));
}

/** `new` makes an agent from the seat's template; otherwise an agent id. */
type Pick = "new" | string;

function Seat({ slot, template, pick, onPick, depth }: { slot: TeamSlot; template?: LibraryItem; pick: Pick; onPick: (p: Pick) => void; depth: number }) {
  const l = useL();
  const roster = useAgentsStore((s) => s.roster);
  const chosen = roster.find((a) => a.id === pick);
  const look = chosen ?? (template ? { id: template.id, icon: template.icon, color: template.color } : { id: slot.slot });
  return (
    <motion.div layout transition={SPRING} className="relative flex items-center gap-3 rounded-lg border border-[var(--cf-border)] px-3 py-2" style={{ marginLeft: depth * 24 }}>
      {depth > 0 && <span aria-hidden className="absolute -left-[13px] top-1/2 h-px w-3 bg-[var(--cf-border-strong)]" />}
      <AgentAvatar agent={look} size={34} />
      <span className="min-w-0 flex-1">
        <b className="flex items-center gap-1.5 truncate text-[12.5px]">
          {slot.name}
          {depth === 0 && !slot.advisor && <span title={l("Líder del equipo: planifica y reparte", "Team lead: plans and hands out work")}><Crown className="h-3.5 w-3.5 text-[var(--cf-warning)]" /></span>}
          {slot.leads && <span title={l("Sub-líder: reparte el trabajo de su rama", "Sub-lead: hands out its branch's work")}><Star className="h-3.5 w-3.5 text-[var(--cf-accent)]" /></span>}
          {slot.advisor && <span title={l("Asesor: mira desde arriba y aconseja, no escribe código", "Advisor: watches and advises, never writes code")}><Lightbulb className="h-3.5 w-3.5 text-[var(--cf-violet)]" /></span>}
        </b>
        <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">{slot.role}</span>
      </span>
      <SelectBox value={pick} onChange={(v) => onPick(v)} className="w-[220px] shrink-0" title={l("Quién ocupa este puesto: uno de tus agentes o uno nuevo de la plantilla", "Who takes this seat: one of your agents or a new one from the template")}>
        <option value="new">{l(`Nuevo: ${template?.name ?? slot.agent_template}`, `New: ${template?.name ?? slot.agent_template}`)}</option>
        {roster.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </SelectBox>
    </motion.div>
  );
}

export function TeamTemplatesDialog() {
  const l = useL();
  const crew = useCrewStore();
  const saved = useLibraryStore((s) => s.saved);
  const lang = useLanguageStore((s) => s.language);
  const all = useMemo(() => useLibraryStore.getState().all(), [saved, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const teams = all.filter((t) => t.kind === "team");
  const roster = useAgentsStore((s) => s.roster);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [chosen, setChosen] = useState<LibraryItem | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const body = chosen?.body as TeamTemplateBody | undefined;
  const choose = (item: LibraryItem) => {
    const b = item.body as TeamTemplateBody;
    const next: Record<string, Pick> = {};
    const used = new Set<string>();
    for (const slot of b.slots) {
      const template = templateFor(slot.agent_template, all);
      // An agent made from the same template earlier fills the seat; each agent fills one seat.
      const existing = roster.find((a) => template && a.template_id === template.id && !used.has(a.id));
      if (existing) used.add(existing.id);
      next[slot.slot] = existing?.id ?? "new";
    }
    setPicks(next);
    setName(item.name);
    setChosen(item);
  };

  /** Hops from the lead's seat: the lead and the advisor sit at 0. */
  const depthOf = (slot: TeamSlot, slots: TeamSlot[]): number => {
    if (slot.advisor || slot.slot === body?.lead_slot) return 0;
    let d = 1;
    let current = slot;
    while (current.reports_to && current.reports_to !== body?.lead_slot && d < 4) {
      const boss = slots.find((s) => s.slot === current.reports_to);
      if (!boss) break;
      current = boss;
      d++;
    }
    return d;
  };

  const create = async () => {
    if (!chosen || !body || !workspaceId) return;
    setBusy(true);
    try {
      const agents = new Map<string, WorkspaceAgent>();
      const taken = roster.map((a) => a.name);
      for (const slot of body.slots) {
        const pick = picks[slot.slot] ?? "new";
        if (pick !== "new") {
          const agent = roster.find((a) => a.id === pick);
          if (agent) agents.set(slot.slot, agent);
          continue;
        }
        const template = templateFor(slot.agent_template, all);
        if (!template) throw new Error(l(`No encuentro la plantilla «${slot.agent_template}».`, `Template «${slot.agent_template}» not found.`));
        const agent = await useAgentsStore.getState().saveAgent(draftFromTemplate(template, workspaceId, taken));
        taken.push(agent.name);
        agents.set(slot.slot, agent);
      }
      const ids = new Map(body.slots.map((s) => [s.slot, crypto.randomUUID()]));
      const lead = ids.get(body.lead_slot) ?? "";
      const members: TeamMember[] = body.slots.map((slot) => {
        const agent = agents.get(slot.slot) as WorkspaceAgent;
        const boss = slot.reports_to ? ids.get(slot.reports_to) ?? "" : "";
        return {
          ...memberFromAgent(agent, boss === lead ? "" : boss),
          id: ids.get(slot.slot) as string,
          name: slot.name,
          role: slot.role,
          leads: Boolean(slot.leads),
          hands_on: Boolean(slot.hands_on),
          advisor: Boolean(slot.advisor),
          edits: slot.advisor ? false : agent.edits ?? true,
        };
      });
      const team = await useTeamStore.getState().saveTeam({
        ...emptyTeam(workspaceId),
        name: name.trim() || chosen.name,
        description: chosen.description,
        lead,
        members,
        policy: { ...defaultPolicy(), ...(body.policy ?? {}) },
      });
      if (team) {
        crew.set({ selectedTeamId: team.id, selectedMemberId: null });
        crew.setSpace("equipos");
        crew.close();
      }
    } catch (error) {
      pushErrorToast(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };

  const creating = body ? body.slots.filter((s) => (picks[s.slot] ?? "new") === "new").length : 0;

  return (
    <Modal
      wide
      title={chosen ? chosen.name : l("Plantillas de equipo", "Team templates")}
      subtitle={chosen ? chosen.description : l("Un equipo armado, con su jerarquía. Cada puesto lo ocupa un agente tuyo o uno nuevo.", "A ready team, hierarchy included. Each seat takes one of your agents or a new one.")}
      leading={<span className="grid h-10 w-10 place-items-center rounded-[12px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"><LayoutTemplate className="h-5 w-5" /></span>}
      onClose={crew.close}
      footer={
        chosen ? (
          <>
            <Btn kind="ghost" icon={ArrowLeft} title={l("Vuelve a la lista de plantillas", "Back to the template list")} onClick={() => setChosen(null)}>{l("Otras plantillas", "Other templates")}</Btn>
            <span className="flex-1 text-[12px] text-[var(--cf-text-faint)]">{creating ? l(`Se crearán ${creating} agentes nuevos.`, `${creating} new agents will be created.`) : l("Usa solo agentes que ya tienes.", "Uses only agents you already have.")}</span>
            <Btn kind="primary" icon={Sparkles} disabled={busy} title={l("Crea los agentes que falten y el equipo con su jerarquía", "Creates the missing agents and the team with its hierarchy")} onClick={() => void create()}>{busy ? l("Creando…", "Creating…") : l("Crear equipo", "Create team")}</Btn>
          </>
        ) : undefined
      }
    >
      {!chosen ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((t, i) => {
            const b = t.body as TeamTemplateBody;
            return (
              <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: i * 0.04 }} className="group relative flex">
              <button
                type="button"
                onClick={() => choose(t)}
                title={l(`Armar «${t.name}»: eliges quién ocupa cada puesto`, `Build «${t.name}»: you choose who takes each seat`)}
                className="flex w-full flex-col gap-2.5 rounded-lg border border-[var(--cf-border)] p-3.5 text-left transition-colors hover:border-[var(--cf-accent-line)] hover:bg-[var(--cf-hover)]"
              >
                <span className="flex items-center gap-2.5">
                  <TeamAvatar size={34} />
                  <b className="text-[13.5px]">{t.name}</b>
                </span>
                <span className="text-[12px] text-[var(--cf-text-muted)]">{t.description}</span>
                <span className="flex flex-wrap items-center gap-1">
                  {b.slots.map((s) => {
                    const template = templateFor(s.agent_template, all);
                    return <AgentAvatar key={s.slot} agent={template ? { id: template.id, icon: template.icon, color: template.color } : { id: s.slot }} size={24} title={s.name} />;
                  })}
                </span>
              </button>
              <span className="absolute right-2 top-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <TemplateActions item={t} />
              </span>
              </motion.div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{l("Nombre", "Name")}</Label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={l("Nombre del equipo", "Team name")} className={field} />
          </div>
          <Label>{l("Puestos", "Seats")}</Label>
          <div className="-mt-1.5 flex flex-col gap-1.5">
            {body?.slots.map((slot) => (
              <Seat key={slot.slot} slot={slot} template={templateFor(slot.agent_template, all)} pick={picks[slot.slot] ?? "new"} onPick={(p) => setPicks((s) => ({ ...s, [slot.slot]: p }))} depth={depthOf(slot, body.slots)} />
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
