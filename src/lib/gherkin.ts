import type { TranslationKey } from "./i18n/translations";
import type { StoryBatch, StoryDraft } from "../types/domain";

/**
 * Gherkin, INVEST and Cucumber, applied to the stories this app writes.
 *
 * Three jobs, deliberately in one file because they are the same knowledge seen from three sides:
 *
 * - **Parsing** a criterion into steps ({@link parseScenario}). Every rule below and the exporter
 *   read the same parse, so "what counts as a `Cuando`" is decided once.
 * - **Linting** a story ({@link lintStory}) — the deterministic half of quality. No model involved:
 *   two `Cuando` in one scenario is a fact about the text, and a fact does not need an AI call, a
 *   network round trip, or a provider that happens to be configured.
 * - **Exporting** the set as a `.feature` file ({@link toFeatureFile}) that Cucumber runs as-is.
 *   That file is the point of the whole exercise: it is what turns "criterios de aceptación" from
 *   something QA reads into something QA executes against the code.
 *
 * Dependency-free on purpose (types only): `storiesStore` imports *this*, never the other way
 * around.
 */

// ---------- parsing ----------

/** What a step does, once `Y`/`Pero` have been resolved to what they continue. */
export type StepKind = "given" | "when" | "then";

export interface GherkinStep {
  /** The keyword as written — kept so a message can quote the user's own word. */
  keyword: string;
  /** `Y`/`Pero` inherit the kind of the step above; the first step has no one to inherit from. */
  kind: StepKind | null;
  /** True for `Y` / `Pero` / `And` / `But`. */
  continuation: boolean;
  text: string;
}

export interface ExamplesTable {
  headers: string[];
  rows: string[][];
}

export interface ParsedScenario {
  /** `""` when the criterion never declared one. */
  title: string;
  /** True for `Esquema del escenario:` / `Scenario Outline:`. */
  outline: boolean;
  /** `@etiquetas` written above the scenario line. */
  tags: string[];
  steps: GherkinStep[];
  examples: ExamplesTable | null;
  /** Lines that matched nothing — prose where a step was expected. */
  stray: string[];
}

/** Both languages at once: a team that writes `Given/When/Then` is writing Gherkin too, and the
 * linter has no business calling that a syntax error. */
const STEP_KEYWORDS: { word: string; kind: StepKind | null; continuation: boolean }[] = [
  { word: "dado", kind: "given", continuation: false },
  { word: "dada", kind: "given", continuation: false },
  { word: "dados", kind: "given", continuation: false },
  { word: "dadas", kind: "given", continuation: false },
  { word: "given", kind: "given", continuation: false },
  { word: "cuando", kind: "when", continuation: false },
  { word: "when", kind: "when", continuation: false },
  { word: "entonces", kind: "then", continuation: false },
  { word: "then", kind: "then", continuation: false },
  { word: "y", kind: null, continuation: true },
  { word: "and", kind: null, continuation: true },
  { word: "pero", kind: null, continuation: true },
  { word: "but", kind: null, continuation: true },
];

const SCENARIO_PREFIXES = [
  "esquema del escenario:",
  "scenario outline:",
  "scenario template:",
  "escenario:",
  "scenario:",
  "ejemplo:",
  "example:",
];

const OUTLINE_PREFIXES = ["esquema del escenario:", "scenario outline:", "scenario template:"];

const EXAMPLES_PREFIXES = ["ejemplos:", "examples:", "escenarios:"];

/** `| a | b |` → `["a", "b"]`. A ragged row keeps its own cell count so the linter can report it. */
function tableCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined);
  return inner.split("|").map((cell) => cell.trim());
}

/**
 * Reads one acceptance criterion as a scenario.
 *
 * Forgiving by design: this runs on text a person is still typing, so anything unrecognised becomes
 * a `stray` line for the linter to complain about rather than an exception that blanks the card.
 */
