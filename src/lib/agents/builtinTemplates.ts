/**
 * The library's built-in templates. They live here rather than in the database so a release can
 * improve them; one lands in `agent_library` only when the user edits it (`based_on`).
 *
 * Bilingual inline instead of translation keys: a template is content, and its prompt has to be
 * written in the language the user reads, not translated word by word.
 */
import type { Language } from "../i18n/translations";
import type { AgentDraft } from "../../types/domain";
import type { LibraryItem } from "../../types/crew";
import type { TeamPolicy } from "../../types/team";

type Text = { es: string; en: string };

export interface AgentTemplateBody {
  v: 1;
  role: string;
  prompt: string;
  provider: string;
  model: string;
  effort: string;
  edits: boolean;
  run_in: "headless" | "terminal";
  max_parallel: number;
  model_ladder: string[];
  /** Marks the «Asesor» template: read-only, called at three moments, never writes code. */
  advisor?: boolean;
}

export interface TeamSlot {
  slot: string;
  agent_template: string;
  name: string;
  role: string;
  reports_to: string;
  leads?: boolean;
  hands_on?: boolean;
  advisor?: boolean;
}

export interface TeamTemplateBody {
  v: 1;
  slots: TeamSlot[];
  lead_slot: string;
  policy?: Partial<TeamPolicy>;
}

interface BuiltinAgent {
  key: string;
  name: Text;
  description: Text;
  icon: string;
  color: string;
  provider: string;
  model: string;
  effort: string;
  edits: boolean;
  run_in?: "headless" | "terminal";
  max_parallel?: number;
  model_ladder?: string[];
  advisor?: boolean;
  prompt: Text;
}

interface BuiltinTeam {
  key: string;
  name: Text;
  description: Text;
  slots: (Omit<TeamSlot, "name" | "role"> & { name: Text; role: Text })[];
  lead_slot: string;
  policy?: Partial<TeamPolicy>;
}

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

/** Bumped whenever a built-in's body changes, so agents made from it offer a sync. */
export const BUILTIN_VERSION = 1;

