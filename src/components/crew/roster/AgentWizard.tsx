/**
 * Making (or editing) an agent in four steps — where it starts from, who it is, what thinks for it,
 * what it may touch — with the agent drawn live on the right as it takes shape.
 */
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Brain, Check, Eye, FilePlus2, FolderGit2, Pencil, Search, ShieldCheck, Sparkles, SquareTerminal, UserRound } from "lucide-react";
import { AI_PROVIDERS } from "../../../lib/aiProviders";
import { AGENT_ICONS, searchIcons } from "../../../lib/agents/agentIcons";
import { AGENT_COLORS, COLOR_NAMES } from "../../../lib/agents/agentColors";
import { draftFromTemplate, templateSyncPlan, type AgentTemplateBody } from "../../../lib/agents/builtinTemplates";
import { useEffortSupported } from "../../../lib/useEffortSupport";
import { CHAT_EFFORTS } from "../../../lib/tauri/chatCommands";
import { SYSTEM_ACCOUNT } from "../../../lib/aiAccounts";
import { draftOf, useAgentsStore } from "../../../state/agentsStore";
import { useLibraryStore } from "../../../state/libraryStore";
import { useLanguageStore } from "../../../state/languageStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { isProviderReady, useProviderStatusStore } from "../../../state/providerStatusStore";
import { useAiAccountsStore, useProviderAccounts } from "../../../state/aiAccountsStore";
import { pushErrorToast } from "../../../state/toastStore";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import type { AgentDraft } from "../../../types/domain";
import type { LibraryItem } from "../../../types/crew";
import { TemplateActions, TemplateEditor } from "./TemplateEditor";
import { AgentAvatar } from "../kit/Avatar";
import { useModelOptions } from "../kit/models";
import { SelectBox, Btn, Chip, Label, Modal, Seg, SPRING, Stepper, Switch, ToggleChip, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";

type Step = "template" | "identity" | "brain" | "scope";
const NO_PROJECTS: never[] = [];

function blank(workspaceId: string): AgentDraft {
  return {
    id: null,
    workspace_id: workspaceId,
    name: "",
    role: "",
    provider: "claude",
    model: "",
    prompt: "",
    enabled: true,
    account_id: null,
    effort: "",
    icon: "",
    color: "",
    edits: true,
    repos: [],
    run_in: "headless",
    max_parallel: 1,
    model_ladder: [],
    template_id: "",
    template_version: 0,
    overrides: [],
    perms: [],
  };
}

function Preview({ draft }: { draft: AgentDraft }) {
  const l = useL();
  const [hover, setHover] = useState(false);
  const provider = AI_PROVIDERS.find((p) => p.id === draft.provider);
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-[var(--cf-border)] p-5 text-center" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <motion.div key={`${draft.icon}-${draft.color}`} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING}>
        <AgentAvatar agent={{ id: draft.id ?? draft.name ?? "new", icon: draft.icon, color: draft.color }} size={84} state={hover ? "thinking" : "idle"} />
      </motion.div>
      <div className="min-w-0">
        <b className="block truncate text-[15px]">{draft.name || l("Sin nombre", "Unnamed")}</b>
        <span className="block text-[12px] text-[var(--cf-text-muted)]">{draft.role || l("Su papel", "Its role")}</span>
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {draft.provider && (
          <Chip title={l("Motor (CLI) que lo ejecuta", "Engine (CLI) that runs it")}>
            <ProviderGlyph providerId={draft.provider} size={12} />
            {provider?.label ?? draft.provider}
          </Chip>
        )}
        {draft.model && <Chip tone="accent" title={l("Modelo", "Model")}>{draft.model}</Chip>}
        {draft.effort && <Chip tone="violet" title={l("Esfuerzo de razonamiento", "Reasoning effort")}>{draft.effort}</Chip>}
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        <Chip tone={draft.edits ? "ok" : "neutral"} icon={draft.edits ? Pencil : Eye} title={draft.edits ? l("Puede editar archivos y correr comandos", "Can edit files and run commands") : l("Solo lee y responde, no toca archivos", "Only reads and answers, never touches files")}>{draft.edits ? l("Edita", "Edits") : l("Solo lee", "Reads only")}</Chip>
        {draft.run_in === "terminal" && <Chip icon={SquareTerminal} title={l("En un equipo trabaja en una terminal visible", "In a team it works in a visible terminal")}>{l("Terminal", "Terminal")}</Chip>}
        {draft.max_parallel > 1 && <Chip title={l("Tareas que puede llevar a la vez", "Tasks it can carry at once")}>×{draft.max_parallel}</Chip>}
        {draft.repos.length > 0 && <Chip icon={FolderGit2} title={l(`Limitado a ${draft.repos.length} repositorios`, `Limited to ${draft.repos.length} repositories`)}>{draft.repos.length}</Chip>}
      </div>
      <p className="m-0 text-[11px] text-[var(--cf-text-faint)]">{l("Pasa el mouse: así se ve cuando trabaja.", "Hover: this is how it looks at work.")}</p>
    </div>
  );
}