export function parseScenario(text: string): ParsedScenario {
  const scenario: ParsedScenario = {
    title: "",
    outline: false,
    tags: [],
    steps: [],
    examples: null,
    stray: [],
  };

  let inExamples = false;
  let lastKind: StepKind | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("@")) {
      scenario.tags.push(...line.split(/\s+/).filter((tag) => tag.startsWith("@")));
      continue;
    }

    const lower = line.toLowerCase();

    const scenarioPrefix = SCENARIO_PREFIXES.find((prefix) => lower.startsWith(prefix));
    if (scenarioPrefix) {
      scenario.title = line.slice(scenarioPrefix.length).trim();
      scenario.outline = OUTLINE_PREFIXES.includes(scenarioPrefix);
      inExamples = false;
      continue;
    }

    if (EXAMPLES_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      inExamples = true;
      scenario.examples = { headers: [], rows: [] };
      continue;
    }

    if (line.startsWith("|")) {
      // A table outside an `Ejemplos:` block is a data table on the step above — legitimate
      // Gherkin, and not this parser's business.
      if (!inExamples || !scenario.examples) continue;
      const cells = tableCells(line);
      if (scenario.examples.headers.length === 0) scenario.examples.headers = cells;
      else scenario.examples.rows.push(cells);
      continue;
    }

    // The first word decides. `Dado que el cliente…` is the keyword `Dado` and the rest is text.
    const [first = "", ...rest] = line.split(/\s+/);
    const keyword = STEP_KEYWORDS.find((k) => k.word === first.toLowerCase());
    if (!keyword) {
      scenario.stray.push(line);
      continue;
    }
    inExamples = false;
    const kind = keyword.continuation ? lastKind : keyword.kind;
    if (!keyword.continuation) lastKind = keyword.kind;
    scenario.steps.push({
      keyword: first,
      kind,
      continuation: keyword.continuation,
      text: rest.join(" "),
    });
  }

  return scenario;
}

/** `<importe>` placeholders used anywhere in a scenario's steps. */
function placeholdersIn(scenario: ParsedScenario): string[] {
  const found = new Set<string>();
  for (const step of scenario.steps) {
    for (const match of step.text.matchAll(/<([^<>]+)>/g)) found.add(match[1].trim());
  }
  return [...found];
}

// ---------- the criteria as they are stored ----------

/**
 * The acceptance criteria as the row stores them: a JSON array, so a criterion can hold its own
 * line breaks (Gherkin does), which a delimiter-joined string could not survive.
 */
