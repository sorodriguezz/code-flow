import { translations, type TranslationKey } from "../i18n/translations";
import { APPS, appKey } from "../railApps";
import { SETTINGS_SECTIONS } from "../settingsCatalog";
import { SHORTCUT_COMMANDS } from "../shortcuts";

/**
 * What people *say* for the values of the catalogue's enums — «abre flujos», "open the db" — so the
 * backend's model-free router can run a simple order with no model at all (`CodiActionSpec.vocabulary`).
 *
 * Each value gets the name the UI shows it under, in each language whose dictionary is loaded (read
 * from the i18n files at registration, so a renamed app is said by its new name), plus the variants a
 * person reaches for instead: the singular, the jargon («bd», "db"), the tool it replaces ("postman").
 * All lowercase and without accents, which is how the router compares.
 *
 * Spanish is only in memory when the app speaks it (`translations.ts` loads it on demand), so in an
 * English session the Spanish side is the hand-written variants alone — which is why every one of
 * them starts with the UI's own Spanish word. The bus registers again when the language changes, and
 * the newly loaded labels arrive then.
 */

export type Spoken = { es: string[]; en: string[] };
export type Vocabulary = Record<string, Spoken>;

/** A phrase as the router compares it: lowercase, no accents, no punctuation, single spaces. */
export function spoken(text: string, language: "es" | "en"): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, language === "es" ? " y " : " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

/** The names of one value: the UI's labels for `keys` in each loaded language, then `extra`. */
export function namesFor(keys: TranslationKey | TranslationKey[] | null, extra: Partial<Spoken> = {}): Spoken {
  const list = keys === null ? [] : Array.isArray(keys) ? keys : [keys];
  const label = (language: "es" | "en", key: TranslationKey) => {
    const text = translations[language][key];
    return text ? spoken(text, language) : "";
  };
  return {
    es: unique([...list.map((key) => label("es", key)), ...(extra.es ?? []).map((t) => spoken(t, "es"))]),
    en: unique([...list.map((key) => label("en", key)), ...(extra.en ?? []).map((t) => spoken(t, "en"))]),
  };
}

/** The rail apps, by key. */
const APP_EXTRA: Record<string, Partial<Spoken>> = {
  "api:requests": {
    es: ["cliente api", "api", "cliente http", "peticiones", "requests", "postman", "insomnia"],
    en: ["api client", "api", "http client", "requests", "postman", "insomnia"],
  },
  "api:database": {
    es: ["bases de datos", "base de datos", "bd", "bbdd", "datos", "sql", "consola sql", "datagrip"],
    en: ["databases", "database", "db", "sql", "sql console", "datagrip"],
  },
  agents: { es: ["agentes", "agente", "consola de agentes", "tareas de agentes"], en: ["agents", "agent", "agent console"] },
  stories: {
    es: ["especificacion", "especificaciones", "specs", "historias", "historias de usuario", "requisitos"],
    en: ["specs", "specifications", "stories", "user stories", "requirements"],
  },
  remote: { es: ["remoto", "ssh", "servidores", "hosts", "maquinas"], en: ["remote", "ssh", "servers", "hosts", "machines"] },
  notes: { es: ["notas", "nota", "apuntes", "cuaderno"], en: ["notes", "note", "notebook"] },
  diagrams: { es: ["diagramas", "diagrama", "dibujos", "pizarra"], en: ["diagrams", "diagram", "drawings", "whiteboard"] },
  vault: {
    es: ["llavero", "contrasenas", "claves", "boveda", "gestor de contrasenas"],
    en: ["keyring", "vault", "passwords", "password manager"],
  },
  chat: { es: ["chat", "conversaciones", "chat general"], en: ["chat", "conversations"] },
  flows: {
    es: ["flujos", "flujo", "automatizaciones", "automatizacion", "workflows", "n8n"],
    en: ["flows", "flow", "automations", "automation", "workflows", "n8n"],
  },
  architecture: { es: ["arquitectura", "arquitecturas", "diseno del sistema"], en: ["architecture", "architectures", "system design"] },
};

export function appVocabulary(): Vocabulary {
  return Object.fromEntries(APPS.map((app) => [appKey(app), namesFor(app.labelKey, APP_EXTRA[appKey(app)])]));
}

/** The repository's tabs. */
const VIEW_NAMES: Record<string, [TranslationKey, Partial<Spoken>]> = {
  graph: ["tabbar.graph", { es: ["grafo", "historial", "commits", "grafico", "log"], en: ["graph", "history", "commits", "log"] }],
  changes: ["tabbar.changes", { es: ["cambios", "cambios pendientes", "staging", "preparar"], en: ["changes", "working changes", "staging"] }],
  editor: ["tabbar.editor", { es: ["editor", "codigo", "archivos"], en: ["editor", "code", "files"] }],
  pipelines: ["tabbar.pipelines", { es: ["pipelines", "ci", "integracion continua", "builds"], en: ["pipelines", "ci", "builds"] }],
  reviewer: ["tabbar.reviewer", { es: ["revisor", "sonar", "sonarqube", "calidad", "quality gate"], en: ["reviewer", "sonar", "sonarqube", "quality", "quality gate"] }],
  codemap: ["tabbar.codemap", { es: ["mapa", "mapa del repo", "mapa de codigo"], en: ["map", "code map", "repo map"] }],
};