const AGENTS: BuiltinAgent[] = [
  {
    key: "tech-lead",
    name: { es: "Tech lead", en: "Tech lead" },
    description: { es: "Planifica, reparte el trabajo y revisa el resultado.", en: "Plans, splits the work and checks the result." },
    icon: "crown", color: "amber", provider: "claude", model: OPUS, effort: "high", edits: false,
    prompt: {
      es: "Lideras un equipo de agentes. Divide el objetivo en tareas pequeñas con dueño claro, cuida las dependencias y no escribas código tú mismo. Pregunta solo lo que el equipo no puede decidir.",
      en: "You lead a team of agents. Split the goal into small tasks with a clear owner, mind the dependencies and do not write code yourself. Ask only what the team cannot decide.",
    },
  },
  {
    key: "architect",
    name: { es: "Arquitecto", en: "Architect" },
    description: { es: "Diseña contratos y cuida la arquitectura.", en: "Designs contracts and guards the architecture." },
    icon: "landmark", color: "indigo", provider: "claude", model: OPUS, effort: "high", edits: true,
    prompt: {
      es: "Defines contratos (APIs, eventos, esquemas) antes de que otros implementen. Publica el contrato como artefacto para que el equipo lo use.",
      en: "You define contracts (APIs, events, schemas) before others implement. Publish the contract as an artifact for the team to use.",
    },
  },
  {
    key: "backend",
    name: { es: "Dev backend", en: "Backend dev" },
    description: { es: "Implementa APIs y lógica de negocio.", en: "Implements APIs and business logic." },
    icon: "server", color: "teal", provider: "claude", model: SONNET, effort: "medium", edits: true, max_parallel: 2,
    model_ladder: [OPUS],
    prompt: { es: "Implementas cambios de backend con tests. Sigue el contrato acordado y deja el repositorio compilando.", en: "You implement backend changes with tests. Follow the agreed contract and leave the repository building." },
  },
  {
    key: "frontend",
    name: { es: "Dev front", en: "Frontend dev" },
    description: { es: "Pantallas, estados y accesibilidad.", en: "Screens, states and accessibility." },
    icon: "monitor-smartphone", color: "magenta", provider: "claude", model: SONNET, effort: "medium", edits: true,
    model_ladder: [OPUS],
    prompt: { es: "Construyes interfaces accesibles y probadas, respetando el sistema de diseño del proyecto.", en: "You build accessible, tested interfaces that follow the project's design system." },
  },
  {
    key: "qa",
    name: { es: "QA", en: "QA" },
    description: { es: "Escribe y corre tests de punta a punta.", en: "Writes and runs end-to-end tests." },
    icon: "shield-check", color: "green", provider: "claude", model: SONNET, effort: "medium", edits: true,
    prompt: { es: "Verificas el trabajo del equipo: reproduces, escribes tests y reportas hallazgos concretos con archivo y línea.", en: "You verify the team's work: reproduce, write tests and report concrete findings with file and line." },
  },
  {
    key: "reviewer",
    name: { es: "Revisor", en: "Reviewer" },
    description: { es: "Revisa diffs contra las convenciones.", en: "Reviews diffs against the conventions." },
    icon: "glasses", color: "slate", provider: "claude", model: SONNET, effort: "high", edits: false,
    prompt: { es: "Revisas cambios sin editarlos. Separa lo obligatorio de lo opcional y sé breve.", en: "You review changes without editing them. Separate what must change from what is optional, and be brief." },
  },
  {
    key: "devops",
    name: { es: "DevOps", en: "DevOps" },
    description: { es: "Pipelines, contenedores y despliegue.", en: "Pipelines, containers and deployment." },
    icon: "rocket", color: "rose", provider: "claude", model: SONNET, effort: "medium", edits: true,
    prompt: { es: "Mantienes pipelines y configuración de infraestructura. Nunca despliegas sin que te lo pidan.", en: "You maintain pipelines and infrastructure config. Never deploy unless asked." },
  },
  {
    key: "docs",
    name: { es: "Docs", en: "Docs" },
    description: { es: "Documentación técnica y de producto.", en: "Technical and product documentation." },
    icon: "book-open", color: "lime", provider: "claude", model: HAIKU, effort: "low", edits: true,
    prompt: { es: "Escribes documentación clara y corta a partir del código y de lo que hizo el equipo.", en: "You write clear, short documentation from the code and from what the team did." },
  },
  {
    key: "dba",
    name: { es: "DBA", en: "DBA" },
    description: { es: "Esquemas, índices y migraciones.", en: "Schemas, indexes and migrations." },
    icon: "database", color: "cyan", provider: "claude", model: SONNET, effort: "high", edits: true,
    prompt: { es: "Diseñas esquemas y migraciones reversibles, y revisas el costo de las consultas.", en: "You design reversible schemas and migrations, and check what queries cost." },
  },
  {
    key: "scout",
    name: { es: "Explorador", en: "Scout" },
    description: { es: "Busca, mapea y audita barato, en paralelo.", en: "Searches, maps and audits cheaply, in parallel." },
    icon: "search-code", color: "blue", provider: "claude", model: HAIKU, effort: "low", edits: false, max_parallel: 3,
    prompt: { es: "Investigas sin editar: dónde está algo, quién lo usa, qué se rompe. Respondes con rutas y líneas, en pocas palabras.", en: "You investigate without editing: where something is, who uses it, what breaks. Answer with paths and lines, briefly." },
  },
  {
    key: "advisor",
    name: { es: "Asesor", en: "Advisor" },
    description: { es: "Lee la corrida y aconseja en tres momentos. Nunca escribe código.", en: "Reads the run and advises at three moments. Never writes code." },
    icon: "brain", color: "purple", provider: "claude", model: OPUS, effort: "high", edits: false, advisor: true,
    prompt: {
      es: "Eres el asesor del equipo. Te llaman antes del plan, cuando un error se repite y antes de terminar. Lee el resumen, da como mucho tres consejos accionables y no repitas lo obvio.",
      en: "You are the team's advisor. You are called before the plan, when an error repeats and before finishing. Read the summary, give at most three actionable pieces of advice and skip the obvious.",
    },
  },
];