export function parseCriteria(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

// ---------- linting ----------

export type QualitySeverity = "error" | "warn" | "info";

/** Which discipline the issue comes from — the six INVEST letters, plus Gherkin syntax and the
 * plain shape of the work item. Shown as-is on the card: naming the letter is what turns a warning
 * into something a team can argue about in a refinement session. */
export type QualityDimension =
  | "independent"
  | "negotiable"
  | "valuable"
  | "estimable"
  | "small"
  | "testable"
  | "gherkin"
  | "format";

export interface QualityIssue {
  severity: QualitySeverity;
  dimension: QualityDimension;
  messageKey: TranslationKey;
  params?: Record<string, string | number>;
  /** 0-based index of the criterion this is about; `undefined` means the story as a whole. */
  criterion?: number;
}

export interface StoryQuality {
  issues: QualityIssue[];
  /** 0-100. Not a grade to chase — a way to sort a backlog by what needs a second pass. */
  score: number;
  level: "ok" | "warn" | "error";
}

/** "Como <rol>, quiero <capacidad>, para <beneficio>" and its English twin, with the three parts
 * captured so the role and the benefit can be judged separately. */
const NARRATIVE_ES = /^como\s+(.+?),\s*(?:quiero|necesito)\s+(.+?),\s*(?:para|a fin de)\s+(.+)$/i;
const NARRATIVE_EN = /^as\s+(?:an?\s+)?(.+?),?\s*i\s+(?:want|need)\s+(?:to\s+)?(.+?),?\s*so\s+that\s+(.+)$/i;

/** A role so generic it names nobody. Fine when the product really has one kind of user, worth a
 * nudge when it doesn't — hence `info`, never `warn`. */
const GENERIC_ROLES = ["usuario", "usuaria", "user", "cliente final", "persona"];

/** A "benefit" that only restates the mechanism. The value of a story is never that a system
 * stored something. */
const HOLLOW_BENEFIT = /\b(el sistema|la aplicación|la app|la base de datos|the system|the database)\b/i;

/** Words that mean the story has stopped describing the problem and started dictating the
 * solution — the INVEST "negotiable" failure, and the one that quietly turns refinement into
 * design review. */
const IMPLEMENTATION_WORDS =
  /\b(endpoint|api rest|microservicio|microservice|tabla\s+\w+|base de datos|stored procedure|redis|kafka|jwt|componente react|react|sql|select\s+\*|schema|migración de la tabla)\b/i;

/** A step that has stopped describing behaviour and started driving a screen. These are the
 * criteria that break on the first redesign while the behaviour they meant is still correct. */
const UI_COUPLED =
  /\b(hace? clic|haz clic|click|clicar|pulsa|presiona|el botón|the button|selector|css|xpath|la pantalla de|el modal|el popup|placeholder|https?:\/\/)/i;

/** How a criterion announces that it is about the unhappy path. Deliberately broad: the rule it
 * feeds only ever *asks* whether the story covers failure, and a false positive there is silence,
 * which is the safe direction. */
const NEGATIVE_PATH =
  /\b(error|inválid|invalid|no\s+(?:se|puede|existe|tiene|está)|rechaz|falla|fallo|denegad|denied|sin\s+\w+|vací|empty|expirad|caducad|exced|supera|límite|limite|duplicad|no autorizado|403|404|422|500)\b/i;

/** A dependency on another story, stated in prose. `info` only: sometimes it is a genuine note
 * rather than a coupling, and only the team can tell which. */
const DEPENDENCY = /\b(depende de|requiere (?:la|el) (?:historia|hu)|después de la historia|bloquead[oa] por|depends on)\b/i;

const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];

const PENALTY: Record<QualitySeverity, number> = { error: 15, warn: 7, info: 3 };

/**
 * Everything that can be said about a story without asking a model.
 *
 * Ordered so the card reads top-down the way a refinement session runs: what the story *is*
 * (narrative, scope), how big it is, then the criteria one by one.
 */