export function viewVocabulary(views: readonly string[]): Vocabulary {
  return Object.fromEntries(
    views.filter((view) => VIEW_NAMES[view]).map((view) => [view, namesFor(VIEW_NAMES[view][0], VIEW_NAMES[view][1])]),
  );
}

/** Settings' sections. */
const SECTION_EXTRA: Record<string, Partial<Spoken>> = {
  general: { es: ["general", "idioma", "actualizaciones"], en: ["general", "language", "updates"] },
  appearance: { es: ["apariencia", "tema", "temas", "colores", "aspecto"], en: ["appearance", "theme", "themes", "colors", "look"] },
  keybindings: { es: ["atajos", "atajos de teclado", "teclas", "combinaciones"], en: ["shortcuts", "keyboard shortcuts", "keybindings", "keys"] },
  notifications: { es: ["notificaciones", "avisos"], en: ["notifications", "alerts"] },
  voice: { es: ["voz", "voz y sonido", "sonido", "microfono", "dictado", "codi"], en: ["voice", "voice and sound", "sound", "microphone", "dictation", "codi"] },
  backup: { es: ["respaldo", "respaldos", "copia de seguridad", "backup"], en: ["backup", "backups"] },
  projects: { es: ["workspaces", "proyectos", "workspaces y proyectos"], en: ["workspaces", "projects"] },
  editor: { es: ["editor", "editor de codigo"], en: ["editor", "code editor"] },
  terminal: { es: ["terminal", "consola", "shell"], en: ["terminal", "console", "shell"] },
  git: { es: ["git", "comportamiento git"], en: ["git", "git behavior"] },
  azure: { es: ["integraciones", "cuentas", "github", "azure", "gitlab", "bitbucket", "jira"], en: ["integrations", "accounts", "github", "azure", "gitlab", "bitbucket", "jira"] },
  claude: { es: ["ia", "motores de ia", "modelos", "inteligencia artificial", "claude"], en: ["ai", "ai engines", "models", "claude"] },
  tasks: { es: ["tareas", "prompts", "tareas y prompts"], en: ["tasks", "prompts", "tasks and prompts"] },
  review: { es: ["revision", "revision de pr", "revision de prs", "pull requests"], en: ["review", "pr review", "pull requests"] },
  tools: { es: ["herramientas", "herramientas de ia", "skills", "mcp"], en: ["tools", "ai tools", "skills", "mcp"] },
  api: { es: ["cliente api", "ajustes del cliente api", "api", "proxy", "certificados"], en: ["api client", "api client settings", "api", "proxy", "certificates"] },
  databases: { es: ["bases de datos", "drivers", "controladores"], en: ["databases", "drivers"] },
  vault: { es: ["llavero", "contrasenas"], en: ["keyring", "vault", "passwords"] },
  reviewer: { es: ["revisor", "sonarqube", "sonar"], en: ["reviewer", "sonarqube", "sonar"] },
  remote: { es: ["control remoto", "movil", "telefono", "celular"], en: ["remote control", "mobile", "phone"] },
};

export function sectionVocabulary(): Vocabulary {
  return Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.id, namesFor(section.labelKey, SECTION_EXTRA[section.id])]));
}

/** Settings' panes. A pane id is shared by several sections ("general"), so its names are all of theirs. */
export function tabVocabulary(): Vocabulary {
  const keys = new Map<string, TranslationKey[]>();
  for (const section of SETTINGS_SECTIONS) {
    for (const tab of section.tabs ?? []) keys.set(tab.id, [...(keys.get(tab.id) ?? []), tab.labelKey]);
  }
  return Object.fromEntries([...keys].map(([id, labels]) => [id, namesFor(labels)]));
}

/** The dock's panels. */
const DOCK_NAMES: Record<string, [TranslationKey, Partial<Spoken>]> = {
  terminal: ["tabbar.terminal", { es: ["terminal", "terminales", "consola", "shell"], en: ["terminal", "terminals", "console", "shell"] }],
  containers: ["containers.title", { es: ["contenedores", "docker", "kubernetes"], en: ["containers", "docker", "kubernetes"] }],
  services: ["services.title", { es: ["servicios", "procesos"], en: ["services", "processes"] }],
};

export function dockVocabulary(views: readonly string[]): Vocabulary {
  return Object.fromEntries(views.map((view) => [view, namesFor(DOCK_NAMES[view][0], DOCK_NAMES[view][1])]));
}

/** The registry's commands by their own labels, for `shortcut.run`. */
export function shortcutVocabulary(ids: readonly string[]): Vocabulary {
  const wanted = new Set(ids);
  return Object.fromEntries(SHORTCUT_COMMANDS.filter((c) => wanted.has(c.id)).map((c) => [c.id, namesFor(c.labelKey)]));
}

/** A closed set with no UI label of its own — panel states, scopes — spelled out by hand. */
export function literal(values: Record<string, Partial<Spoken>>): Vocabulary {
  return Object.fromEntries(Object.entries(values).map(([value, extra]) => [value, namesFor(null, extra)]));
}
