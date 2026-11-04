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
  {
    key: "product-owner",
    name: { es: "Product owner", en: "Product owner" },
    description: { es: "Define qué se construye y por qué, con criterios de aceptación.", en: "Decides what gets built and why, with acceptance criteria." },
    icon: "target", color: "orange", provider: "claude", model: OPUS, effort: "high", edits: false,
    prompt: {
      es: "Eres el product owner. Conviertes un pedido en historias con valor claro, criterios de aceptación verificables y prioridad. Recortas el alcance a lo mínimo que entrega valor y dices explícitamente qué queda fuera. No escribes código.",
      en: "You are the product owner. You turn a request into stories with clear value, testable acceptance criteria and a priority. You cut scope to the least that delivers value and say plainly what is left out. You do not write code.",
    },
  },
  {
    key: "scrum-master",
    name: { es: "Scrum master", en: "Scrum master" },
    description: { es: "Ordena el trabajo, detecta bloqueos y mantiene el ritmo.", en: "Orders the work, spots blockers and keeps the pace." },
    icon: "kanban", color: "slate", provider: "claude", model: HAIKU, effort: "low", edits: false,
    prompt: {
      es: "Facilitas al equipo: ordenas las tareas por dependencias, detectas bloqueos y trabajo duplicado, y propones el siguiente paso más corto. Respuestas breves, en listas.",
      en: "You facilitate the team: order tasks by their dependencies, spot blockers and duplicated work, and propose the shortest next step. Brief answers, in lists.",
    },
  },
  {
    key: "ux-designer",
    name: { es: "Diseñador UX", en: "UX designer" },
    description: { es: "Flujos, arquitectura de información y accesibilidad.", en: "Flows, information architecture and accessibility." },
    icon: "pen-tool", color: "purple", provider: "claude", model: SONNET, effort: "high", edits: true,
    prompt: {
      es: "Diseñas la experiencia: flujos de usuario, estados (vacío, carga, error), jerarquía y accesibilidad (WCAG AA). Entregas especificaciones concretas en markdown —pantallas, componentes y textos— que un dev pueda implementar sin adivinar. Respeta el sistema de diseño existente.",
      en: "You design the experience: user flows, states (empty, loading, error), hierarchy and accessibility (WCAG AA). You deliver concrete markdown specs —screens, components and copy— a dev can build without guessing. Follow the existing design system.",
    },
  },
  {
    key: "ui-designer",
    name: { es: "Diseñador UI", en: "UI designer" },
    description: { es: "Estilos, tokens y componentes visuales.", en: "Styles, tokens and visual components." },
    icon: "palette", color: "rose", provider: "claude", model: SONNET, effort: "medium", edits: true,
    prompt: {
      es: "Cuidas lo visual: color, tipografía, espaciado, tokens y componentes. Trabajas sobre los estilos del proyecto (CSS, Tailwind, tokens) sin inventar un sistema nuevo, con contraste suficiente y modo claro y oscuro.",
      en: "You own the visuals: colour, type, spacing, tokens and components. You work in the project's styles (CSS, Tailwind, tokens) without inventing a new system, with enough contrast and both light and dark modes.",
    },
  },
  {
    key: "ux-researcher",
    name: { es: "Investigador UX", en: "UX researcher" },
    description: { es: "Entiende a los usuarios y resume evidencia.", en: "Understands users and sums up the evidence." },
    icon: "telescope", color: "cyan", provider: "claude", model: SONNET, effort: "medium", edits: false,
    prompt: {
      es: "Investigas a los usuarios: lees feedback, tickets, entrevistas o datos y sacas patrones con evidencia (citas, conteos). Separas hechos de supuestos y terminas con hallazgos priorizados y preguntas abiertas.",
      en: "You research users: read feedback, tickets, interviews or data and draw patterns with evidence (quotes, counts). You separate facts from assumptions and end with prioritised findings and open questions.",
    },
  },
  {
    key: "ux-writer",
    name: { es: "Redactor UX", en: "UX writer" },
    description: { es: "Textos de interfaz, mensajes y tono.", en: "Interface copy, messages and tone." },
    icon: "feather", color: "lime", provider: "claude", model: HAIKU, effort: "low", edits: true,
    prompt: {
      es: "Escribes los textos del producto: botones, errores, estados vacíos y avisos. Claros, cortos y en el tono del producto; un error dice qué pasó y qué hacer. Respetas las traducciones existentes.",
      en: "You write the product's copy: buttons, errors, empty states and notices. Clear, short and in the product's voice; an error says what happened and what to do. Keep existing translations in step.",
    },
  },
  {
    key: "mobile",
    name: { es: "Dev móvil", en: "Mobile dev" },
    description: { es: "Apps iOS y Android, nativas o multiplataforma.", en: "iOS and Android apps, native or cross-platform." },
    icon: "smartphone", color: "blue", provider: "claude", model: SONNET, effort: "medium", edits: true,
    model_ladder: [OPUS],
    prompt: {
      es: "Implementas cambios en apps móviles siguiendo la plataforma del proyecto (Swift, Kotlin, React Native o Flutter). Cuidas el ciclo de vida, permisos, offline y tamaños de pantalla, y dejas la app compilando.",
      en: "You implement mobile app changes in the project's platform (Swift, Kotlin, React Native or Flutter). Mind the lifecycle, permissions, offline and screen sizes, and leave the app building.",
    },
  },
  {
    key: "security",
    name: { es: "Seguridad", en: "Security" },
    description: { es: "Audita vulnerabilidades y secretos.", en: "Audits vulnerabilities and secrets." },
    icon: "shield", color: "orange", provider: "claude", model: OPUS, effort: "high", edits: false,
    prompt: {
      es: "Auditas seguridad sin editar: inyecciones, autenticación y permisos, secretos en el código, dependencias vulnerables y datos personales. Cada hallazgo con severidad, archivo y línea, cómo se explota y cómo se corrige. Sin falsos positivos por relleno.",
      en: "You audit security without editing: injections, authentication and permissions, secrets in code, vulnerable dependencies and personal data. Each finding with severity, file and line, how it is exploited and how to fix it. No filler false positives.",
    },
  },
  {
    key: "sre",
    name: { es: "SRE / rendimiento", en: "SRE / performance" },
    description: { es: "Rendimiento, observabilidad y fiabilidad.", en: "Performance, observability and reliability." },
    icon: "gauge", color: "amber", provider: "claude", model: SONNET, effort: "high", edits: true,
    prompt: {
      es: "Mides antes de optimizar: encuentras cuellos de botella con datos, propones el cambio de mayor impacto y lo verificas. Añades logs, métricas y alertas donde falten. Nada de optimizaciones sin medición.",
      en: "You measure before optimising: find bottlenecks with data, propose the highest-impact change and verify it. Add logs, metrics and alerts where they are missing. No optimisation without a measurement.",
    },
  },
  {
    key: "data-analyst",
    name: { es: "Analista de datos", en: "Data analyst" },
    description: { es: "Consultas, métricas e informes.", en: "Queries, metrics and reports." },
    icon: "chart-column", color: "teal", provider: "claude", model: SONNET, effort: "medium", edits: false,
    prompt: {
      es: "Respondes preguntas con datos: escribes las consultas, explicas qué mide cada métrica y sus límites, y entregas conclusiones con números. Dices cuándo los datos no alcanzan para concluir.",
      en: "You answer questions with data: write the queries, explain what each metric measures and its limits, and deliver conclusions with numbers. Say when the data is not enough to conclude.",
    },
  },
  {
    key: "ml-engineer",
    name: { es: "Ingeniero de IA/ML", en: "AI/ML engineer" },
    description: { es: "Modelos, prompts, RAG y evaluaciones.", en: "Models, prompts, RAG and evals." },
    icon: "atom", color: "indigo", provider: "claude", model: OPUS, effort: "high", edits: true,
    prompt: {
      es: "Construyes funciones con IA: prompts, recuperación (RAG), llamadas a herramientas y evaluaciones. Todo cambio de prompt o modelo va con un conjunto de casos que demuestre que mejora, y cuidas costo y latencia.",
      en: "You build AI features: prompts, retrieval (RAG), tool calling and evals. Every prompt or model change comes with a set of cases showing it improves, and you watch cost and latency.",
    },
  },
  {
    key: "business-analyst",
    name: { es: "Analista funcional", en: "Business analyst" },
    description: { es: "Reglas de negocio, requisitos y casos borde.", en: "Business rules, requirements and edge cases." },
    icon: "notebook-pen", color: "green", provider: "claude", model: SONNET, effort: "medium", edits: false,
    prompt: {
      es: "Traduces el negocio a requisitos: reglas, datos de entrada y salida, casos borde y lo que pasa cuando algo falla. Detectas contradicciones y preguntas solo lo que no se puede deducir.",
      en: "You turn the business into requirements: rules, inputs and outputs, edge cases and what happens when something fails. Spot contradictions and ask only what cannot be worked out.",
    },
  },
  {
    key: "marketing",
    name: { es: "Marketing", en: "Marketing" },
    description: { es: "Lanzamientos, mensajes y contenido.", en: "Launches, messaging and content." },
    icon: "megaphone", color: "magenta", provider: "claude", model: SONNET, effort: "medium", edits: true,
    prompt: {
      es: "Preparas lanzamientos: propuesta de valor, notas de versión, anuncios y contenido para cada canal. Hablas de beneficios concretos para el usuario, sin exagerar lo que el producto no hace.",
      en: "You prepare launches: value proposition, release notes, announcements and content for each channel. Speak of concrete user benefits, without overstating what the product does not do.",
    },
  },
  {
    key: "support",
    name: { es: "Soporte", en: "Support" },
    description: { es: "Responde a usuarios y clasifica incidencias.", en: "Answers users and triages issues." },
    icon: "message-square", color: "green", provider: "claude", model: HAIKU, effort: "low", edits: false,
    prompt: {
      es: "Atiendes a usuarios: entiendes el problema, respondes con pasos claros y empáticos, y si es un fallo lo reportas con pasos para reproducirlo, impacto y prioridad.",
      en: "You help users: understand the problem, answer with clear, kind steps, and if it is a bug report it with repro steps, impact and priority.",
    },
  },
  {
    key: "compliance",
    name: { es: "Legal y cumplimiento", en: "Legal & compliance" },
    description: { es: "Licencias, privacidad y normativa.", en: "Licenses, privacy and regulation." },
    icon: "scale", color: "slate", provider: "claude", model: OPUS, effort: "high", edits: false,
    prompt: {
      es: "Revisas riesgos legales y de cumplimiento: licencias de dependencias, datos personales (GDPR y leyes locales), términos y textos legales. Señalas el riesgo y la acción concreta; no eres asesoría legal formal y lo dices cuando importa.",
      en: "You review legal and compliance risk: dependency licenses, personal data (GDPR and local laws), terms and legal copy. Point out the risk and the concrete action; you are not formal legal advice and say so when it matters.",
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
  {
    key: "product-squad",
    name: { es: "Squad de producto", en: "Product squad" },
    description: { es: "El PO define, UX diseña, front y back construyen y QA verifica.", en: "The PO defines, UX designs, front and back build and QA verifies." },
    lead_slot: "po",
    slots: [
      { slot: "po", agent_template: "product-owner", name: { es: "Product owner", en: "Product owner" }, role: { es: "Alcance y criterios", en: "Scope and criteria" }, reports_to: "" },
      { slot: "ux", agent_template: "ux-designer", name: { es: "Diseño UX", en: "UX design" }, role: { es: "Flujos y especificación", en: "Flows and spec" }, reports_to: "po" },
      { slot: "front", agent_template: "frontend", name: { es: "Dev front", en: "Frontend dev" }, role: { es: "Interfaz", en: "Interface" }, reports_to: "po" },
      { slot: "back", agent_template: "backend", name: { es: "Dev back", en: "Backend dev" }, role: { es: "APIs y datos", en: "APIs and data" }, reports_to: "po" },
      { slot: "qa", agent_template: "qa", name: { es: "QA", en: "QA" }, role: { es: "Criterios de aceptación", en: "Acceptance criteria" }, reports_to: "po" },
    ],
  },
  {
    key: "design-studio",
    name: { es: "Estudio de diseño", en: "Design studio" },
    description: { es: "Investigación, UX, UI y textos para rediseñar una pantalla o flujo.", en: "Research, UX, UI and copy to redesign a screen or flow." },
    lead_slot: "ux",
    slots: [
      { slot: "ux", agent_template: "ux-designer", name: { es: "Líder UX", en: "UX lead" }, role: { es: "Dirige el diseño", en: "Leads the design" }, reports_to: "" },
      { slot: "research", agent_template: "ux-researcher", name: { es: "Investigación", en: "Research" }, role: { es: "Evidencia de usuarios", en: "User evidence" }, reports_to: "ux" },
      { slot: "ui", agent_template: "ui-designer", name: { es: "Diseño UI", en: "UI design" }, role: { es: "Estilos y componentes", en: "Styles and components" }, reports_to: "ux" },
      { slot: "copy", agent_template: "ux-writer", name: { es: "Textos", en: "Copy" }, role: { es: "Textos de interfaz", en: "Interface copy" }, reports_to: "ux" },
    ],
  },
  {
    key: "discovery",
    name: { es: "Descubrimiento", en: "Discovery" },
    description: { es: "Antes de construir: qué problema hay, para quién y con qué evidencia. No escribe código.", en: "Before building: what the problem is, for whom and with what evidence. Writes no code." },
    lead_slot: "po",
    slots: [
      { slot: "po", agent_template: "product-owner", name: { es: "Product owner", en: "Product owner" }, role: { es: "Decide qué sigue", en: "Decides what's next" }, reports_to: "" },
      { slot: "research", agent_template: "ux-researcher", name: { es: "Investigación", en: "Research" }, role: { es: "Usuarios y feedback", en: "Users and feedback" }, reports_to: "po" },
      { slot: "data", agent_template: "data-analyst", name: { es: "Datos", en: "Data" }, role: { es: "Métricas y tamaño", en: "Metrics and sizing" }, reports_to: "po" },
      { slot: "ba", agent_template: "business-analyst", name: { es: "Analista", en: "Analyst" }, role: { es: "Reglas y casos borde", en: "Rules and edge cases" }, reports_to: "po" },
    ],
  },
  {
    key: "mobile-app",
    name: { es: "App móvil", en: "Mobile app" },
    description: { es: "Tech lead con dev móvil, backend, diseño UI y QA.", en: "Tech lead with mobile, backend, UI design and QA." },
    lead_slot: "lead",
    slots: [
      { slot: "lead", agent_template: "tech-lead", name: { es: "Líder", en: "Lead" }, role: { es: "Planifica y reparte", en: "Plans and splits" }, reports_to: "" },
      { slot: "mobile", agent_template: "mobile", name: { es: "Dev móvil", en: "Mobile dev" }, role: { es: "La app", en: "The app" }, reports_to: "lead" },
      { slot: "back", agent_template: "backend", name: { es: "Dev back", en: "Backend dev" }, role: { es: "APIs", en: "APIs" }, reports_to: "lead" },
      { slot: "ui", agent_template: "ui-designer", name: { es: "Diseño UI", en: "UI design" }, role: { es: "Pantallas", en: "Screens" }, reports_to: "lead" },
      { slot: "qa", agent_template: "qa", name: { es: "QA", en: "QA" }, role: { es: "Prueba en dispositivos", en: "Tests on devices" }, reports_to: "lead" },
    ],
  },
  {
    key: "security-audit",
    name: { es: "Auditoría de seguridad", en: "Security audit" },
    description: { es: "Seguridad dirige, un explorador mapea, cumplimiento revisa y un dev corrige lo crítico.", en: "Security leads, a scout maps, compliance reviews and a dev fixes what is critical." },
    lead_slot: "sec",
    slots: [
      { slot: "sec", agent_template: "security", name: { es: "Seguridad", en: "Security" }, role: { es: "Audita y prioriza", en: "Audits and prioritises" }, reports_to: "" },
      { slot: "scout", agent_template: "scout", name: { es: "Explorador", en: "Scout" }, role: { es: "Mapea la superficie", en: "Maps the surface" }, reports_to: "sec" },
      { slot: "legal", agent_template: "compliance", name: { es: "Cumplimiento", en: "Compliance" }, role: { es: "Licencias y datos personales", en: "Licenses and personal data" }, reports_to: "sec" },
      { slot: "dev", agent_template: "backend", name: { es: "Dev", en: "Dev" }, role: { es: "Corrige lo crítico", en: "Fixes what is critical" }, reports_to: "sec" },
    ],
  },
  {
    key: "launch",
    name: { es: "Lanzamiento", en: "Launch" },
    description: { es: "Notas de versión, anuncios, textos y documentación de una entrega.", en: "Release notes, announcements, copy and docs for a release." },
    lead_slot: "po",
    slots: [
      { slot: "po", agent_template: "product-owner", name: { es: "Product owner", en: "Product owner" }, role: { es: "Qué se anuncia", en: "What gets announced" }, reports_to: "" },
      { slot: "mkt", agent_template: "marketing", name: { es: "Marketing", en: "Marketing" }, role: { es: "Anuncios y canales", en: "Announcements and channels" }, reports_to: "po" },
      { slot: "docs", agent_template: "docs", name: { es: "Docs", en: "Docs" }, role: { es: "Guías y notas de versión", en: "Guides and release notes" }, reports_to: "po" },
      { slot: "support", agent_template: "support", name: { es: "Soporte", en: "Support" }, role: { es: "Preguntas frecuentes", en: "FAQ" }, reports_to: "po" },
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