export function lintStory(story: StoryDraft): StoryQuality {
  const issues: QualityIssue[] = [];
  const add = (
    severity: QualitySeverity,
    dimension: QualityDimension,
    messageKey: TranslationKey,
    extra?: { params?: Record<string, string | number>; criterion?: number },
  ) => issues.push({ severity, dimension, messageKey, ...extra });

  const criteria = parseCriteria(story.acceptance_criteria);
  const scenarios = criteria.map(parseScenario);

  // --- the shape of the work item ---
  if (!story.title.trim()) add("error", "format", "qa.issue.noTitle");
  else if (story.title.length > 80) {
    add("info", "format", "qa.issue.longTitle", { params: { n: story.title.length } });
  }
  if (!story.description.trim()) add("warn", "format", "qa.issue.noDescription");

  // --- Valuable: the narrative ---
  const narrative = story.narrative.trim();
  if (!narrative) {
    add("error", "valuable", "qa.issue.noNarrative");
  } else {
    const parts = NARRATIVE_ES.exec(narrative) ?? NARRATIVE_EN.exec(narrative);
    if (!parts) {
      add("error", "valuable", "qa.issue.narrativeShape");
    } else {
      const [, role, , benefit] = parts;
      if (GENERIC_ROLES.includes(role.trim().toLowerCase())) {
        add("info", "valuable", "qa.issue.genericRole", { params: { role: role.trim() } });
      }
      if (HOLLOW_BENEFIT.test(benefit)) add("info", "valuable", "qa.issue.hollowBenefit");
    }
  }

  // --- Negotiable / Independent: what the prose gives away ---
  const prose = [story.narrative, story.description, ...criteria].join("\n");
  if (IMPLEMENTATION_WORDS.test(prose)) add("warn", "negotiable", "qa.issue.implementationDetail");
  if (DEPENDENCY.test([story.description, story.notes].join("\n"))) {
    add("info", "independent", "qa.issue.dependsOnAnother");
  }

  // --- Estimable / Small ---
  if (story.story_points === 0) add("warn", "estimable", "qa.issue.noEstimate");
  else if (!FIBONACCI.includes(story.story_points)) {
    add("info", "estimable", "qa.issue.nonFibonacci", { params: { n: story.story_points } });
  }
  if (story.story_points >= 13) add("info", "small", "qa.issue.tooManyPoints", { params: { n: story.story_points } });

  // --- Testable: how many criteria, and whether they cover failure ---
  if (criteria.length === 0) {
    add("error", "testable", "qa.issue.noCriteria");
  } else {
    if (criteria.length === 1) add("warn", "testable", "qa.issue.oneCriterion");
    if (criteria.length > 6) add("warn", "small", "qa.issue.tooManyCriteria", { params: { n: criteria.length } });
    if (!criteria.some((criterion) => NEGATIVE_PATH.test(criterion))) {
      add("warn", "testable", "qa.issue.noNegativePath");
    }
  }

  // --- Gherkin, one criterion at a time ---
  const titles = new Map<string, number>();
  scenarios.forEach((scenario, index) => {
    const at = { criterion: index };

    if (scenario.steps.length === 0) {
      add("error", "gherkin", "qa.issue.notGherkin", at);
      return;
    }
    if (!scenario.title) add("warn", "gherkin", "qa.issue.noScenarioTitle", at);
    else {
      const key = scenario.title.toLowerCase();
      if (titles.has(key)) add("info", "gherkin", "qa.issue.duplicateScenario", at);
      else titles.set(key, index);
    }
    if (scenario.stray.length > 0) {
      add("warn", "gherkin", "qa.issue.strayLine", { ...at, params: { line: scenario.stray[0] } });
    }

    if (scenario.steps[0].continuation) add("error", "gherkin", "qa.issue.leadingConjunction", at);

    const kinds = scenario.steps.map((step) => step.kind);
    if (!kinds.includes("given")) add("warn", "gherkin", "qa.issue.missingGiven", at);
    if (!kinds.includes("when")) add("error", "gherkin", "qa.issue.missingWhen", at);
    if (!kinds.includes("then")) add("error", "gherkin", "qa.issue.missingThen", at);

    // Only the primary keyword counts: `Cuando … Y …` is one action described in two steps, while
    // a second `Cuando` is a second action — and that is a second scenario.
    const whens = scenario.steps.filter((step) => !step.continuation && step.kind === "when").length;
    if (whens > 1) add("error", "gherkin", "qa.issue.multipleWhens", { ...at, params: { n: whens } });

    const compound = scenario.steps.some((step) => step.kind === "then" && /\s+y\s+|\s+and\s+/i.test(step.text));
    if (compound) add("info", "gherkin", "qa.issue.compoundThen", at);

    if (scenario.steps.some((step) => UI_COUPLED.test(step.text))) {
      add("warn", "gherkin", "qa.issue.uiCoupled", at);
    }

    // --- Scenario outlines and their tables ---
    const placeholders = placeholdersIn(scenario);
    const headers = scenario.examples?.headers ?? [];
    if (placeholders.length > 0 && (!scenario.examples || scenario.examples.rows.length === 0)) {
      add("error", "gherkin", "qa.issue.outlineWithoutExamples", at);
    } else if (scenario.examples) {
      if (headers.length === 0 || scenario.examples.rows.length === 0) {
        add("error", "gherkin", "qa.issue.emptyExamples", at);
      }
      for (const name of placeholders) {
        if (!headers.includes(name)) {
          add("error", "gherkin", "qa.issue.unknownPlaceholder", { ...at, params: { name } });
        }
      }
      for (const header of headers) {
        if (!placeholders.includes(header)) {
          add("info", "gherkin", "qa.issue.unusedExampleColumn", { ...at, params: { name: header } });
        }
      }
      const ragged = scenario.examples.rows.find((row) => row.length !== headers.length);
      if (ragged && headers.length > 0) add("error", "gherkin", "qa.issue.raggedExamples", at);
    }
    if (scenario.outline && placeholders.length === 0) {
      add("info", "gherkin", "qa.issue.outlineWithoutPlaceholders", at);
    }
  });

  const score = Math.max(0, 100 - issues.reduce((total, issue) => total + PENALTY[issue.severity], 0));
  const level = issues.some((i) => i.severity === "error")
    ? "error"
    : issues.some((i) => i.severity === "warn")
      ? "warn"
      : "ok";
  return { issues, score, level };
}