const TEAMS: BuiltinTeam[] = [
  {
    key: "squad-backend",
    name: { es: "Squad backend", en: "Backend squad" },
    description: { es: "Un líder, dos devs y QA que revisa lo que se escribe.", en: "A lead, two devs and QA reviewing what gets written." },
    lead_slot: "lead",
    slots: [
      { slot: "lead", agent_template: "tech-lead", name: { es: "Líder", en: "Lead" }, role: { es: "Planifica y reparte", en: "Plans and splits" }, reports_to: "" },
      { slot: "dev1", agent_template: "backend", name: { es: "Dev 1", en: "Dev 1" }, role: { es: "Backend", en: "Backend" }, reports_to: "lead" },
      { slot: "dev2", agent_template: "backend", name: { es: "Dev 2", en: "Dev 2" }, role: { es: "Backend", en: "Backend" }, reports_to: "lead" },
      { slot: "qa", agent_template: "qa", name: { es: "QA", en: "QA" }, role: { es: "Revisa y prueba", en: "Reviews and tests" }, reports_to: "lead" },
    ],
  },
  {
    key: "feature-fullstack",
    name: { es: "Feature full-stack", en: "Full-stack feature" },
    description: { es: "Arquitecto al mando, con sub-líderes de back y de front, y un asesor de guardia.", en: "Architect in charge, with back and front sub-leads, and an advisor on call." },
    lead_slot: "arch",
    slots: [
      { slot: "arch", agent_template: "architect", name: { es: "Arquitecto", en: "Architect" }, role: { es: "Contrato y plan", en: "Contract and plan" }, reports_to: "" },
      { slot: "back", agent_template: "backend", name: { es: "Sub-líder back", en: "Back sub-lead" }, role: { es: "Lidera el backend", en: "Leads the backend" }, reports_to: "arch", leads: true, hands_on: true },
      { slot: "front", agent_template: "frontend", name: { es: "Sub-líder front", en: "Front sub-lead" }, role: { es: "Lidera el front", en: "Leads the front" }, reports_to: "arch", leads: true, hands_on: true },
      { slot: "qa", agent_template: "qa", name: { es: "QA", en: "QA" }, role: { es: "Tests E2E", en: "E2E tests" }, reports_to: "back" },
      { slot: "rev", agent_template: "reviewer", name: { es: "Revisor", en: "Reviewer" }, role: { es: "Convenciones", en: "Conventions" }, reports_to: "front" },
      { slot: "adv", agent_template: "advisor", name: { es: "Asesor", en: "Advisor" }, role: { es: "De guardia", en: "On call" }, reports_to: "arch", advisor: true },
    ],
  },
  {
    key: "bugfix-qa",
    name: { es: "Bugfix con QA", en: "Bugfix with QA" },
    description: { es: "Un explorador ubica, un dev corrige y QA verifica.", en: "A scout locates, a dev fixes and QA verifies." },
    lead_slot: "dev",
    slots: [
      { slot: "dev", agent_template: "backend", name: { es: "Dev", en: "Dev" }, role: { es: "Corrige", en: "Fixes" }, reports_to: "" },
      { slot: "scout", agent_template: "scout", name: { es: "Explorador", en: "Scout" }, role: { es: "Ubica la causa", en: "Finds the cause" }, reports_to: "dev" },
      { slot: "qa", agent_template: "qa", name: { es: "QA", en: "QA" }, role: { es: "Reproduce y verifica", en: "Reproduces and verifies" }, reports_to: "dev" },
    ],
  },
];

const pick = (lang: Language, text: Text) => (lang === "es" ? text.es : text.en);