function TemplateStep({ onPick }: { onPick: (t: LibraryItem | null) => void }) {
  const l = useL();
  const saved = useLibraryStore((s) => s.saved);
  const lang = useLanguageStore((s) => s.language);
  const templates = useMemo(() => useLibraryStore.getState().all().filter((t) => t.kind === "agent"), [saved, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState<LibraryItem | null>(null);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <motion.button type="button" transition={SPRING} title={l("Empieza un agente vacío", "Starts an empty agent")} onClick={() => onPick(null)} className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-[var(--cf-border-strong)] p-3 text-left transition-colors hover:border-[var(--cf-accent)] hover:bg-[var(--cf-hover)]">
        <span className="grid h-9 w-9 place-items-center rounded-[11px] bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]"><FilePlus2 className="h-4 w-4" /></span>
        <b className="text-[12.5px]">{l("En blanco", "Blank")}</b>
        <span className="text-[11.5px] text-[var(--cf-text-muted)]">{l("Lo armas tú desde cero.", "You build it from scratch.")}</span>
      </motion.button>
      {templates.map((t, i) => (
        <motion.div key={t.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: Math.min(i, 12) * 0.025 }} className="group relative flex">
        <button
          type="button"
          onClick={() => onPick(t)}
          title={l(`Usar «${t.name}» como punto de partida`, `Use «${t.name}» as the starting point`)}
          className="flex w-full flex-col items-start gap-2 rounded-lg border border-[var(--cf-border)] p-3 text-left transition-colors hover:border-[var(--cf-accent-line)] hover:bg-[var(--cf-hover)]"
        >
          <AgentAvatar agent={{ id: t.id, icon: t.icon, color: t.color }} size={36} />
          <b className="text-[12.5px]">{t.name}</b>
          <span className="line-clamp-2 text-[11.5px] text-[var(--cf-text-muted)]">{t.description}</span>
          <span className="font-mono text-[10.5px] text-[var(--cf-text-faint)]">{(t.body as AgentTemplateBody).model}</span>
        </button>
        <span className="absolute right-2 top-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <TemplateActions item={t} onEdit={() => setEditing(t)} />
        </span>
        </motion.div>
      ))}
      {editing && <TemplateEditor item={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function IdentityStep({ draft, patch }: { draft: AgentDraft; patch: (p: Partial<AgentDraft>) => void }) {
  const l = useL();
  const [q, setQ] = useState("");
  const icons = searchIcons(q);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>{l("Nombre", "Name")}</Label>
          <input autoFocus value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder={l("Ej. Backend", "e.g. Backend")} className={field} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{l("Papel", "Role")}</Label>
          <input value={draft.role} onChange={(e) => patch({ role: e.target.value })} placeholder={l("Qué hace, en una línea", "What it does, in a line")} className={field} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{l("Color", "Colour")}</Label>
        <div className="flex flex-wrap gap-2">
          {AGENT_COLORS.map((c) => (
            <motion.button
              key={c}
              type="button"
              transition={SPRING}
              aria-label={l(COLOR_NAMES[c][0], COLOR_NAMES[c][1])}
              title={l(COLOR_NAMES[c][0], COLOR_NAMES[c][1])}
              onClick={() => patch({ color: c })}
              className="grid h-7 w-7 place-items-center rounded-full"
              style={{ background: `var(--cf-agent-${c})`, boxShadow: draft.color === c ? `0 0 0 2px var(--cf-surface), 0 0 0 4px var(--cf-agent-${c})` : undefined }}
            >
              {draft.color === c && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
            </motion.button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="flex-1"><Label>{l("Icono", "Icon")}</Label></span>
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={l("líder, datos, test…", "lead, data, test…")} title={l("Busca un icono por palabra", "Search an icon by word")} className={`${field} !w-[180px] pl-7`} />
          </label>
        </div>
        <div className="grid max-h-[220px] grid-cols-8 gap-1.5 overflow-auto rounded-lg border border-[var(--cf-border)] p-2 sm:grid-cols-10">
          {icons.map(({ id, Icon }) => {
            const on = draft.icon === id;
            return (
              <button
                key={id}
                type="button"
                title={id}
                aria-pressed={on}
                onClick={() => patch({ icon: id })}
                className={`grid aspect-square place-items-center rounded-[9px] transition-colors ${on ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1.5px_var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"}`}
              >
                <Icon className="h-[18px] w-[18px]" />
              </button>
            );
          })}
          {icons.length === 0 && <span className="col-span-full p-2 text-[12px] text-[var(--cf-text-muted)]">{l(`Nada con «${q}». Hay ${AGENT_ICONS.length} iconos.`, `Nothing for «${q}». There are ${AGENT_ICONS.length} icons.`)}</span>}
        </div>
      </div>
    </div>
  );
}

function BrainStep({ draft, patch }: { draft: AgentDraft; patch: (p: Partial<AgentDraft>) => void }) {
  const l = useL();
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);
  const accounts = useProviderAccounts(draft.provider);
  const models = useModelOptions(draft.provider);
  const effortOk = useEffortSupported(draft.provider, draft.model);
  const known = models.some((m) => m.id === draft.model);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    void ensureAccounts();
    if (Object.keys(useProviderStatusStore.getState().byProvider).length === 0) void checkAll();
  }, [ensureAccounts, checkAll]);

  const providers = AI_PROVIDERS.filter((p) => p.available && (isProviderReady(statuses, p.id) || p.id === draft.provider));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>{l("Motor", "Engine")}</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {providers.map((p) => {
            const on = p.id === draft.provider;
            return (
              <motion.button
                key={p.id}
                type="button"
                transition={SPRING}
                onClick={() => patch({ provider: p.id, model: "", effort: "", account_id: null, model_ladder: [] })}
                title={l(`Usar ${p.label} como motor`, `Use ${p.label} as the engine`)}
                className={`relative flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors ${on ? "border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)]" : "border-[var(--cf-border)] hover:bg-[var(--cf-hover)]"}`}
              >
                <ProviderGlyph providerId={p.id} size={16} />
                <span className="truncate">{p.label}</span>
                
              </motion.button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{l("Modelo", "Model")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {models.filter((m) => !m.legacy).map((m) => (
            <ToggleChip key={m.id} on={draft.model === m.id && !custom} title={m.id} onClick={() => { setCustom(false); patch({ model: m.id }); }}>
              {m.label}
            </ToggleChip>
          ))}
          {models.some((m) => m.legacy) && (
            <SelectBox value={models.some((m) => m.legacy && m.id === draft.model) ? draft.model : ""} onChange={(v) => v && patch({ model: v })} className="w-[150px] shrink-0" compact>
              <option value="">{l("Anteriores…", "Older…")}</option>
              {models.filter((m) => m.legacy).map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </SelectBox>
          )}
          <ToggleChip on={custom || (!!draft.model && !known)} title={l("Escribe el id exacto de otro modelo", "Type the exact id of another model")} onClick={() => setCustom(true)}>{l("Otro…", "Other…")}</ToggleChip>
        </div>
        {(custom || (!!draft.model && !known)) && <input value={draft.model} onChange={(e) => patch({ model: e.target.value.trim() })} placeholder={l("El id exacto que recibe el CLI", "The exact id the CLI takes")} className={`${field} font-mono`} />}
      </div>
      {effortOk && (
        <div className="flex flex-col gap-1.5">
          <Label>{l("Razonamiento", "Reasoning")}</Label>
          <Seg
            size="sm"
            value={draft.effort || "default"}
            onChange={(v) => patch({ effort: v === "default" ? "" : v })}
            options={[
              { value: "default", label: l("Por defecto", "Default"), title: l("El nivel que el modelo usa si no se le pide otro", "The level the model uses when not asked for another") },
              ...CHAT_EFFORTS.map((e) => ({ value: e, label: e, title: l(`Piensa con esfuerzo «${e}» en cada turno: más esfuerzo, mejores respuestas difíciles, pero más lento y más gasto`, `Thinks at «${e}» effort each turn: more effort answers hard problems better, but slower and costlier`) })),
            ]}
          />
        </div>
      )}
      {accounts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>{l("Cuenta", "Account")}</Label>
          <SelectBox value={draft.account_id ?? ""} onChange={(v) => patch({ account_id: v || null })} className="w-full">
            <option value="">{l("Automática (la del workspace)", "Automatic (the workspace's)")}</option>
            <option value={SYSTEM_ACCOUNT}>{l("La del sistema", "System login")}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </SelectBox>
        </div>
      )}
    </div>
  );
}

function ScopeStep({ draft, patch }: { draft: AgentDraft; patch: (p: Partial<AgentDraft>) => void }) {
  const l = useL();
  const projects = useWorkspaceStore((s) => (s.activeWorkspaceId ? s.projectsByWorkspace[s.activeWorkspaceId] ?? NO_PROJECTS : NO_PROJECTS));
  const models = useModelOptions(draft.provider);
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-[var(--cf-border)] px-3 py-1.5">
        <Switch checked={draft.edits} onChange={(edits) => patch({ edits })} label={l("Puede editar archivos", "Can edit files")} hint={draft.edits ? l("Escribe código y corre comandos en su worktree.", "Writes code and runs commands in its worktree.") : l("Sus turnos corren en modo análisis: lee y responde, no toca nada.", "Its turns run in analysis mode: it reads and answers, touches nothing.")} />
        <Switch checked={draft.enabled} onChange={(enabled) => patch({ enabled })} label={l("Activo", "Active")} hint={l("Apagado no aparece en el dock ni se le asigna trabajo.", "Off, it leaves the dock and gets no work.")} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{l("Repositorios que puede tocar (vacío: los de cada tarea)", "Repositories it may touch (empty: each task's)")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {projects.map((p) => (
            <ToggleChip key={p.id} icon={FolderGit2} on={draft.repos.includes(p.id)} title={draft.repos.includes(p.id) ? l(`Quitar ${p.name} de su alcance`, `Remove ${p.name} from its scope`) : l(`Dejarle tocar ${p.name}`, `Let it touch ${p.name}`)} onClick={() => patch({ repos: draft.repos.includes(p.id) ? draft.repos.filter((x) => x !== p.id) : [...draft.repos, p.id] })}>
              {p.name}
            </ToggleChip>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>{l("Dentro de un equipo corre en", "In a team it runs in")}</Label>
          <Seg size="sm" value={draft.run_in} onChange={(run_in) => patch({ run_in })} options={[{ value: "headless", label: l("Fondo", "Background"), title: l("Trabaja sin ventana, en segundo plano", "Works with no window, in the background") }, { value: "terminal", label: "Terminal", icon: SquareTerminal, title: l("Trabaja en una terminal que puedes mirar", "Works in a terminal you can watch") }]} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{l("Tareas a la vez", "Tasks at once")}</Label>
          <Stepper value={draft.max_parallel} min={1} max={6} onChange={(max_parallel) => patch({ max_parallel })} label={l("Tareas a la vez", "Tasks at once")} />
        </div>
      </div>
      {models.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label>{l("Escalera de modelos al reintentar", "Model ladder on retry")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {models.filter((m) => !m.legacy).map((m) => {
              const index = draft.model_ladder.indexOf(m.id);
              return (
                <ToggleChip key={m.id} on={index >= 0} title={index >= 0 ? l(`Intento ${index + 1} al reintentar · clic para quitarlo`, `Attempt ${index + 1} on retry · click to remove`) : l("Añadir a la escalera: se usa si un intento falla", "Add to the ladder: used if an attempt fails")} onClick={() => patch({ model_ladder: index >= 0 ? draft.model_ladder.filter((x) => x !== m.id) : [...draft.model_ladder, m.id] })}>
                  {index >= 0 && <b className="tabular-nums">{index + 1}</b>}
                  {m.label}
                </ToggleChip>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label>{l("Instrucciones", "Instructions")}</Label>
        <textarea value={draft.prompt} onChange={(e) => patch({ prompt: e.target.value })} rows={7} placeholder={l("Cómo trabaja, qué cuida, qué nunca hace…", "How it works, what it guards, what it never does…")} className={`${field} h-auto resize-y py-2 font-mono text-[12px] leading-relaxed`} />
      </div>
    </div>
  );
}

export function AgentWizard({ templateId, agentId }: { templateId?: string; agentId?: string }) {
  const l = useL();
  const crew = useCrewStore();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId) ?? "";
  const roster = useAgentsStore((s) => s.roster);
  const existing = agentId ? roster.find((a) => a.id === agentId) : undefined;
  const [draft, setDraft] = useState<AgentDraft>(() => {
    if (existing) return draftOf(existing);
    const template = templateId ? useLibraryStore.getState().all().find((t) => t.id === templateId) : undefined;
    return template ? draftFromTemplate(template, workspaceId, roster.map((a) => a.name)) : blank(workspaceId);
  });
  const steps: Step[] = existing || templateId ? ["identity", "brain", "scope"] : ["template", "identity", "brain", "scope"];
  const [step, setStep] = useState<Step>(steps[0]);
  const [dir, setDir] = useState(1);
  const [busy, setBusy] = useState(false);
  const index = steps.indexOf(step);
  const patch = (p: Partial<AgentDraft>) => setDraft((d) => ({ ...d, ...p }));

  const go = (next: Step) => {
    setDir(steps.indexOf(next) > index ? 1 : -1);
    setStep(next);
  };
  const ready = draft.name.trim() !== "" && draft.provider !== "" && draft.model !== "";

  const save = async () => {
    setBusy(true);
    try {
      let next = { ...draft, name: draft.name.trim() };
      if (next.template_id) {
        const template = useLibraryStore.getState().all().find((t) => t.id === next.template_id);
        if (template) next = { ...next, overrides: templateSyncPlan(next, template).map((c) => c.field) };
      }
      const saved = await useAgentsStore.getState().saveAgent(next);
      crew.set({ focus: saved.id });
      crew.close();
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(false);
    }
  };

  const labels: Record<Step, { es: string; en: string; icon: typeof Sparkles }> = {
    template: { es: "Plantilla", en: "Template", icon: Sparkles },
    identity: { es: "Identidad", en: "Identity", icon: UserRound },
    brain: { es: "Cerebro", en: "Brain", icon: Brain },
    scope: { es: "Alcance", en: "Scope", icon: ShieldCheck },
  };

  return (
    <Modal
      wide
      title={existing ? l(`Editar ${existing.name}`, `Edit ${existing.name}`) : l("Nuevo agente", "New agent")}
      subtitle={l("Un agente es un papel con su motor, su modelo y su alcance. Se puede sumar a equipos y recibir tareas solo.", "An agent is a role with its engine, model and scope. It can join teams and take tasks on its own.")}
      onClose={crew.close}
      footer={
        <>
          {index > 0 && <Btn kind="ghost" icon={ArrowLeft} title={l("Paso anterior", "Previous step")} onClick={() => go(steps[index - 1])}>{l("Atrás", "Back")}</Btn>}
          <span className="flex-1 text-[12px] text-[var(--cf-text-faint)]">{!ready && step !== "template" ? l("Falta nombre, motor o modelo.", "Name, engine or model missing.") : ""}</span>
          {step !== "template" && index < steps.length - 1 && <Btn icon={ArrowRight} title={l("Paso siguiente", "Next step")} onClick={() => go(steps[index + 1])}>{l("Siguiente", "Next")}</Btn>}
          {step !== "template" && (
            <Btn kind="primary" icon={Check} disabled={!ready || busy} title={ready ? l("Guarda el agente con lo que ves", "Saves the agent as shown") : l("Falta nombre, motor o modelo", "Name, engine or model missing")} onClick={() => void save()}>
              {busy ? l("Guardando…", "Saving…") : existing ? l("Guardar", "Save") : l("Crear agente", "Create agent")}
            </Btn>
          )}
        </>
      }
    >
      <div className="flex items-center gap-1.5">
        {steps.map((s, i) => {
          const L = labels[s];
          const on = s === step;
          const done = i < index;
          return (
            <button key={s} type="button" title={l(`Ir a «${L.es}»`, `Go to «${L.en}»`)} onClick={() => (s !== "template" || !existing) && go(s)} className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors ${on ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : done ? "text-[var(--cf-text)] hover:bg-[var(--cf-hover)]" : "text-[var(--cf-text-faint)] hover:bg-[var(--cf-hover)]"}`}>
              <span className={`grid h-[18px] w-[18px] place-items-center rounded-full text-[10.5px] ${on ? "bg-[var(--cf-accent)] text-[var(--cf-on-accent)]" : done ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]" : "bg-[var(--cf-hover)]"}`}>{done ? <Check className="h-3 w-3" /> : i + 1}</span>
              <span className="hidden sm:inline">{l(L.es, L.en)}</span>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_260px]">
        <div className="relative min-w-0 overflow-hidden">
          <AnimatePresence mode="wait" initial={false} custom={dir}>
            <motion.div key={step} custom={dir} initial={{ opacity: 0, x: 24 * dir }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 * dir }} transition={{ duration: 0.18 }}>
              {step === "template" && (
                <TemplateStep
                  onPick={(t) => {
                    setDraft(t ? draftFromTemplate(t, workspaceId, roster.map((a) => a.name)) : blank(workspaceId));
                    go("identity");
                  }}
                />
              )}
              {step === "identity" && <IdentityStep draft={draft} patch={patch} />}
              {step === "brain" && <BrainStep draft={draft} patch={patch} />}
              {step === "scope" && <ScopeStep draft={draft} patch={patch} />}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="hidden md:block">
          <div className="sticky top-0">
            <Preview draft={draft} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