/** The set as a whole, for the header above the cards. */
export function lintBatch(stories: StoryDraft[]): {
  score: number;
  errors: number;
  warnings: number;
  clean: number;
} {
  if (stories.length === 0) return { score: 0, errors: 0, warnings: 0, clean: 0 };
  const results = stories.map(lintStory);
  return {
    score: Math.round(results.reduce((total, r) => total + r.score, 0) / results.length),
    errors: results.filter((r) => r.level === "error").length,
    warnings: results.filter((r) => r.level === "warn").length,
    clean: results.filter((r) => r.level === "ok").length,
  };
}

// ---------- exporting as a Cucumber feature ----------

/** `Pagar con tarjeta` → `pagar-con-tarjeta`. Also what makes a tag out of a free-text label.
 * Returns `""` for text with nothing sluggable in it — callers filter, so a blank tags field can
 * never become a tag. */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    // Strip the combining marks `NFD` just separated out, so `Añadir` becomes `anadir` rather
    // than losing the letter entirely.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** `checkout; back office` → `["@checkout", "@back-office"]`. Azure's tag separator is `;`,
 * Gherkin's is whitespace, and an empty field yields no tags at all. */
function gherkinTags(tags: string): string[] {
  return tags
    .split(";")
    .map((tag) => slugify(tag))
    .filter(Boolean)
    .map((tag) => `@${tag}`);
}

/** The file this batch exports to. Stable across re-exports — the point is to overwrite the
 * previous version in the repository, not to accumulate one file per click. */
export function featureFileName(batch: StoryBatch): string {
  return `${slugify(batch.title) || "historias"}.feature`;
}

/** Shifts a block right, keeping whatever indentation it already had — a scenario arrives here
 * with its steps already indented under their title, and flattening that would undo it. */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim() ? pad + line.trimEnd() : ""))
    .join("\n");
}

/**
 * Free prose, made safe to sit in a Gherkin description block.
 *
 * A description ends at the first line that starts with a keyword, so a model that opens a
 * description with "Dado el volumen de pedidos…" would silently turn it into a step and leave the
 * scenario one `Dado` heavier than anyone wrote. Those lines are emitted as comments instead: the
 * text survives, and the parse is unambiguous.
 */
function asDescription(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      const [first = ""] = trimmed.split(/\s+/);
      const collides =
        STEP_KEYWORDS.some((k) => k.word === first.toLowerCase()) ||
        [...SCENARIO_PREFIXES, ...EXAMPLES_PREFIXES].some((prefix) =>
          trimmed.toLowerCase().startsWith(prefix),
        ) ||
        trimmed.startsWith("|") ||
        trimmed.startsWith("@");
      return collides ? `# ${trimmed}` : trimmed;
    })
    .filter(Boolean)
    .join("\n");
}