/** The built-in templates as library rows, in the reader's language. Ids are `builtin:<key>`. */
export function builtinLibrary(lang: Language): LibraryItem[] {
  const agents: LibraryItem[] = AGENTS.map((a, index) => ({
    id: `builtin:${a.key}`,
    kind: "agent",
    name: pick(lang, a.name),
    description: pick(lang, a.description),
    icon: a.icon,
    color: a.color,
    tags: a.advisor ? ["advisor"] : [],
    body: {
      v: 1,
      role: pick(lang, a.description),
      prompt: pick(lang, a.prompt),
      provider: a.provider,
      model: a.model,
      effort: a.effort,
      edits: a.edits,
      run_in: a.run_in ?? "headless",
      max_parallel: a.max_parallel ?? 1,
      model_ladder: a.model_ladder ?? [],
      advisor: a.advisor ?? false,
    } satisfies AgentTemplateBody,
    based_on: "",
    version: BUILTIN_VERSION,
    sort_order: index,
    created_at: "",
    updated_at: "",
  }));
  const teams: LibraryItem[] = TEAMS.map((t, index) => ({
    id: `builtin:${t.key}`,
    kind: "team",
    name: pick(lang, t.name),
    description: pick(lang, t.description),
    icon: "users",
    color: "indigo",
    tags: [],
    body: {
      v: 1,
      lead_slot: t.lead_slot,
      policy: t.policy,
      slots: t.slots.map((s) => ({ ...s, name: pick(lang, s.name), role: pick(lang, s.role) })),
    } satisfies TeamTemplateBody,
    based_on: "",
    version: BUILTIN_VERSION,
    sort_order: 100 + index,
    created_at: "",
    updated_at: "",
  }));
  return [...agents, ...teams];
}

export function isBuiltin(id: string): boolean {
  return id.startsWith("builtin:");
}

/** The fields of a draft a template sets — what a sync compares. */
export const SYNCED_FIELDS = ["role", "prompt", "provider", "model", "effort", "edits", "run_in", "max_parallel", "model_ladder", "icon", "color"] as const;
export type SyncedField = (typeof SYNCED_FIELDS)[number];

/** A new agent draft from a template. The name is the template's, numbered if it is taken. */
export function draftFromTemplate(template: LibraryItem, workspaceId: string, takenNames: string[]): AgentDraft {
  const body = template.body as AgentTemplateBody;
  let name = template.name;
  for (let n = 2; takenNames.some((taken) => taken.toLowerCase() === name.toLowerCase()); n++) name = `${template.name} ${n}`;
  return {
    id: null,
    workspace_id: workspaceId,
    name,
    role: body.role,
    provider: body.provider,
    model: body.model,
    prompt: body.prompt,
    enabled: true,
    account_id: null,
    effort: body.effort,
    icon: template.icon,
    color: template.color,
    edits: body.edits,
    repos: [],
    run_in: body.run_in,
    max_parallel: body.max_parallel,
    model_ladder: body.model_ladder,
    template_id: template.id,
    template_version: template.version,
    overrides: [],
    perms: [],
  };
}

export interface SyncChange {
  field: SyncedField;
  from: unknown;
  to: unknown;
  /** The user edited this field on the agent; a sync leaves it unless they tick it. */
  overridden: boolean;
}

/** What syncing an agent with its template would change. */
export function templateSyncPlan(agent: AgentDraft, template: LibraryItem): SyncChange[] {
  const body = template.body as AgentTemplateBody;
  const target: Record<SyncedField, unknown> = {
    role: body.role,
    prompt: body.prompt,
    provider: body.provider,
    model: body.model,
    effort: body.effort,
    edits: body.edits,
    run_in: body.run_in,
    max_parallel: body.max_parallel,
    model_ladder: body.model_ladder,
    icon: template.icon,
    color: template.color,
  };
  const out: SyncChange[] = [];
  for (const field of SYNCED_FIELDS) {
    const from = agent[field];
    const to = target[field];
    if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ field, from, to, overridden: agent.overrides.includes(field) });
  }
  return out;
}
