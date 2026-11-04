/**
 * «Agentes»: the workspace's roster as a gallery, and the template library every workspace shares.
 * Drag a card onto another to reorder; hover for what it has done and what you can do with it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BookMarked, Bot, Copy, Eye, FolderGit2, LayoutTemplate, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, SquareTerminal, Trash2, Users, WandSparkles } from "lucide-react";
import { draftOf, useAgentsStore } from "../../../state/agentsStore";
import { useLibraryStore } from "../../../state/libraryStore";
import { useLanguageStore } from "../../../state/languageStore";
import { useTeamStore } from "../../../state/teamStore";
import { confirmAction } from "../../../state/confirmStore";
import { pushErrorToast, pushSuccessToast } from "../../../state/toastStore";
import { isBuiltin, templateSyncPlan, type AgentTemplateBody, type SyncChange, type TeamTemplateBody } from "../../../lib/agents/builtinTemplates";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import type { WorkspaceAgent } from "../../../types/domain";
import type { LibraryItem } from "../../../types/crew";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { useDragSource, useDropTarget } from "../kit/drag";
import { Btn, Chip, Empty, IconBtn, Label, Modal, Seg, SPRING, field } from "../kit/ui";
import { money, useAgentStates, useCrewStore, useL } from "../state";

function useLibrary() {
  const saved = useLibraryStore((s) => s.saved);
  const lang = useLanguageStore((s) => s.language);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => useLibraryStore.getState().all(), [saved, lang]);
}

const FIELD_NAMES: Record<string, [string, string]> = {
  role: ["Papel", "Role"],
  prompt: ["Instrucciones", "Instructions"],
  provider: ["Motor", "Engine"],
  model: ["Modelo", "Model"],
  effort: ["Razonamiento", "Reasoning"],
  edits: ["Puede editar", "Can edit"],
  run_in: ["Corre en", "Runs in"],
  max_parallel: ["Tareas a la vez", "Tasks at once"],
  model_ladder: ["Escalera de modelos", "Model ladder"],
  icon: ["Icono", "Icon"],
  color: ["Color", "Colour"],
};

function show(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ") || "—";
  if (typeof value === "boolean") return value ? "✓" : "✗";
  const text = String(value ?? "");
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || "—";
}

function SyncDialog({ agent, template, onClose }: { agent: WorkspaceAgent; template: LibraryItem; onClose: () => void }) {
  const l = useL();
  const draft = draftOf(agent);
  const changes = templateSyncPlan(draft, template);
  const [take, setTake] = useState<Set<string>>(() => new Set(changes.filter((c) => !c.overridden).map((c) => c.field)));
  const apply = async () => {
    const next = { ...draft, template_version: template.version };
    for (const change of changes as SyncChange[]) if (take.has(change.field)) (next as Record<string, unknown>)[change.field] = change.to;
    next.overrides = draft.overrides.filter((f) => !take.has(f));
    await useAgentsStore.getState().saveAgent(next).catch((e: unknown) => pushErrorToast(String(e)));
    onClose();
  };
  return (
    <Modal
      title={l(`Actualizar ${agent.name}`, `Update ${agent.name}`)}
      subtitle={l(`La plantilla «${template.name}» cambió (v${agent.template_version ?? 0} → v${template.version}). Lo que editaste a mano viene desmarcado.`, `Template «${template.name}» changed (v${agent.template_version ?? 0} → v${template.version}). What you edited by hand comes unticked.`)}
      leading={<AgentAvatar agent={agent} size={40} />}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Btn kind="ghost" title={l("Cierra sin cambiar el agente", "Closes without changing the agent")} onClick={onClose}>{l("Ahora no", "Not now")}</Btn>
          <Btn kind="primary" icon={RefreshCw} title={l("Pasa al agente los cambios marcados de la plantilla", "Copies the ticked template changes into the agent")} onClick={() => void apply()}>{take.size ? l(`Aplicar ${take.size}`, `Apply ${take.size}`) : l("Solo marcar al día", "Just mark up to date")}</Btn>
        </>
      }
    >
      {changes.length === 0 && <span className="text-[12.5px] text-[var(--cf-text-muted)]">{l("Nada cambió en los campos que la plantilla define.", "Nothing changed in the fields the template sets.")}</span>}
      <div className="flex flex-col gap-1.5">
        {changes.map((c) => {
          const on = take.has(c.field);
          const [es, en] = FIELD_NAMES[c.field] ?? [c.field, c.field];
          return (
            <label key={c.field} className={`flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3 py-2 ${on ? "border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)]" : "border-[var(--cf-border)]"}`}>
              <input type="checkbox" checked={on} onChange={() => setTake((s) => { const n = new Set(s); if (n.has(c.field)) n.delete(c.field); else n.add(c.field); return n; })} className="mt-1 accent-[var(--cf-accent)]" />
              <span className="min-w-0 flex-1">
                <b className="text-[12.5px]">{l(es, en)}</b>
                {c.overridden && <Chip tone="warn" className="ml-2" title={l("Cambiaste este campo en el agente: la plantilla no lo pisa salvo que lo marques", "You changed this field on the agent: the template won't overwrite it unless ticked")}>{l("editado a mano", "edited by hand")}</Chip>}
                <span className="mt-0.5 block text-[11.5px] text-[var(--cf-text-muted)]">
                  <s>{show(c.from)}</s> → <b className="text-[var(--cf-text)]">{show(c.to)}</b>
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

function AgentCard({ agent, index, onSync }: { agent: WorkspaceAgent; index: number; onSync: (template: LibraryItem) => void }) {
  const l = useL();
  const crew = useCrewStore();
  const focus = useCrewStore((s) => s.focus);
  const tasks = useAgentsStore((s) => s.tasks);
  const roster = useAgentsStore((s) => s.roster);
  const teams = useTeamStore((s) => s.teams);
  const library = useLibrary();
  const states = useAgentStates();
  const ref = useRef<HTMLDivElement>(null);
  const state = states.get(agent.id) ?? "idle";
  const mine = tasks.filter((t) => t.agent_id === agent.id);
  const spent = mine.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
  const inTeams = teams.filter((t) => t.members.some((m) => m.agent_id === agent.id));
  const template = agent.template_id ? library.find((t) => t.id === agent.template_id) : undefined;
  const outdated = template && template.version > (agent.template_version ?? 0);
  const focused = focus === agent.id;

  const drag = useDragSource({ kind: "agent", id: agent.id }, () => (
    <span className="flex items-center gap-2 rounded-[12px] border border-[var(--cf-accent)] bg-[var(--cf-surface)] py-1 pl-1 pr-3 text-[12.5px] font-medium">
      <AgentAvatar agent={agent} size={26} />
      {agent.name}
    </span>
  ));
  const drop = useDropTarget(
    `roster:${agent.id}`,
    (p) => p.kind === "agent" && p.id !== agent.id,
    (p) => {
      const ids = roster.map((a) => a.id).filter((id) => id !== p.id);
      ids.splice(ids.indexOf(agent.id), 0, p.id);
      void useAgentsStore.getState().reorderAgents(ids);
    },
  );

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = window.setTimeout(() => crew.set({ focus: null }), 1600);
    return () => window.clearTimeout(timer);
  }, [focused, crew]);

  const remove = async () => {
    const ok = await confirmAction(
      inTeams.length
        ? l(`«${agent.name}» está en ${inTeams.length} equipo(s). Si lo borras, esos puestos quedan sin agente. ¿Borrar?`, `«${agent.name}» is in ${inTeams.length} team(s). Deleting it leaves those seats empty. Delete?`)
        : l(`¿Borrar a «${agent.name}»? Sus tareas pasadas se conservan.`, `Delete «${agent.name}»? Its past tasks are kept.`),
    );
    if (ok) await useAgentsStore.getState().removeAgent(agent.id);
  };
  const saveAsTemplate = async () => {
    const body: AgentTemplateBody = { v: 1, role: agent.role, prompt: agent.prompt, provider: agent.provider, model: agent.model, effort: agent.effort ?? "", edits: agent.edits ?? true, run_in: agent.run_in ?? "headless", max_parallel: agent.max_parallel ?? 1, model_ladder: agent.model_ladder ?? [] };
    try {
      await useLibraryStore.getState().save({ id: "", kind: "agent", name: agent.name, description: agent.role, icon: agent.icon ?? "", color: agent.color ?? "", tags: [], body, based_on: "", version: 0, sort_order: 0, created_at: "", updated_at: "" });
      pushSuccessToast(l(`«${agent.name}» quedó en la biblioteca, para todos tus workspaces.`, `«${agent.name}» is in the library now, for all your workspaces.`));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: agent.enabled ? 1 : 0.6, y: 0 }}
      transition={{ ...SPRING, delay: Math.min(index, 10) * 0.03 }}
      {...drop.props}
      className={`group relative flex flex-col overflow-hidden rounded-[16px] border bg-[var(--cf-surface-raised)] transition-shadow hover:shadow-[var(--cf-shadow)] ${
        drop.over ? "border-[var(--cf-accent)]" : focused ? "border-[var(--cf-accent)] shadow-[0_0_0_4px_var(--cf-accent-soft)]" : "border-[var(--cf-border)]"
      }`}
    >
      <div {...drag} title={l("Arrastra para reordenar el dock", "Drag to reorder the dock")} className="flex cursor-grab touch-none flex-col items-center gap-2 px-4 pb-3 pt-5 text-center active:cursor-grabbing">
        <AgentAvatar agent={agent} size={64} state={state} />
        <div className="min-w-0 max-w-full">
          <b className="block truncate text-[14px]">{agent.name}</b>
          <span className="line-clamp-2 block min-h-[32px] text-[12px] text-[var(--cf-text-muted)]">{agent.role || l("Sin papel", "No role")}</span>
        </div>
        <div className="flex flex-wrap justify-center gap-1">
          <Chip title={l("Modelo", "Model")}><ProviderGlyph providerId={agent.provider} size={11} />{agent.model || "—"}</Chip>
          {agent.effort && <Chip tone="violet" title={l("Esfuerzo de razonamiento", "Reasoning effort")}>{agent.effort}</Chip>}
          {agent.edits === false && <Chip icon={Eye} title={l("Solo lee: no edita archivos", "Read-only: never edits files")}>{l("lee", "reads")}</Chip>}
          {agent.run_in === "terminal" && <Chip icon={SquareTerminal} title={l("Trabaja en una terminal visible", "Works in a visible terminal")}>term</Chip>}
          {(agent.repos?.length ?? 0) > 0 && <Chip icon={FolderGit2} title={l(`Limitado a ${agent.repos?.length} repositorios`, `Limited to ${agent.repos?.length} repositories`)}>{agent.repos?.length}</Chip>}
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 border-t border-[var(--cf-border)] px-3 py-2 text-[11.5px] text-[var(--cf-text-muted)]">
        <span>{mine.length === 1 ? l("1 tarea", "1 task") : l(`${mine.length} tareas`, `${mine.length} tasks`)}</span>
        {spent > 0 && <span>· {money(spent)}</span>}
        {inTeams.length > 0 && <span className="inline-flex items-center gap-0.5">· <Users className="h-3 w-3" />{inTeams.length}</span>}
        <span className="flex-1" />
        {outdated && template && (
          <button type="button" title={l("La plantilla tiene una versión nueva: revisa qué cambió", "The template has a new version: review what changed")} onClick={() => onSync(template)} className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_14%,var(--cf-surface))] px-2 py-0.5 font-semibold text-[var(--cf-warning)]">
            <RefreshCw className="h-3 w-3" />
            v{template.version}
          </button>
        )}
      </div>
      {/* The actions slide up on hover or focus: nothing turns, nothing spins. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex translate-y-3 items-center justify-center gap-1 rounded-[12px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-1 opacity-0 shadow-[var(--cf-shadow)] transition-[opacity,transform] duration-150 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100">
        <Btn small kind="primary" icon={WandSparkles} title={l("Dale una tarea a este agente", "Hand this agent a task")} onClick={() => crew.open({ kind: "launch", assignee: { kind: "agent", id: agent.id } })}>{l("Tarea", "Task")}</Btn>
        <IconBtn title={l("Editar", "Edit")} onClick={() => crew.open({ kind: "wizard", agentId: agent.id })} icon={Pencil} />
        <IconBtn title={l("Duplicar", "Duplicate")} onClick={() => void useAgentsStore.getState().duplicateAgent(agent.id)} icon={Copy} />
        <IconBtn title={l("Guardar como plantilla", "Save as template")} onClick={() => void saveAsTemplate()} icon={BookMarked} />
        <IconBtn title={l("Borrar", "Delete")} onClick={() => void remove()} icon={Trash2} danger />
      </div>
    </motion.div>
  );
}

function TemplateEditor({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
  const l = useL();
  const [draft, setDraft] = useState<LibraryItem>(item);
  const body = draft.body as AgentTemplateBody;
  const setBody = (p: Partial<AgentTemplateBody>) => setDraft((d) => ({ ...d, body: { ...(d.body as AgentTemplateBody), ...p } }));
  const save = async () => {
    try {
      await useLibraryStore.getState().save(draft);
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  return (
    <Modal
      title={l(`Plantilla: ${item.name}`, `Template: ${item.name}`)}
      subtitle={isBuiltin(item.id) ? l("Es integrada: guardar crea tu copia, y siempre puedes volver a la original.", "It is built in: saving makes your copy, and you can always go back to the original.") : l("Los agentes hechos con ella podrán actualizarse a esta versión.", "Agents made from it can update to this version.")}
      leading={<AgentAvatar agent={{ id: item.id, icon: draft.icon, color: draft.color }} size={40} />}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Btn kind="ghost" title={l("Cierra sin guardar los cambios", "Closes without saving changes")} onClick={onClose}>{l("Cancelar", "Cancel")}</Btn>
          <Btn kind="primary" icon={Save} title={l("Guarda la plantilla en tu biblioteca", "Saves the template to your library")} onClick={() => void save()}>{l("Guardar", "Save")}</Btn>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={l("Nombre", "Name")} className={field} />
        <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={l("Descripción", "Description")} className={field} />
        <input value={body.provider} onChange={(e) => setBody({ provider: e.target.value.trim() })} placeholder="claude" className={`${field} font-mono`} />
        <input value={body.model} onChange={(e) => setBody({ model: e.target.value.trim() })} placeholder="claude-sonnet-…" className={`${field} font-mono`} />
      </div>
      <input value={body.role} onChange={(e) => setBody({ role: e.target.value })} placeholder={l("Papel", "Role")} className={field} />
      <textarea value={body.prompt} onChange={(e) => setBody({ prompt: e.target.value })} rows={9} className={`${field} h-auto resize-y py-2 font-mono text-[12px]`} />
    </Modal>
  );
}

function LibraryTab() {
  const l = useL();
  const crew = useCrewStore();
  const library = useLibrary();
  const saved = useLibraryStore((s) => s.saved);
  const roster = useAgentsStore((s) => s.roster);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<LibraryItem | null>(null);
  const match = (t: LibraryItem) => `${t.name} ${t.description}`.toLowerCase().includes(q.trim().toLowerCase());
  const agents = library.filter((t) => t.kind === "agent" && match(t));
  const teams = library.filter((t) => t.kind === "team" && match(t));

  const card = (t: LibraryItem, i: number) => {
    const edited = Boolean(t.based_on);
    const own = !isBuiltin(t.id) && !t.based_on;
    const used = roster.filter((a) => a.template_id === t.id).length;
    const team = t.kind === "team" ? (t.body as TeamTemplateBody) : null;
    return (
      <motion.div key={t.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: Math.min(i, 12) * 0.025 }} className="flex flex-col gap-2 rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3">
        <div className="flex items-center gap-2.5">
          {team ? <TeamAvatar size={34} /> : <AgentAvatar agent={{ id: t.id, icon: t.icon, color: t.color }} size={34} />}
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13px]">{t.name}</b>
            <span className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-faint)]">
              {team ? l(`${team.slots.length} puestos`, `${team.slots.length} seats`) : (t.body as AgentTemplateBody).model}
              {edited && <Chip tone="info" title={l("Es tu versión de una plantilla integrada", "Your own version of a built-in template")}>{l("editada", "edited")}</Chip>}
              {own && <Chip tone="accent" title={l("Plantilla creada por ti", "A template you created")}>{l("tuya", "yours")}</Chip>}
            </span>
          </span>
        </div>
        <p className="m-0 line-clamp-2 min-h-[34px] text-[12px] text-[var(--cf-text-muted)]">{t.description}</p>
        <div className="flex items-center gap-1">
          <Btn small kind="primary" icon={Plus} title={team ? l("Crea un equipo en este workspace desde la plantilla", "Creates a team in this workspace from the template") : l("Crea un agente en este workspace desde la plantilla", "Creates an agent in this workspace from the template")} onClick={() => crew.open(team ? { kind: "teamTemplates" } : { kind: "wizard", templateId: t.id })}>{l("Usar aquí", "Use here")}</Btn>
          {used > 0 && <span title={l("Agentes de este workspace creados con esta plantilla", "Agents in this workspace made from this template")} className="text-[11px] text-[var(--cf-text-faint)]">{l(`${used} en uso`, `${used} in use`)}</span>}
          <span className="flex-1" />
          {!team && <IconBtn title={l("Editar", "Edit")} onClick={() => setEditing(t)} icon={Pencil} />}
          {edited && (
            <IconBtn
              title={l("Volver a la original", "Back to the original")}
              icon={RotateCcw}
              onClick={() => void useLibraryStore.getState().remove(t.id)}
            />
          )}
          {own && <IconBtn title={l("Borrar", "Delete")} icon={Trash2} danger onClick={() => void confirmAction(l(`¿Borrar la plantilla «${t.name}»?`, `Delete template «${t.name}»?`)).then((ok) => { if (ok) void useLibraryStore.getState().remove(t.id); })} />}
        </div>
      </motion.div>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={l("Buscar plantillas", "Search templates")} className={`${field} w-[240px] pl-8`} />
          </label>
          <span className="text-[12px] text-[var(--cf-text-muted)]">{l(`La biblioteca es tuya, la ven todos tus workspaces. ${saved.length} propias o editadas.`, `The library is yours, every workspace sees it. ${saved.length} own or edited.`)}</span>
        </div>
        <section className="flex flex-col gap-2">
          <Label>{l("Agentes", "Agents")}</Label>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{agents.map(card)}</div>
        </section>
        <section className="flex flex-col gap-2">
          <Label>{l("Equipos", "Teams")}</Label>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{teams.map(card)}</div>
        </section>
      </div>
      {editing && <TemplateEditor item={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function RosterSpace() {
  const l = useL();
  const crew = useCrewStore();
  const roster = useAgentsStore((s) => s.roster);
  const [tab, setTab] = useState<"roster" | "library">("roster");
  const [q, setQ] = useState("");
  const [sync, setSync] = useState<{ agent: WorkspaceAgent; template: LibraryItem } | null>(null);
  const shown = roster.filter((a) => `${a.name} ${a.role} ${a.model}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <Seg
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: "roster", label: l("En este workspace", "In this workspace"), icon: Bot, badge: <span className="text-[10.5px] text-[var(--cf-text-faint)]">{roster.length}</span> },
            { value: "library", label: l("Biblioteca", "Library"), icon: LayoutTemplate },
          ]}
        />
        {tab === "roster" && (
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={l("Buscar", "Search")} className={`${field} h-[28px] w-[200px] pl-8`} />
          </label>
        )}
        <span className="flex-1" />
        <Btn small kind="primary" icon={Plus} title={l("Crea un agente en blanco o desde una plantilla", "Creates an agent, blank or from a template")} onClick={() => crew.open({ kind: "wizard" })}>{l("Nuevo agente", "New agent")}</Btn>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="flex min-h-0 flex-1 flex-col">
          {tab === "library" ? (
            <LibraryTab />
          ) : roster.length === 0 ? (
            <Empty icon={Bot} title={l("Todavía no hay agentes", "No agents yet")} hint={l("Empieza por una plantilla (Tech lead, Backend, QA, Asesor…) y ajústala, o créalo en blanco.", "Start from a template (Tech lead, Backend, QA, Advisor…) and tweak it, or build one from scratch.")}>
              <div className="mt-2 flex gap-2">
                <Btn kind="primary" icon={Plus} title={l("Abre el asistente para crear tu primer agente", "Opens the wizard to create your first agent")} onClick={() => crew.open({ kind: "wizard" })}>{l("Crear agente", "Create agent")}</Btn>
                <Btn icon={LayoutTemplate} title={l("Mira las plantillas de agentes y equipos", "Browse the agent and team templates")} onClick={() => setTab("library")}>{l("Ver plantillas", "See templates")}</Btn>
              </div>
            </Empty>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className="mx-auto grid max-w-[1300px] grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
                {shown.map((agent, index) => (
                  <AgentCard key={agent.id} agent={agent} index={index} onSync={(template) => setSync({ agent, template })} />
                ))}
                <motion.button
                  type="button"
                  layout
                  transition={SPRING}
                  title={l("Crea un agente nuevo", "Create a new agent")}
                  onClick={() => crew.open({ kind: "wizard" })}
                  className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed border-[var(--cf-border-strong)] text-[12.5px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                >
                  <Plus className="h-6 w-6" />
                  {l("Nuevo agente", "New agent")}
                </motion.button>
              </div>
              <p className="mx-auto mt-4 max-w-[1300px] text-[11.5px] text-[var(--cf-text-faint)]">{l("Arrastra una tarjeta sobre otra para cambiar el orden del dock.", "Drag a card onto another to change the dock's order.")}</p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
      {sync && <SyncDialog agent={sync.agent} template={sync.template} onClose={() => setSync(null)} />}
    </div>
  );
}