/** Re-renders one criterion with Cucumber's indentation, giving it a title if it lacks one — a
 * scenario with no name is legal Gherkin and unreadable in a test report. */
function renderScenario(criterion: string, index: number, fallbackTitle: string): string {
  const scenario = parseScenario(criterion);
  if (scenario.steps.length === 0) {
    // Not Gherkin at all. Kept as a comment rather than dropped: the export must never silently
    // lose a criterion, and a commented one is visible to whoever runs the file.
    const quoted = criterion
      .split("\n")
      .map((line) => `# ${line.trim()}`)
      .join("\n");
    return `# TODO (criterio ${index + 1}, sin formato Gherkin):\n${quoted}`;
  }

  const keyword = scenario.outline ? "Esquema del escenario" : "Escenario";
  const title = scenario.title || `${fallbackTitle} (${index + 1})`;
  const lines: string[] = [];
  if (scenario.tags.length > 0) lines.push(scenario.tags.join(" "));
  lines.push(`${keyword}: ${title}`);
  for (const step of scenario.steps) lines.push(`  ${step.keyword} ${step.text}`.trimEnd());

  const examples = scenario.examples;
  if (examples && examples.headers.length > 0) {
    // Columns are padded to their widest cell: an Examples table is read as a table, and a ragged
    // one is where a wrong value hides in plain sight during review.
    const widths = examples.headers.map((header, column) =>
      Math.max(header.length, ...examples.rows.map((row) => (row[column] ?? "").length)),
    );
    const row = (cells: string[]) =>
      `    | ${cells.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join(" | ")} |`;
    lines.push("  Ejemplos:");
    lines.push(row(examples.headers));
    for (const values of examples.rows) lines.push(row(values));
  }

  return lines.join("\n");
}

/**
 * The whole set as one `.feature` file Cucumber can run.
 *
 * One `Característica` for the set and one `Regla` per story, with the "Como… quiero… para…" line
 * as the rule's description. That is the honest mapping: a user story *is* a business rule with
 * scenarios under it, and keeping the narrative attached is what lets a failing scenario point at
 * the story it belongs to instead of at a bare title.
 *
 * `# language: es` is what makes `Dado/Cuando/Entonces` valid keywords rather than free text, so it
 * is the first line and not negotiable. Stories are tagged `@hu-<n>` and, once published, with
 * their work item — which is what makes a red test traceable back to the board.
 */
export function toFeatureFile(batch: StoryBatch, stories: StoryDraft[]): string {
  const out: string[] = [
    "# language: es",
    `# Generado por CodeFlow desde: ${batch.source_ref || batch.title || "documentación"}`,
    "# Se regenera desde el conjunto de historias: edita allí, no aquí.",
    "",
  ];

  const batchTags = gherkinTags(batch.tags);
  if (batchTags.length > 0) out.push(batchTags.join(" "));
  out.push(`Característica: ${batch.title || "Historias de usuario"}`);
  out.push("");

  stories.forEach((story, index) => {
    const criteria = parseCriteria(story.acceptance_criteria);
    const tags = [`@hu-${index + 1}`, ...gherkinTags(story.tags)];
    if (story.work_item_id > 0) tags.push(`@wi-${story.work_item_id}`);

    out.push(indent(tags.join(" "), 2));
    out.push(indent(`Regla: ${story.title || `Historia ${index + 1}`}`, 2));
    if (story.narrative.trim()) out.push(indent(asDescription(story.narrative), 4));
    if (story.description.trim()) {
      out.push(indent(asDescription(story.description.split("\n").join(" ")), 4));
    }
    out.push("");

    if (criteria.length === 0) {
      out.push(indent("# Sin criterios de aceptación: nada que ejecutar todavía.", 4));
      out.push("");
      return;
    }
    for (const [at, criterion] of criteria.entries()) {
      out.push(indent(renderScenario(criterion, at, story.title || `Historia ${index + 1}`), 4));
      out.push("");
    }
  });

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
