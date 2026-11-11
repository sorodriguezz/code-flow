/**
 * «Agentes»: the workspace's roster as a gallery. Templates are picked, edited and deleted in the
 * first step of «Nuevo agente» (`TemplateEditor.tsx`), not on a screen of their own.
 * Drag a card onto another to reorder; hover for what it has done and what you can do with it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { BookMarked, Bot, Copy, Eye, FolderGit2, MessageSquare, Pencil, Plus, RefreshCw, Search, SquareTerminal, Trash2, Users, WandSparkles } from "lucide-react";
import { draftOf, useAgentsStore } from "../../../state/agentsStore";
import { useLibraryStore } from "../../../state/libraryStore";
import { useLanguageStore } from "../../../state/languageStore";
import { useTeamStore } from "../../../state/teamStore";
import { confirmAction } from "../../../state/confirmStore";
import { pushErrorToast, pushSuccessToast } from "../../../state/toastStore";
import { templateSyncPlan, type AgentTemplateBody, type SyncChange } from "../../../lib/agents/builtinTemplates";
import { isPersonalAgent } from "../../../lib/agents/personalAgents";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import type { WorkspaceAgent } from "../../../types/domain";
import type { LibraryItem } from "../../../types/crew";
import { AgentAvatar } from "../kit/Avatar";
import { useDragSource, useDropTarget } from "../kit/drag";
import { Btn, Chip, Empty, IconBtn, Modal, SPRING, field } from "../kit/ui";
import { lNow, money, useAgentStates, useCrewStore, useL } from "../state";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { ConfigurationExportButton, ConfigurationImportButton } from "../ConfigurationSharing";
import { AGENT_CONFIGURATION } from "../../../lib/agents/shareConfiguration";

const AGENT_CARD_ACTIONS_CLASS = "pointer-events-none absolute inset-x-2 bottom-2 flex translate-y-3 flex-wrap items-center justify-center gap-1 rounded-[12px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-1 opacity-0 shadow-[var(--cf-shadow)] transition-[opacity,transform] duration-150 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100";
const ROSTER_GRID_CLASS = "grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-3";
const ROSTER_HINT_CLASS = "mt-4 text-[11.5px] text-[var(--cf-text-faint)]";

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
      <div {...drag} title={l("Arrastra para reordenar el dock", "Drag to reorder the dock")} className="flex flex-1 cursor-grab touch-none flex-col items-center gap-2 px-4 pb-3 pt-5 text-center active:cursor-grabbing">
        <AgentAvatar agent={agent} size={64} state={state} />
        <div className="min-w-0 max-w-full">
          <b className="block truncate text-[14px]">{agent.name}</b>
          <span title={agent.role || undefined} className="line-clamp-3 min-h-[32px] text-[12px] text-[var(--cf-text-muted)]">{agent.role || l("Sin papel", "No role")}</span>
        </div>
        <div className="mt-auto flex w-full flex-wrap justify-center gap-1">
          <Chip className="max-w-full" title={`${l("Modelo", "Model")}: ${agent.model || "—"}`}>
            <ProviderGlyph providerId={agent.provider} size={11} />
            <span className="truncate">{agent.model || "—"}</span>
          </Chip>
          {agent.effort && <Chip tone="violet" title={l("Esfuerzo de razonamiento", "Reasoning effort")}>{agent.effort}</Chip>}
          {agent.edits === false && <Chip icon={Eye} title={l("Solo lee: no edita archivos", "Read-only: never edits files")}>{l("lee", "reads")}</Chip>}
          {agent.run_in === "terminal" && <Chip icon={SquareTerminal} title={l("Trabaja en una terminal visible", "Works in a visible terminal")}>term</Chip>}
          {(agent.repos?.length ?? 0) > 0 && <Chip icon={FolderGit2} title={l(`Limitado a ${agent.repos?.length} repositorios`, `Limited to ${agent.repos?.length} repositories`)}>{agent.repos?.length}</Chip>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-2 text-[11.5px] text-[var(--cf-text-muted)]">
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
      <div className={AGENT_CARD_ACTIONS_CLASS}>
        <Btn small kind="primary" icon={WandSparkles} title={l("Dale una tarea a este agente", "Hand this agent a task")} onClick={() => crew.open({ kind: "launch", assignee: { kind: "agent", id: agent.id } })}>{l("Tarea", "Task")}</Btn>
        <IconBtn title={l("Conversa con este agente en el repositorio activo, como en el chat del repositorio: preguntas, imágenes, su modelo y su forma de trabajar", "Chat with this agent in the active repository, like the repository chat: questions, images, its model and its way of working")} onClick={() => void chatWith(agent)} icon={MessageSquare} />
        <IconBtn title={l("Editar", "Edit")} onClick={() => crew.open({ kind: "wizard", agentId: agent.id })} icon={Pencil} />
        <IconBtn title={l("Duplicar", "Duplicate")} onClick={() => void useAgentsStore.getState().duplicateAgent(agent.id)} icon={Copy} />
        <IconBtn title={l("Guardar como plantilla", "Save as template")} onClick={() => void saveAsTemplate()} icon={BookMarked} />
        <ConfigurationExportButton source={agent} compact />
        <IconBtn title={l("Borrar", "Delete")} onClick={() => void remove()} icon={Trash2} danger />
      </div>
    </motion.div>
  );
}

const EMPTY_AGENT_COUNT = 0;

export function RosterSpace() {
  const l = useL();
  const crew = useCrewStore();
  const roster = useAgentsStore((s) => s.roster);
  const [q, setQ] = useState("");
  const [sync, setSync] = useState<{ agent: WorkspaceAgent; template: LibraryItem } | null>(null);
  const personalAgents = roster.filter(isPersonalAgent);
  const trimmedQuery = q.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();
  const shown = personalAgents.filter((agent) => {
    const searchableText = `${agent.name} ${agent.role} ${agent.model}`;
    const normalizedText = searchableText.toLowerCase();
    return normalizedText.includes(normalizedQuery);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={l("Buscar agentes", "Search agents")} title={l("Filtra por nombre, papel o modelo", "Filter by name, role or model")} className={`${field} !w-[220px] pl-8`} />
        </label>
        <span className="text-[12px] text-[var(--cf-text-faint)]" title={l("Agentes en este workspace", "Agents in this workspace")}>{personalAgents.length}</span>
        <span className="flex-1" />
        <ConfigurationImportButton kind={AGENT_CONFIGURATION} />
        <Btn small kind="primary" icon={Plus} title={l("Crea un agente en blanco o desde una plantilla", "Creates an agent, blank or from a template")} onClick={() => crew.open({ kind: "wizard" })}>{l("Nuevo agente", "New agent")}</Btn>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
          {personalAgents.length === EMPTY_AGENT_COUNT ? (
            <Empty icon={Bot} title={l("Todavía no hay agentes", "No agents yet")} hint={l("Empieza por una plantilla (Tech lead, Backend, QA, Asesor…) y ajústala, o créalo en blanco.", "Start from a template (Tech lead, Backend, QA, Advisor…) and tweak it, or build one from scratch.")}>
              <div className="mt-2 flex gap-2">
                <Btn kind="primary" icon={Plus} title={l("Abre el asistente: empieza eligiendo una plantilla o en blanco", "Opens the wizard: start from a template or blank")} onClick={() => crew.open({ kind: "wizard" })}>{l("Crear agente", "Create agent")}</Btn>
              </div>
            </Empty>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className={ROSTER_GRID_CLASS}>
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
              <p className={ROSTER_HINT_CLASS}>{l("Arrastra una tarjeta sobre otra para cambiar el orden del dock.", "Drag a card onto another to change the dock's order.")}</p>
            </div>
          )}
      </div>
      {sync && <SyncDialog agent={sync.agent} template={sync.template} onClose={() => setSync(null)} />}
    </div>
  );
}

/** A conversation with one agent: a task with no goal yet, in the repository on screen, opened on
 *  its composer. Everything the repository chat brings (context, memory, images) comes with it. */
async function chatWith(agent: WorkspaceAgent): Promise<void> {
  const projectId = useWorkspaceStore.getState().activeProjectId;
  if (!projectId) {
    pushErrorToast(lNow("Abre un repositorio para conversar con el agente.", "Open a repository to chat with the agent."));
    return;
  }
  try {
    const task = await useAgentsStore.getState().create({ projectId, agent, goal: "" });
    await useAgentsStore.getState().rename(task.id, lNow(`Conversación con ${agent.name}`, `Chat with ${agent.name}`));
    useCrewStore.getState().open({ kind: "task", id: task.id });
  } catch (e) {
    pushErrorToast(String(e));
  }
}
