import type { TranslationKey } from "../i18n/translations";
import type { FileSpec, QuarkusRequest, ScaffoldPlatform, SpringRequest, VersionLine, VersionSource } from "./api";
import { quote, type Step } from "./script";
import { VALID_JAVA_PACKAGE } from "./spring";
import type { ToolId } from "./tools";

/**
 * Every template the project initializer offers, and exactly what each one runs.
 *
 * **Each command here was run, in a pty, before it was written down** (September 2026, against the
 * then-current releases), because that is the only way to find the questions a generator asks when
 * it thinks a person is watching. What turned up, and what answers it:
 *
 * - create-vite goes interactive in any TTY → `--no-interactive --no-immediate`.
 * - Angular asks about analytics on first run, whatever the flags → `NG_CLI_ANALYTICS=false`.
 * - Nest's schematic asks ESM or CommonJS and has no flag for it → `NG_FORCE_TTY=false`, which makes
 *   the schematics runner take its default (ESM, with Vitest) instead of prompting.
 * - Nuxt asks to browse modules → an empty `--modules=`; its `postinstall` then asks about
 *   telemetry → `NUXT_TELEMETRY_DISABLED=1` on the install.
 * - create-vue is interactive unless at least one feature flag is given → `--default` when none is.
 * - create-next-app remembers answers between runs → every choice is passed, plus `--yes`.
 * - Expo initialises its own git repository; harmless, since the runner's `git init` re-initialises.
 * - `bun init` asks for a template, a package name and an entry point → `--yes` takes the defaults,
 *   and `--react[=tailwind|shadcn]` picks a React template without asking — from Bun 1.2.14 on (see
 *   `BUN_INIT_FLOOR`). It also writes CLAUDE.md, or a Cursor rule, for the agents it finds installed
 *   → `BUN_AGENT_RULE_DISABLED=1` when that option is off.
 *
 * Anything a future release adds is still only a question in the terminal the dialog shows, which is
 * why the commands run in a pty at all (see `src-tauri/src/scaffold/run.rs`).
 *
 * **Git is the runner's, not the template's.** Every generator that would initialise a repository is
 * told not to, and the runner adds `git init` and an initial commit to every plan the same way — so a
 * project is a repository (which is what lets it be imported into a workspace at all) and its first
 * commit is the user's, whichever tool made it.
 */

export type Category = "general" | "frontend" | "backend" | "mobile";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type OptionValue = string | boolean;
export type Options = Record<string, OptionValue>;

interface OptionBase {
  id: string;
  /** Brand words (Pinia, Tailwind CSS) are not translated; everything else is a key. */
  label?: string;
  labelKey?: TranslationKey;
  /** Shown only when this holds. `line` is the picked version's major — `NaN` when it is not known
   *  (no picker, or the registry did not answer). */
  when?: (opts: Options, line: number) => boolean;
}

export interface ChoiceOption extends OptionBase {
  kind: "choice";
  choices: { value: string; label?: string; labelKey?: TranslationKey }[];
  default: string;
}

export interface ToggleOption extends OptionBase {
  kind: "toggle";
  default: boolean;
  /** Drawn with the rest of its group under this heading, instead of in the shared "Include" row —
   *  NestJS's dependencies, Quarkus's extensions: a list of their own rather than extras of the
   *  template, picked the way Spring's starters are (chips and «+ Add», see `DependencyPicker`). */
  group?: TranslationKey;
  /** In a group: the heading it is listed under in the picker's menu. */
  section?: TranslationKey;
  /** In a group: one line on what it adds, under its name in the menu. */
  descriptionKey?: TranslationKey;
  /** In a group: offered one click away under the chips while not picked. */
  popular?: boolean;
}

export interface TextOption extends OptionBase {
  kind: "text";
  /** From the project's name, until the user edits it. */
  default: (name: string) => string;
  /** A translation key naming what is wrong, or `null`. */
  validate?: (value: string) => TranslationKey | null;
}

/** A version of a runtime, picked from its registry lines (`python` → 3.13, 3.12…). */
export interface RuntimeOption extends OptionBase {
  kind: "runtime";
  tool: ToolId;
}

export type TemplateOption = ChoiceOption | ToggleOption | TextOption | RuntimeOption;

export interface Requirement {
  tool: ToolId;
  /** In the tool's dialect (see `TOOLS[tool].dialect`). Absent: any version will do. */
  range?: string | null;
  /** Who asks for it, for the row's tooltip — "Angular 22.2.0". */
  because?: string;
}

/** What `requirements` and `plan` are given. */
export interface TemplateContext {
  /** The folder name. */
  name: string;
  /** Absolute. */
  parent: string;
  /** `parent` + separator + `name`. */
  root: string;
  sep: string;
  platform: ScaffoldPlatform;
  /** The framework version picked, when the template has a picker. */
  version: VersionLine | null;
  /** The newest line of `template.engines`, when the template reads its runtime requirement there. */
  engines: VersionLine | null;
  opts: Options;
  pm: PackageManager;
  /** Tools found on this machine — a default can depend on them (uv over venv). */
  present: Set<string>;
  /** Step titles, in the app's language. */
  label: (key: TranslationKey) => string;
  /** The Spring form, for the one template that has it. */
  spring?: SpringRequest;
}

export interface Plan {
  /** start.spring.io's zip, unpacked as the project before anything else runs. */
  spring?: SpringRequest;
  /** code.quarkus.io's, the same way. */
  quarkus?: QuarkusRequest;
  /** Written into the project folder before the steps run — which makes the folder, so an empty
   *  list is a plan asking for the folder alone (the empty template). */
  files?: FileSpec[];
  steps: Step[];
  /** How to start it, shown when it is done. */
  run?: string;
  /** Nothing in the folder to commit: the initial commit is made empty, so the repository has a
   *  first commit — and a branch to branch from or put a worktree on — from the start. */
  emptyCommit?: boolean;
}

export interface Template {
  id: string;
  name: string;
  /** For a name that is a word rather than a brand ("Empty"): shown in the app's language, while
   *  the search still matches `name` as well. See `templateName`. */
  nameKey?: TranslationKey;
  category: Category;
  /** A key in `SCAFFOLD_LOGOS`. */
  logo: string;
  descriptionKey: TranslationKey;
  /** The framework version picker's source. */
  versions?: VersionSource;
  /** Hides lines too old for the flags this template passes. */
  versionFilter?: (line: VersionLine) => boolean;
  /** Which lines are LTS when the registry does not say — Django's `x.2`. */
  ltsLine?: (line: string) => boolean;
  /** Where the runtime requirement lives when it is not the generator's: Nuxt's is `nuxt`'s. A
   *  function when the answer depends on what is picked — SolidStart needs a newer Node than a
   *  plain Solid app on Vite. Given the choices and toggles only (see `enginesFor`). */
  engines?: VersionSource | ((opts: Options) => VersionSource);
  defaultName: string;
  /** npm package-name rules on top of folder rules: lowercase, no spaces. */
  npmName?: boolean;
  /** The package managers it accepts; absent, it takes none. */
  pms?: PackageManager[];
  /** The Spring form instead of generic options. */
  spring?: boolean;
  options: TemplateOption[];
  requirements: (ctx: TemplateContext) => Requirement[];
  plan: (ctx: TemplateContext) => Plan;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

const ALL_PMS: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

/** Runs a package from the registry without installing it. Yarn classic has no `dlx`, so yarn
 *  users get `npx` for the generator and yarn for everything after it. */
export function dlx(pm: PackageManager, spec: string, args: string[]): string[] {
  if (pm === "pnpm") return ["pnpm", "dlx", spec, ...args];
  if (pm === "bun") return ["bun", "x", spec, ...args];
  return ["npx", "--yes", spec, ...args];
}

export function installCmd(pm: PackageManager): string[] {
  return [pm, "install"];
}

/** Each manager spells "development dependency" its own way — pnpm refuses `--dev` on `add`
 *  (it means "only dev dependencies" to `install`), yarn and bun take it. */
export function addCmd(pm: PackageManager, packages: string[], dev = false): string[] {
  if (pm === "npm") return ["npm", "install", ...(dev ? ["--save-dev"] : []), ...packages];
  if (pm === "pnpm") return ["pnpm", "add", ...(dev ? ["--save-dev"] : []), ...packages];
  return [pm, "add", ...(dev ? ["--dev"] : []), ...packages];
}

export function runCmd(pm: PackageManager, script: string): string {
  return pm === "npm" ? `npm run ${script}` : `${pm} ${script}`;
}

/** The exact version picked, or `latest` for a template with no picker (or a picker that failed). */
function at(ctx: TemplateContext): string {
  return ctx.version?.version ?? "latest";
}

function major(ctx: TemplateContext): number {
  return Number(ctx.version?.line ?? Number.NaN);
}

function nodeRequirement(ctx: TemplateContext, name: string, fallback?: string): Requirement {
  const range = ctx.version?.requires ?? ctx.engines?.requires ?? fallback ?? null;
  const which = ctx.version ? `${name} ${ctx.version.version}` : ctx.engines ? `${name} (${ctx.engines.version})` : name;
  return { tool: "node", range, because: which };
}

function pmRequirements(ctx: TemplateContext): Requirement[] {
  return ctx.pm === "npm" ? [] : [{ tool: ctx.pm }];
}

const LANGUAGE: ChoiceOption = {
  id: "language",
  kind: "choice",
  labelKey: "scaffold.opt.language",
  choices: [
    { value: "ts", label: "TypeScript" },
    { value: "js", label: "JavaScript" },
  ],
  default: "ts",
};

const AGENTS: ToggleOption = { id: "agents", kind: "toggle", labelKey: "scaffold.opt.agents", default: true };

const ts = (ctx: TemplateContext) => ctx.opts.language !== "js";

/** A step that runs from the parent folder — a generator making the project's folder itself. */
function inParent(ctx: TemplateContext, title: TranslationKey, argv: string[], env?: Record<string, string>): Step {
  return { title: ctx.label(title), cwd: ctx.parent, argv, env };
}

function inRoot(ctx: TemplateContext, title: TranslationKey, argv: string[], env?: Record<string, string>): Step {
  return { title: ctx.label(title), cwd: ctx.root, argv, env };
}

const NODE_GITIGNORE = "node_modules/\ndist/\n.env\n.env.*\n!.env.example\n*.log\n.DS_Store\n";

const PYTHON_GITIGNORE =
  ".venv/\n__pycache__/\n*.py[cod]\n.env\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\ndb.sqlite3\n.DS_Store\n";

/** Python's two ways in: uv (which can fetch the interpreter itself) or a plain venv + pip. */
const PY_ENV: ChoiceOption = {
  id: "env",
  kind: "choice",
  labelKey: "scaffold.opt.env",
  choices: [
    { value: "uv", label: "uv" },
    { value: "venv", label: "venv + pip" },
  ],
  default: "uv",
};

const PY_VERSION: RuntimeOption = {
  id: "python",
  kind: "runtime",
  tool: "python",
  label: "Python",
  // Only uv can hand a project an interpreter it does not have; venv uses the one installed.
  when: (opts) => opts.env !== "venv",
};

function venvPython(ctx: TemplateContext): string {
  return ctx.platform === "windows"
    ? [ctx.root, ".venv", "Scripts", "python.exe"].join(ctx.sep)
    : [ctx.root, ".venv", "bin", "python"].join(ctx.sep);
}

/**
 * The environment half of every Python template: a project with `packages` installed, either managed
 * by uv (pyproject + lock, interpreter pinned) or as a venv with a frozen `requirements.txt`.
 *
 * The interpreter uv pins is the one picked in the form; if the Python lines could not be fetched it
 * is the floor of what the framework itself requires (`>=3.12` → 3.12), never a number of ours — and
 * with neither, uv is left to choose.
 */
function pythonSteps(ctx: TemplateContext, packages: string[], requires: string | null): Step[] {
  if (ctx.opts.env === "venv") {
    const python = venvPython(ctx);
    const system = ctx.platform === "windows" ? "python" : "python3";
    return [
      inRoot(ctx, "scaffold.step.env", [system, "-m", "venv", ".venv"]),
      inRoot(ctx, "scaffold.step.deps", [python, "-m", "pip", "install", ...packages]),
      {
        title: ctx.label("scaffold.step.freeze"),
        cwd: ctx.root,
        sh: `'${python.replace(/'/g, `'\\''`)}' -m pip freeze > requirements.txt`,
        ps: `& '${python.replace(/'/g, "''")}' -m pip freeze | Out-File -Encoding utf8 requirements.txt; Cf-Check`,
      },
    ];
  }
  const python = String(ctx.opts.python || "") || (/>=\s*(\d+\.\d+)/.exec(requires ?? "")?.[1] ?? "");
  return [
    inRoot(ctx, "scaffold.step.env", [
      "uv",
      "init",
      "--bare",
      "--no-workspace",
      "--vcs",
      "none",
      "--name",
      ctx.name,
      ...(python ? ["--python", python] : []),
    ]),
    ...(python ? [inRoot(ctx, "scaffold.step.pin", ["uv", "python", "pin", python])] : []),
    inRoot(ctx, "scaffold.step.deps", ["uv", "add", ...packages]),
  ];
}

function pythonRequirements(ctx: TemplateContext, name: string, requires: string | null): Requirement[] {
  if (ctx.opts.env === "venv") return [{ tool: "python", range: requires, because: name }];
  return [{ tool: "uv" }];
}

/** A PEP 440 pin to the picked line: `5.2` → `~=5.2.0`. */
function compatible(line: VersionLine | null): string {
  return line ? `~=${line.line}.0` : "";
}

function pythonRun(ctx: TemplateContext, uvCommand: string, venvCommand: string): string {
  if (ctx.opts.env !== "venv") return uvCommand;
  const bin = ctx.platform === "windows" ? ".venv\\Scripts\\" : ".venv/bin/";
  return `${bin}${venvCommand}`;
}

const VALID_GO_MODULE = /^[a-z0-9][a-z0-9._~/-]*$/;

/**
 * The oldest Bun whose `bun init` builds every template below from flags alone. 1.2.13 reads no
 * `--react=…`: it opens its template menu instead and, with nobody there to answer, prints
 * "Cancelled" and exits 0 — leaving an empty folder the runner would go on to make a repository of
 * (checked 2026-09-28 against 1.2.13, 1.2.14 and 1.4.2). A fact about Bun's history, not a version
 * to install: an install always takes the current release.
 */
const BUN_INIT_FLOOR = ">=1.2.14";

/** `bun init`'s flag for each template. The blank one's is `--yes`: every default taken — the
 *  folder's name for the package, `index.ts` for the entry point — instead of asked for. */
function bunInitFlag(template: OptionValue | undefined): string {
  if (template === "react") return "--react";
  if (template === "tailwind" || template === "shadcn") return `--react=${template}`;
  return "--yes";
}

/** Which HTTP server a NestJS application runs on. Express is what `nest new` writes; Fastify is the
 *  other adapter Nest ships, swapped in after generating (see `NEST_FASTIFY_PATCH`). */
const NEST_PLATFORM: ChoiceOption = {
  id: "platform",
  kind: "choice",
  labelKey: "scaffold.opt.platform",
  choices: [
    { value: "express", label: "Express" },
    { value: "fastify", label: "Fastify" },
  ],
  default: "express",
};

/**
 * The integrations NestJS's own documentation walks through (Techniques and Security), picked under
 * "Dependencies" the way Spring's starters are — and, since 2026-10-08, every package the Nest core
 * team publishes (npm's `nestjscore`, the user's ask: "agrega todo este listado porque es del core"),
 * except the ones every generated project already has (`core`, `common`, `platform-express`,
 * `testing`, `cli`, `schematics`; Fastify is the HTTP server choice), the deprecated ones
 * (`azure-serverless`, `serverless-core`), the 2021–22 forks of `class-validator` and
 * `class-transformer` (Validation installs the maintained originals), Angular Universal's
 * `ng-universal` (Nest ≤10, and an Angular app, not an API), `bull-shared` (installed by Bull and
 * BullMQ themselves), `mau` (a CLI installed globally to deploy, not a project dependency) and
 * `azure-func-http` (stops at Nest 10 *and* at `reflect-metadata` 0.1, which no project the CLI
 * generates still has — npm refuses it, checked 2026-10-08).
 *
 * The ORMs come without a database driver: which database is a decision of its own, and the module
 * installs and compiles without one. Where Express and Fastify need different packages (Helmet,
 * compression, Swagger's and serve-static's static files, Apollo's integration), the platform picked
 * decides. `core` marks the ones released with `@nestjs/core` itself, which are pinned to the
 * generated project's major so npm does not refuse the peer range; `since` and `until` bound the
 * others to the Nest majors their peer ranges accept (see `nestFits`).
 */
interface NestDependency {
  id: string;
  label?: string;
  labelKey?: TranslationKey;
  section: TranslationKey;
  descriptionKey: TranslationKey;
  popular?: boolean;
  packages: (fastify: boolean) => string[];
  /** TypeScript only. */
  types?: (fastify: boolean) => string[];
  core?: boolean;
  /** The first Nest major it works with, and the last. Outside them the picker does not offer it and
   *  the plan leaves it out — npm would refuse its peer range. Not said in the description: the user
   *  cut it to the features ("deja el texto solo hasta fallbacks"). */
  since?: number;
  until?: number;
  /** Offered only when this holds — Mercurius only exists on Fastify. */
  when?: (opts: Options) => boolean;
}

/**
 * Whether a dependency can go into a project generated at Nest `line`. Unknown (`NaN`: no version
 * answer) reads as the CLI's current major, which is past every `since` and beyond every `until`.
 */
function nestFits(dependency: NestDependency, line: number): boolean {
  const at = Number.isFinite(line) ? line : Number.POSITIVE_INFINITY;
  return (!dependency.since || at >= dependency.since) && (!dependency.until || at <= dependency.until);
}

const NEST_DEPENDENCIES: NestDependency[] = [
  {
    id: "nestConfig",
    labelKey: "scaffold.nest.config",
    section: "scaffold.depGroup.core",
    descriptionKey: "scaffold.nest.d.config",
    popular: true,
    packages: () => ["@nestjs/config"],
  },
  {
    id: "nestValidation",
    labelKey: "scaffold.nest.validation",
    section: "scaffold.depGroup.core",
    descriptionKey: "scaffold.nest.d.validation",
    popular: true,
    packages: () => ["class-validator", "class-transformer"],
  },
  {
    id: "nestSwagger",
    label: "Swagger (OpenAPI)",
    section: "scaffold.depGroup.web",
    descriptionKey: "scaffold.nest.d.swagger",
    popular: true,
    packages: (fastify) => (fastify ? ["@nestjs/swagger", "@fastify/static"] : ["@nestjs/swagger"]),
  },
  {
    id: "nestJwt",
    label: "JWT + Passport",
    section: "scaffold.depGroup.security",
    descriptionKey: "scaffold.nest.d.jwt",
    popular: true,
    packages: () => ["@nestjs/jwt", "@nestjs/passport", "passport", "passport-jwt"],
    types: () => ["@types/passport-jwt"],
  },
  {
    id: "nestThrottler",
    labelKey: "scaffold.nest.throttler",
    section: "scaffold.depGroup.security",
    descriptionKey: "scaffold.nest.d.throttler",
    packages: () => ["@nestjs/throttler"],
  },
  {
    id: "nestSchedule",
    labelKey: "scaffold.nest.schedule",
    section: "scaffold.depGroup.ops",
    descriptionKey: "scaffold.nest.d.schedule",
    packages: () => ["@nestjs/schedule"],
  },
  {
    id: "nestCache",
    labelKey: "scaffold.nest.cache",
    section: "scaffold.depGroup.ops",
    descriptionKey: "scaffold.nest.d.cache",
    packages: () => ["@nestjs/cache-manager", "cache-manager"],
  },
  {
    id: "nestEvents",
    labelKey: "scaffold.nest.events",
    section: "scaffold.depGroup.core",
    descriptionKey: "scaffold.nest.d.events",
    packages: () => ["@nestjs/event-emitter"],
  },
  {
    id: "nestHttp",
    labelKey: "scaffold.nest.http",
    section: "scaffold.depGroup.web",
    descriptionKey: "scaffold.nest.d.http",
    packages: () => ["@nestjs/axios", "axios"],
  },
  {
    id: "nestHealth",
    label: "Health checks (Terminus)",
    section: "scaffold.depGroup.ops",
    descriptionKey: "scaffold.nest.d.health",
    packages: () => ["@nestjs/terminus"],
  },
  {
    // Released 2026-10-08 as 0.0.x (peers: Nest 12; GraphQL, WebSockets and microservices optional,
    // so nothing extra is installed) — versioned apart from `@nestjs/core`, so not `core`.
    id: "nestResilience",
    labelKey: "scaffold.nest.resilience",
    section: "scaffold.depGroup.ops",
    descriptionKey: "scaffold.nest.d.resilience",
    packages: () => ["@nestjs/resilience"],
    since: 12,
  },
  // ── The rest of the core team's packages (see the note above) ──
  { id: "nestMicroservices", labelKey: "scaffold.nest.microservices", section: "scaffold.depGroup.core", descriptionKey: "scaffold.nest.d.microservices", packages: () => ["@nestjs/microservices"], core: true },
  { id: "nestCqrs", label: "CQRS", section: "scaffold.depGroup.core", descriptionKey: "scaffold.nest.d.cqrs", packages: () => ["@nestjs/cqrs"], since: 12 },
  { id: "nestWorkflows", labelKey: "scaffold.nest.workflows", section: "scaffold.depGroup.core", descriptionKey: "scaffold.nest.d.workflows", packages: () => ["@nestjs/workflows"], since: 11 },
  { id: "nestOutbox", labelKey: "scaffold.nest.outbox", section: "scaffold.depGroup.core", descriptionKey: "scaffold.nest.d.outbox", packages: () => ["@nestjs/outbox"], since: 11 },
  { id: "nestIdempotency", labelKey: "scaffold.nest.idempotency", section: "scaffold.depGroup.core", descriptionKey: "scaffold.nest.d.idempotency", packages: () => ["@nestjs/idempotency"], since: 11 },
  { id: "nestLocks", labelKey: "scaffold.nest.locks", section: "scaffold.depGroup.core", descriptionKey: "scaffold.nest.d.locks", packages: () => ["@nestjs/locks"], since: 11 },
  { id: "nestI18n", labelKey: "scaffold.nest.i18n", section: "scaffold.depGroup.core", descriptionKey: "scaffold.nest.d.i18n", packages: () => ["@nestjs/i18n"], since: 12 },
  { id: "nestMappedTypes", labelKey: "scaffold.nest.mappedTypes", section: "scaffold.depGroup.core", descriptionKey: "scaffold.nest.d.mappedTypes", packages: () => ["@nestjs/mapped-types"] },
  { id: "nestAuthentication", labelKey: "scaffold.nest.authentication", section: "scaffold.depGroup.security", descriptionKey: "scaffold.nest.d.authentication", packages: () => ["@nestjs/authentication"], since: 12 },
  { id: "nestAuthorization", labelKey: "scaffold.nest.authorization", section: "scaffold.depGroup.security", descriptionKey: "scaffold.nest.d.authorization", packages: () => ["@nestjs/authorization"], since: 12 },
  { id: "nestHttpClient", labelKey: "scaffold.nest.httpClient", section: "scaffold.depGroup.web", descriptionKey: "scaffold.nest.d.httpClient", packages: () => ["@nestjs/http-client"], since: 11 },
  {
    // Apollo Server 5 still wants GraphQL 16 (npm's latest is 17), hence the pin; and it reaches the
    // HTTP server through an integration package of its own per platform.
    id: "nestApollo",
    label: "GraphQL (Apollo)",
    section: "scaffold.depGroup.web",
    descriptionKey: "scaffold.nest.d.apollo",
    packages: (fastify) => ["@nestjs/graphql", "@nestjs/apollo", "@apollo/server", fastify ? "@as-integrations/fastify" : "@as-integrations/express5", "graphql@^16"],
    since: 12,
  },
  {
    id: "nestMercurius",
    label: "GraphQL (Mercurius)",
    section: "scaffold.depGroup.web",
    descriptionKey: "scaffold.nest.d.mercurius",
    packages: () => ["@nestjs/graphql", "@nestjs/mercurius", "mercurius", "graphql@^16"],
    since: 12,
    when: (opts) => opts.platform === "fastify",
  },
  { id: "nestWs", label: "WebSockets (ws)", section: "scaffold.depGroup.web", descriptionKey: "scaffold.nest.d.ws", packages: () => ["@nestjs/websockets", "@nestjs/platform-ws"], core: true },
  {
    id: "nestServeStatic",
    labelKey: "scaffold.nest.serveStatic",
    section: "scaffold.depGroup.web",
    descriptionKey: "scaffold.nest.d.serveStatic",
    packages: (fastify) => (fastify ? ["@nestjs/serve-static", "@fastify/static"] : ["@nestjs/serve-static"]),
    since: 12,
  },
  // Webhooks are built on the outbox, which they require.
  { id: "nestWebhooks", label: "Webhooks", section: "scaffold.depGroup.web", descriptionKey: "scaffold.nest.d.webhooks", packages: () => ["@nestjs/webhooks", "@nestjs/outbox"], since: 12 },
  { id: "nestMail", labelKey: "scaffold.nest.mail", section: "scaffold.depGroup.web", descriptionKey: "scaffold.nest.d.mail", packages: () => ["@nestjs/mail"], since: 11 },
  { id: "nestStorage", labelKey: "scaffold.nest.storage", section: "scaffold.depGroup.web", descriptionKey: "scaffold.nest.d.storage", packages: () => ["@nestjs/storage"], since: 12 },
  { id: "nestTypeorm", label: "TypeORM", section: "scaffold.depGroup.data", descriptionKey: "scaffold.nest.d.typeorm", packages: () => ["@nestjs/typeorm", "typeorm"] },
  { id: "nestMongoose", label: "Mongoose (MongoDB)", section: "scaffold.depGroup.data", descriptionKey: "scaffold.nest.d.mongoose", packages: () => ["@nestjs/mongoose", "mongoose"], since: 11 },
  { id: "nestSequelize", label: "Sequelize", section: "scaffold.depGroup.data", descriptionKey: "scaffold.nest.d.sequelize", packages: () => ["@nestjs/sequelize", "sequelize", "sequelize-typescript"], since: 11 },
  { id: "nestDrizzle", label: "Drizzle ORM", section: "scaffold.depGroup.data", descriptionKey: "scaffold.nest.d.drizzle", packages: () => ["@nestjs/drizzle", "drizzle-orm"], since: 11 },
  { id: "nestElasticsearch", label: "Elasticsearch", section: "scaffold.depGroup.data", descriptionKey: "scaffold.nest.d.elasticsearch", packages: () => ["@nestjs/elasticsearch", "@elastic/elasticsearch"] },
  { id: "nestStoreKit", label: "Store kit (SQL)", section: "scaffold.depGroup.data", descriptionKey: "scaffold.nest.d.storeKit", packages: () => ["@nestjs/store-kit"] },
  // Azure's two have not moved past Nest 11, so they are offered only on projects generated at 10 or
  // 11; Blob storage is built on platform-express.
  { id: "nestAzureDatabase", label: "Azure Database", section: "scaffold.depGroup.data", descriptionKey: "scaffold.nest.d.azureDatabase", packages: () => ["@nestjs/azure-database"], until: 11 },
  {
    id: "nestAzureStorage",
    label: "Azure Blob Storage",
    section: "scaffold.depGroup.data",
    descriptionKey: "scaffold.nest.d.azureStorage",
    packages: () => ["@nestjs/azure-storage"],
    until: 11,
    when: (opts) => opts.platform !== "fastify",
  },
  { id: "nestBullmq", labelKey: "scaffold.nest.bullmq", section: "scaffold.depGroup.ops", descriptionKey: "scaffold.nest.d.bullmq", packages: () => ["@nestjs/bullmq", "bullmq"] },
  { id: "nestBull", labelKey: "scaffold.nest.bull", section: "scaffold.depGroup.ops", descriptionKey: "scaffold.nest.d.bull", packages: () => ["@nestjs/bull", "bull"] },
  {
    // On Nest 12 the CLI sets it up itself (`--observe`: installed *and* wired in); before, installed.
    id: "nestObserve",
    label: "Observe (APM)",
    section: "scaffold.depGroup.ops",
    descriptionKey: "scaffold.nest.d.observe",
    packages: () => ["@nestjs/observe"],
    since: 11,
  },
  { id: "nestDevtools", label: "Devtools", section: "scaffold.depGroup.ops", descriptionKey: "scaffold.nest.d.devtools", packages: () => ["@nestjs/devtools-integration"], since: 12 },
  {
    id: "nestHelmet",
    label: "Helmet",
    section: "scaffold.depGroup.security",
    descriptionKey: "scaffold.nest.d.helmet",
    popular: true,
    packages: (fastify) => [fastify ? "@fastify/helmet" : "helmet"],
  },
  {
    id: "nestCompression",
    labelKey: "scaffold.nest.compression",
    section: "scaffold.depGroup.web",
    descriptionKey: "scaffold.nest.d.compression",
    packages: (fastify) => [fastify ? "@fastify/compress" : "compression"],
    types: (fastify) => (fastify ? [] : ["@types/compression"]),
  },
  {
    id: "nestWebsockets",
    label: "WebSockets (Socket.IO)",
    section: "scaffold.depGroup.web",
    descriptionKey: "scaffold.nest.d.websockets",
    packages: () => ["@nestjs/websockets", "@nestjs/platform-socket.io"],
    core: true,
  },
];

const NEST_DEPENDENCY_OPTIONS: ToggleOption[] = NEST_DEPENDENCIES.map((dependency) => ({
  id: dependency.id,
  kind: "toggle",
  label: dependency.label,
  labelKey: dependency.labelKey,
  // Only what this Nest line (and platform) can take — see `nestFits`.
  when: (opts: Options, line: number) => nestFits(dependency, line) && (!dependency.when || dependency.when(opts)),
  default: false,
  group: "scaffold.opt.dependencies",
  section: dependency.section,
  descriptionKey: dependency.descriptionKey,
  popular: dependency.popular,
}));

/**
 * Puts a NestJS application generated for Express on Fastify: the adapter goes into
 * `NestFactory.create`, and its import at the top. Edited in place rather than rewritten, because
 * `main.ts` is not the same file from one CLI major to the next (CommonJS, then ESM with `.js`
 * imports and a top-level `await`). A `main` that no longer reads `NestFactory.create(AppModule)`
 * fails the step out loud instead of being left on Express by surprise.
 *
 * The generated end-to-end test keeps building its app with the default adapter — which is why
 * `@nestjs/platform-express` stays installed — so `test:e2e` passes as generated.
 *
 * Single quotes only: this is one argument to `node -e`, quoted for sh and for PowerShell, and
 * Windows PowerShell mangles double quotes in arguments to a native command.
 */
const NEST_FASTIFY_PATCH = [
  "const fs=require('fs');",
  "const file=fs.existsSync('src/main.ts')?'src/main.ts':'src/main.js';",
  "let code=fs.readFileSync(file,'utf8');",
  "const from='NestFactory.create(AppModule)';",
  "if(!code.includes(from)){console.error(file+': '+from+' not found');process.exit(1);}",
  "const typed=file.endsWith('.ts');",
  "code=code.replace(from,typed?'NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())':'NestFactory.create(AppModule, new FastifyAdapter())');",
  "code=(typed?'import { FastifyAdapter, type NestFastifyApplication } from \\'@nestjs/platform-fastify\\';\\n':'import { FastifyAdapter } from \\'@nestjs/platform-fastify\\';\\n')+code;",
  "fs.writeFileSync(file,code);",
].join("");

/**
 * Gives `package.json` the folder's name — for the starters that keep their own (`example-basic`,
 * `my-qwik-empty-starter`), where every other generator names the project after its folder. The
 * name goes in as an argument, never into the code; single quotes only, as in `NEST_FASTIFY_PATCH`.
 */
const NAME_PACKAGE = [
  "const fs=require('fs');",
  "const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));",
  "pkg.name=process.argv[1];",
  "fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\\n');",
].join("");

function namePackage(ctx: TemplateContext): Step {
  return inRoot(ctx, "scaffold.step.name", ["node", "-e", NAME_PACKAGE, ctx.name]);
}

/** Solid's starters, by kind — `create-solid`'s own names for them (`-t`), the ones that work as
 *  generated in both languages. Run in a pty, both kinds, npm and pnpm, 2026-10-01. */
const SOLID_KIND: ChoiceOption = {
  id: "kind",
  kind: "choice",
  labelKey: "scaffold.opt.kind",
  choices: [
    { value: "vanilla", label: "SolidJS + Vite" },
    { value: "solidstart", label: "SolidStart" },
  ],
  default: "vanilla",
};

const SOLID_VITE_TEMPLATE: ChoiceOption = {
  id: "viteTemplate",
  kind: "choice",
  labelKey: "scaffold.opt.template",
  choices: [
    { value: "basic", label: "Basic" },
    { value: "bare", label: "Bare" },
    { value: "with-solid-router", label: "Solid Router" },
    { value: "with-tailwindcss", label: "Tailwind CSS" },
    { value: "with-vitest", label: "Vitest" },
  ],
  default: "basic",
  when: (opts) => opts.kind !== "solidstart",
};

const SOLID_START_TEMPLATE: ChoiceOption = {
  id: "startTemplate",
  kind: "choice",
  labelKey: "scaffold.opt.template",
  choices: [
    { value: "basic", label: "Basic" },
    { value: "bare", label: "Bare" },
    { value: "with-tailwindcss", label: "Tailwind CSS" },
    { value: "with-auth", label: "Auth" },
    { value: "with-drizzle", label: "Drizzle" },
    { value: "with-trpc", label: "tRPC" },
    { value: "with-mdx", label: "MDX" },
    { value: "with-vitest", label: "Vitest" },
  ],
  default: "basic",
  when: (opts) => opts.kind === "solidstart",
};

/** AdonisJS 7's starter kits (`create-adonisjs` 3.x). Each comes with SQLite and auth already set
 *  up — the database and auth-guard flags were AdonisJS 6's and are gone. */
const ADONIS_KIT: ChoiceOption = {
  id: "kit",
  kind: "choice",
  labelKey: "scaffold.opt.template",
  choices: [
    { value: "hypermedia", label: "Hypermedia" },
    { value: "react", label: "React (Inertia)" },
    { value: "vue", label: "Vue (Inertia)" },
    { value: "api", label: "API" },
    { value: "api-monorepo", label: "API (monorepo)" },
  ],
  default: "hypermedia",
};

/**
 * `create-adonisjs` exits 0 whatever happens — a refused folder, a failed install — because its
 * command framework records the exit code and never hands it to the process (checked 2026-10-01).
 * The `.env` it copies from `.env.example` is only there once the install has gone through, so its
 * absence is the failure, said in the terminal and failing the script before git makes a commit of
 * half a project.
 */
function adonisCheck(ctx: TemplateContext, kit: string): Step {
  const env = kit === "api-monorepo" ? "apps/backend/.env" : ".env";
  const problem = ctx.label("scaffold.err.adonisIncomplete");
  return {
    title: ctx.label("scaffold.step.verify"),
    cwd: ctx.root,
    sh: `test -f ${quote("sh", env)} || { printf '%s\\n' ${quote("sh", problem)} >&2; exit 1; }`,
    ps: `if (-not (Test-Path -LiteralPath ${quote("ps", env)})) { Write-Host ${quote("ps", problem)} -ForegroundColor Red; exit 1 }`,
  };
}

/**
 * Where RubyGems may write. Homebrew's Ruby links the rdoc plugin it bundles from its read-only
 * Cellar into the gem directory, so installing a newer rdoc — which a new Rails app's bundle asks
 * for — fails there with "Permission denied" (homebrew-core #261905), and `rails new` then exits 0
 * with half its gems missing. On such a Ruby, this points `GEM_HOME` at the user's own gem
 * directory for the rest of the script: it is on Ruby's default gem path, so the app runs from a
 * plain terminal afterwards. Anywhere the gem directory can be written, nothing changes.
 *
 * sh only: RubyInstaller's gem directory on Windows has no such link, and the step is skipped there.
 */
const RUBY_GEM_HOME =
  "CF_GEM_HOME=$(ruby -e 'd = Gem.dir; locked = !File.writable?(d) || " +
  'Dir[File.join(d, "plugins", "*")].any? { |f| !File.writable?((File.realpath(f) rescue f)) }; ' +
  "print(locked ? Gem.user_dir : \"\")'); " +
  'if [ -n "$CF_GEM_HOME" ]; then export GEM_HOME="$CF_GEM_HOME"; printf \'GEM_HOME=%s\\n\' "$GEM_HOME"; fi';

/**
 * Runs the `rails` executable of exactly `version`, as the gem installed it — not whatever `rails` is
 * first on `PATH`, which on macOS is the system's stub ("Rails is not currently installed") and with
 * Homebrew's Ruby is never its gem binaries. Not `gem exec`, either: RubyGems 3.4 (Ruby 3.2, which
 * Rails 8 still takes) has no such command, and with one it re-resolves and upgrades what it needs.
 */
const RAILS_BIN = "load Gem.activate_bin_path('railties', 'rails', ARGV.shift)";

/**
 * The extensions most projects start from, picked under "Extensions" — ids as code.quarkus.io
 * takes them, present in every current stream (checked against 3.27, 3.33 and 3.40, 2026-10-01). With
 * none ticked the service adds REST and a `/hello` resource on its own, so REST is ticked by default
 * and the starter code is the same either way. There is no SQLite driver in the platform.
 */
const QUARKUS_EXTENSIONS: {
  id: string;
  label: string;
  extension: string;
  section: TranslationKey;
  default?: boolean;
  popular?: boolean;
}[] = [
  { id: "qRest", label: "REST", extension: "io.quarkus:quarkus-rest", section: "scaffold.depGroup.web", default: true },
  { id: "qRestJackson", label: "REST Jackson", extension: "io.quarkus:quarkus-rest-jackson", section: "scaffold.depGroup.web", popular: true },
  { id: "qRestClient", label: "REST Client", extension: "io.quarkus:quarkus-rest-client-jackson", section: "scaffold.depGroup.web" },
  { id: "qPanache", label: "Hibernate ORM with Panache", extension: "io.quarkus:quarkus-hibernate-orm-panache", section: "scaffold.depGroup.data", popular: true },
  { id: "qPostgres", label: "JDBC PostgreSQL", extension: "io.quarkus:quarkus-jdbc-postgresql", section: "scaffold.depGroup.data", popular: true },
  { id: "qMysql", label: "JDBC MySQL", extension: "io.quarkus:quarkus-jdbc-mysql", section: "scaffold.depGroup.data" },
  { id: "qFlyway", label: "Flyway", extension: "io.quarkus:quarkus-flyway", section: "scaffold.depGroup.data" },
  { id: "qValidator", label: "Hibernate Validator", extension: "io.quarkus:quarkus-hibernate-validator", section: "scaffold.depGroup.core", popular: true },
  { id: "qOpenapi", label: "SmallRye OpenAPI", extension: "io.quarkus:quarkus-smallrye-openapi", section: "scaffold.depGroup.web", popular: true },
  { id: "qHealth", label: "SmallRye Health", extension: "io.quarkus:quarkus-smallrye-health", section: "scaffold.depGroup.ops", popular: true },
  { id: "qScheduler", label: "Scheduler", extension: "io.quarkus:quarkus-scheduler", section: "scaffold.depGroup.core" },
  { id: "qOidc", label: "OIDC", extension: "io.quarkus:quarkus-oidc", section: "scaffold.depGroup.security" },
];

/** Hono's starters `create-hono` can make without a question, and what each one runs with. Vercel's
 *  has no scripts of its own — it needs Vercel's CLI — so it is left out. */
const HONO_RUNTIME: ChoiceOption = {
  id: "runtime",
  kind: "choice",
  labelKey: "scaffold.opt.runtime",
  choices: [
    { value: "nodejs", label: "Node.js" },
    { value: "bun", label: "Bun" },
    { value: "cloudflare-workers", label: "Cloudflare Workers" },
  ],
  default: "nodejs",
};

// ── The catalogue ───────────────────────────────────────────────────────────────────────────────

export const TEMPLATES: Template[] = [
  {
    id: "empty",
    name: "Empty",
    nameKey: "scaffold.tpl.emptyName",
    category: "general",
    logo: "empty",
    descriptionKey: "scaffold.tpl.empty",
    defaultName: "new-project",
    options: [],
    // Git is every plan's, and the dialog asks for it on every template already.
    requirements: () => [],
    // The folder and the runner's `git init`, nothing else: no file of ours in it, not even a README.
    plan: () => ({ files: [], steps: [], emptyCommit: true }),
  },
  {
    id: "react",
    name: "React",
    category: "frontend",
    logo: "react",
    descriptionKey: "scaffold.tpl.react",
    versions: { kind: "npm", package: "create-vite" },
    defaultName: "react-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      LANGUAGE,
      { id: "compiler", kind: "toggle", label: "React Compiler", default: false, when: () => true },
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "Vite"), ...pmRequirements(ctx)],
    plan: (ctx) => {
      const template = `react${ctx.opts.compiler && major(ctx) >= 9 ? "-compiler" : ""}${ts(ctx) ? "-ts" : ""}`;
      return {
        steps: [
          inParent(ctx, "scaffold.step.generate", dlx(ctx.pm, `create-vite@${at(ctx)}`, [ctx.name, "--template", template, "--no-interactive", "--no-immediate"])),
          inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm)),
        ],
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "vue",
    name: "Vue",
    category: "frontend",
    logo: "vue",
    descriptionKey: "scaffold.tpl.vue",
    versions: { kind: "npm", package: "create-vue" },
    defaultName: "vue-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      LANGUAGE,
      { id: "router", kind: "toggle", label: "Vue Router", default: true },
      { id: "pinia", kind: "toggle", label: "Pinia", default: true },
      { id: "vitest", kind: "toggle", label: "Vitest", default: false },
      { id: "eslint", kind: "toggle", label: "ESLint", default: true },
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "create-vue"), ...pmRequirements(ctx)],
    plan: (ctx) => {
      const flags = [
        ts(ctx) && "--ts",
        ctx.opts.router && "--router",
        ctx.opts.pinia && "--pinia",
        ctx.opts.vitest && "--vitest",
        ctx.opts.eslint && "--eslint",
      ].filter((flag): flag is string => typeof flag === "string");
      return {
        steps: [
          inParent(ctx, "scaffold.step.generate", dlx(ctx.pm, `create-vue@${at(ctx)}`, [ctx.name, ...(flags.length ? flags : ["--default"])])),
          inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm)),
        ],
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "angular",
    name: "Angular",
    category: "frontend",
    logo: "angular",
    descriptionKey: "scaffold.tpl.angular",
    versions: { kind: "npm", package: "@angular/cli" },
    versionFilter: (line) => Number(line.line) >= 17,
    defaultName: "angular-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      {
        id: "style",
        kind: "choice",
        labelKey: "scaffold.opt.style",
        choices: [
          { value: "scss", label: "SCSS" },
          { value: "css", label: "CSS" },
          { value: "sass", label: "Sass" },
          { value: "less", label: "Less" },
        ],
        default: "scss",
      },
      { id: "routing", kind: "toggle", labelKey: "scaffold.opt.routing", default: true },
      { id: "ssr", kind: "toggle", labelKey: "scaffold.opt.ssr", default: false },
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "Angular"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
      steps: [
        inParent(
          ctx,
          "scaffold.step.generate",
          dlx(ctx.pm, `@angular/cli@${at(ctx)}`, [
            "new",
            ctx.name,
            "--defaults",
            "--interactive=false",
            "--skip-git",
            `--package-manager=${ctx.pm}`,
            `--style=${String(ctx.opts.style || "scss")}`,
            `--routing=${ctx.opts.routing ? "true" : "false"}`,
            `--ssr=${ctx.opts.ssr ? "true" : "false"}`,
          ]),
          // The CLI's first run asks about analytics whatever the flags say; answering "no" here is
          // the private choice, and it is this process's environment only — nothing is saved.
          { NG_CLI_ANALYTICS: "false" },
        ),
      ],
      run: runCmd(ctx.pm, "start"),
    }),
  },
  {
    id: "next",
    name: "Next.js",
    category: "frontend",
    logo: "next",
    descriptionKey: "scaffold.tpl.next",
    versions: { kind: "npm", package: "create-next-app" },
    // `--yes`, `--disable-git` and the `--no-*` forms are what keep it quiet, and older lines
    // predate some of them.
    versionFilter: (line) => Number(line.line) >= 15,
    defaultName: "next-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      LANGUAGE,
      { id: "tailwind", kind: "toggle", label: "Tailwind CSS", default: true },
      { id: "eslint", kind: "toggle", label: "ESLint", default: true },
      { id: "app", kind: "toggle", label: "App Router", default: true },
      { id: "src", kind: "toggle", labelKey: "scaffold.opt.srcDir", default: false },
      AGENTS,
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "Next.js"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
      steps: [
        inParent(
          ctx,
          "scaffold.step.generate",
          dlx(ctx.pm, `create-next-app@${at(ctx)}`, [
            ctx.name,
            ts(ctx) ? "--ts" : "--js",
            ctx.opts.tailwind ? "--tailwind" : "--no-tailwind",
            ctx.opts.eslint ? "--eslint" : "--no-eslint",
            ctx.opts.app ? "--app" : "--no-app",
            ctx.opts.src ? "--src-dir" : "--no-src-dir",
            "--import-alias",
            "@/*",
            `--use-${ctx.pm}`,
            "--disable-git",
            ...(major(ctx) >= 16 ? [ctx.opts.agents ? "--agents-md" : "--no-agents-md"] : []),
            "--yes",
          ]),
        ),
      ],
      run: runCmd(ctx.pm, "dev"),
    }),
  },
  {
    id: "nuxt",
    name: "Nuxt",
    category: "frontend",
    logo: "nuxt",
    descriptionKey: "scaffold.tpl.nuxt",
    engines: { kind: "npm", package: "nuxt" },
    defaultName: "nuxt-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      {
        id: "template",
        kind: "choice",
        labelKey: "scaffold.opt.template",
        choices: [
          { value: "minimal", label: "Minimal" },
          { value: "ui", label: "Nuxt UI" },
          { value: "content", label: "Content" },
        ],
        default: "minimal",
      },
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "Nuxt"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
      steps: [
        inParent(
          ctx,
          "scaffold.step.generate",
          dlx(ctx.pm, "create-nuxt@latest", [
            ctx.name,
            `--template=${String(ctx.opts.template || "minimal")}`,
            `--packageManager=${ctx.pm}`,
            "--no-gitInit",
            "--no-install",
            // Empty rather than absent: absent, it stops to ask whether to browse modules.
            "--modules=",
          ]),
        ),
        // The install's `postinstall` runs `nuxt prepare`, which asks about telemetry in a TTY and
        // waits there; declined up front, for this process only, like Angular's analytics.
        inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm), { NUXT_TELEMETRY_DISABLED: "1" }),
      ],
      run: runCmd(ctx.pm, "dev"),
    }),
  },
  {
    id: "svelte",
    name: "SvelteKit",
    category: "frontend",
    logo: "svelte",
    descriptionKey: "scaffold.tpl.svelte",
    engines: { kind: "npm", package: "vite" },
    defaultName: "svelte-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      {
        id: "template",
        kind: "choice",
        labelKey: "scaffold.opt.template",
        choices: [
          { value: "minimal", label: "Minimal" },
          { value: "demo", label: "Demo" },
          { value: "library", labelKey: "scaffold.opt.library" },
        ],
        default: "minimal",
      },
      {
        id: "types",
        kind: "choice",
        labelKey: "scaffold.opt.types",
        choices: [
          { value: "ts", label: "TypeScript" },
          { value: "jsdoc", label: "JSDoc" },
          { value: "none", labelKey: "scaffold.opt.none" },
        ],
        default: "ts",
      },
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "SvelteKit"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
      steps: [
        inParent(
          ctx,
          "scaffold.step.generate",
          dlx(ctx.pm, "sv@latest", [
            "create",
            ctx.name,
            "--template",
            String(ctx.opts.template || "minimal"),
            ...(ctx.opts.types === "none" ? ["--no-types"] : ["--types", String(ctx.opts.types || "ts")]),
            "--no-add-ons",
            "--install",
            ctx.pm,
          ]),
        ),
      ],
      run: runCmd(ctx.pm, "dev"),
    }),
  },
  {
    id: "astro",
    name: "Astro",
    category: "frontend",
    logo: "astro",
    descriptionKey: "scaffold.tpl.astro",
    engines: { kind: "npm", package: "astro" },
    defaultName: "astro-site",
    npmName: true,
    pms: ALL_PMS,
    options: [
      {
        id: "template",
        kind: "choice",
        labelKey: "scaffold.opt.template",
        choices: [
          { value: "minimal", label: "Minimal" },
          { value: "basics", label: "Basics" },
          { value: "blog", label: "Blog" },
          { value: "portfolio", label: "Portfolio" },
        ],
        default: "minimal",
      },
      AGENTS,
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "Astro"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
      steps: [
        inParent(
          ctx,
          "scaffold.step.generate",
          dlx(ctx.pm, "create-astro@latest", [
            ctx.name,
            "--template",
            String(ctx.opts.template || "minimal"),
            "--no-install",
            "--no-git",
            "--skip-houston",
            ...(ctx.opts.agents ? [] : ["--no-ai"]),
            "--yes",
          ]),
        ),
        inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm)),
      ],
      run: runCmd(ctx.pm, "dev"),
    }),
  },
  {
    id: "solid",
    name: "Solid",
    category: "frontend",
    logo: "solid",
    descriptionKey: "scaffold.tpl.solid",
    // No picker: the starters come from Solid's templates repository whatever `create-solid` it is,
    // so the generator is always `@latest`. What it needs underneath is Vite's for a plain app and
    // SolidStart's own — a newer Node — for SolidStart.
    engines: (opts) => ({ kind: "npm", package: opts.kind === "solidstart" ? "@solidjs/start" : "vite" }),
    defaultName: "solid-app",
    npmName: true,
    pms: ALL_PMS,
    options: [SOLID_KIND, SOLID_VITE_TEMPLATE, SOLID_START_TEMPLATE, LANGUAGE],
    requirements: (ctx) => [nodeRequirement(ctx, ctx.opts.kind === "solidstart" ? "SolidStart" : "Solid"), ...pmRequirements(ctx)],
    plan: (ctx) => {
      const start = ctx.opts.kind === "solidstart";
      const starter = String((start ? ctx.opts.startTemplate : ctx.opts.viteTemplate) || "basic");
      return {
        steps: [
          // Asks nothing with the kind, the template and the language given; installs nothing and
          // starts no repository. `--v2` is SolidStart 2's only flag — without it, it asks.
          inParent(
            ctx,
            "scaffold.step.generate",
            dlx(ctx.pm, "create-solid@latest", [
              ctx.name,
              ...(start ? ["--solidstart", "--v2"] : ["--vanilla"]),
              "-t",
              starter,
              ts(ctx) ? "--ts" : "--js",
            ]),
          ),
          // Every starter ships the `pnpm-lock.yaml` it was made with, whatever manager is picked:
          // pnpm would install its older pins and bun would convert it, keeping both lockfiles.
          {
            title: ctx.label("scaffold.step.lockfile"),
            cwd: ctx.root,
            sh: "rm -f pnpm-lock.yaml",
            ps: "Remove-Item -LiteralPath 'pnpm-lock.yaml' -Force -ErrorAction SilentlyContinue",
          },
          namePackage(ctx),
          inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm)),
        ],
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "qwik",
    name: "Qwik",
    category: "frontend",
    logo: "qwik",
    descriptionKey: "scaffold.tpl.qwik",
    // `create-qwik` is versioned with Qwik itself, so its lines are Qwik's.
    versions: { kind: "npm", package: "create-qwik" },
    versionFilter: (line) => Number(line.line) >= 1,
    // `create-qwik` says `^18.17.0`, but the project it makes runs on Vite, which needs more.
    engines: { kind: "npm", package: "vite" },
    defaultName: "qwik-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      {
        id: "starter",
        kind: "choice",
        labelKey: "scaffold.opt.template",
        choices: [
          { value: "empty", labelKey: "scaffold.opt.blank" },
          { value: "playground", label: "Playground" },
          { value: "library", labelKey: "scaffold.opt.library" },
        ],
        default: "empty",
      },
    ],
    requirements: (ctx) => [
      {
        tool: "node",
        range: ctx.engines?.requires ?? ctx.version?.requires ?? null,
        because: ctx.version ? `Qwik ${ctx.version.version}` : "Qwik",
      },
      ...pmRequirements(ctx),
    ],
    plan: (ctx) => ({
      steps: [
        // Starter first, folder second. Given any argument it runs as a command: no question, no
        // install (`--installDeps` is off by default), no repository.
        inParent(ctx, "scaffold.step.generate", dlx(ctx.pm, `create-qwik@${at(ctx)}`, [String(ctx.opts.starter || "empty"), ctx.name])),
        namePackage(ctx),
        inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm)),
      ],
      run: runCmd(ctx.pm, "dev"),
    }),
  },
  {
    id: "vite",
    name: "Vite",
    category: "frontend",
    logo: "vite",
    descriptionKey: "scaffold.tpl.vite",
    versions: { kind: "npm", package: "create-vite" },
    defaultName: "vite-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      {
        id: "framework",
        kind: "choice",
        labelKey: "scaffold.opt.framework",
        choices: [
          { value: "vanilla", label: "Vanilla" },
          { value: "vue", label: "Vue" },
          { value: "react", label: "React" },
          { value: "preact", label: "Preact" },
          { value: "lit", label: "Lit" },
          { value: "svelte", label: "Svelte" },
          { value: "solid", label: "Solid" },
          { value: "qwik", label: "Qwik" },
        ],
        default: "vanilla",
      },
      LANGUAGE,
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "Vite"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
      steps: [
        inParent(
          ctx,
          "scaffold.step.generate",
          dlx(ctx.pm, `create-vite@${at(ctx)}`, [
            ctx.name,
            "--template",
            `${String(ctx.opts.framework || "vanilla")}${ts(ctx) ? "-ts" : ""}`,
            "--no-interactive",
            "--no-immediate",
          ]),
        ),
        inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm)),
      ],
      run: runCmd(ctx.pm, "dev"),
    }),
  },
  {
    id: "expo",
    name: "Expo",
    category: "mobile",
    logo: "expo",
    descriptionKey: "scaffold.tpl.expo",
    // `create-expo-app` is a shim over `create-expo` now (5.x), and its own `>=20` is not what runs.
    engines: { kind: "npm", package: "create-expo" },
    defaultName: "mobile-app",
    npmName: true,
    pms: ALL_PMS,
    options: [
      {
        id: "template",
        kind: "choice",
        labelKey: "scaffold.opt.template",
        choices: [
          { value: "default", labelKey: "scaffold.opt.expoDefault" },
          { value: "blank-typescript", labelKey: "scaffold.opt.expoBlankTs" },
          { value: "blank", labelKey: "scaffold.opt.expoBlank" },
          { value: "tabs", labelKey: "scaffold.opt.expoTabs" },
        ],
        default: "default",
      },
      AGENTS,
    ],
    requirements: (ctx) => [nodeRequirement(ctx, "Expo"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
      steps: [
        inParent(
          ctx,
          "scaffold.step.generate",
          dlx(ctx.pm, "create-expo-app@latest", [
            ctx.name,
            "--template",
            String(ctx.opts.template || "default"),
            "--no-install",
            ...(ctx.opts.agents ? [] : ["--no-agents-md"]),
            "--yes",
          ]),
        ),
        inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm)),
      ],
      run: runCmd(ctx.pm, "start"),
    }),
  },
  {
    id: "angularNative",
    name: "Angular Native",
    category: "mobile",
    logo: "angularNative",
    descriptionKey: "scaffold.tpl.angularNative",
    // An Expo template (ng-native.com): Expo's generator and its requirement, Angular's components.
    engines: { kind: "npm", package: "create-expo" },
    defaultName: "native-app",
    npmName: true,
    pms: ALL_PMS,
    options: [],
    requirements: (ctx) => [nodeRequirement(ctx, "Angular Native"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
      steps: [
        // Expo's flags, Expo's behaviour: it asks nothing and makes its own first commit, which the
        // runner's commits after. The template brings its own AGENTS.md; `--no-agents-md` keeps
        // create-expo from adding a `.claude/` settings file on top of it.
        inParent(
          ctx,
          "scaffold.step.generate",
          dlx(ctx.pm, "create-expo-app@latest", [ctx.name, "--template", "@ng-native/template", "--no-install", "--no-agents-md", "--yes"]),
        ),
        // pnpm needs no hoisted linker for it: iOS and Android bundles build on pnpm's own layout.
        inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm)),
      ],
      run: runCmd(ctx.pm, "start"),
    }),
  },
  {
    id: "node",
    name: "Node.js",
    category: "backend",
    logo: "node",
    descriptionKey: "scaffold.tpl.node",
    // What the TypeScript variant runs on — its `engines.node` is the requirement, read live.
    engines: { kind: "npm", package: "tsx" },
    defaultName: "node-app",
    npmName: true,
    pms: ALL_PMS,
    options: [LANGUAGE],
    requirements: (ctx) => [ts(ctx) ? nodeRequirement(ctx, "tsx") : { tool: "node" }, ...pmRequirements(ctx)],
    plan: (ctx) => {
      const typed = ts(ctx);
      const pkg = {
        name: ctx.name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: typed
          ? { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" }
          : { dev: "node --watch src/index.js", start: "node src/index.js" },
      };
      const files: FileSpec[] = [
        { path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n` },
        { path: ".gitignore", content: NODE_GITIGNORE },
        {
          path: typed ? "src/index.ts" : "src/index.js",
          content: `const name = ${JSON.stringify(ctx.name)};\n\nconsole.log(\`Hello from \${name}!\`);\n`,
        },
      ];
      if (typed) files.push({ path: "tsconfig.json", content: TSCONFIG_NODE });
      return {
        files,
        steps: typed
          ? [inRoot(ctx, "scaffold.step.deps", addCmd(ctx.pm, ["typescript", "tsx", "@types/node"], true))]
          : [inRoot(ctx, "scaffold.step.install", installCmd(ctx.pm))],
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "bun",
    name: "Bun",
    category: "backend",
    logo: "bun",
    descriptionKey: "scaffold.tpl.bun",
    defaultName: "bun-app",
    npmName: true,
    options: [
      {
        id: "template",
        kind: "choice",
        labelKey: "scaffold.opt.template",
        choices: [
          { value: "blank", labelKey: "scaffold.opt.blank" },
          { value: "react", label: "React" },
          { value: "tailwind", label: "React + Tailwind" },
          { value: "shadcn", label: "React + shadcn/ui" },
        ],
        default: "blank",
      },
      // Named for what it writes on a machine with the Claude CLI; the same switch also stops the
      // Cursor rule it writes when Cursor is installed.
      { id: "agents", kind: "toggle", label: "CLAUDE.md", default: true },
    ],
    requirements: (ctx) => [{ tool: "bun", range: BUN_INIT_FLOOR, because: `bun init ${bunInitFlag(ctx.opts.template)}` }],
    plan: (ctx) => ({
      steps: [
        // Makes the folder, writes the project and runs `bun install` itself; it starts no repository.
        inParent(
          ctx,
          "scaffold.step.generate",
          ["bun", "init", bunInitFlag(ctx.opts.template), ctx.name],
          ctx.opts.agents ? undefined : { BUN_AGENT_RULE_DISABLED: "1" },
        ),
      ],
      // What `bun init` itself says to run: the blank project has no scripts, the React ones a `dev`.
      run: bunInitFlag(ctx.opts.template) === "--yes" ? "bun run index.ts" : "bun dev",
    }),
  },
  {
    id: "express",
    name: "Express",
    category: "backend",
    logo: "express",
    descriptionKey: "scaffold.tpl.express",
    versions: { kind: "npm", package: "express" },
    defaultName: "express-api",
    npmName: true,
    pms: ALL_PMS,
    options: [LANGUAGE],
    requirements: (ctx) => [nodeRequirement(ctx, "Express"), ...pmRequirements(ctx)],
    plan: (ctx) => {
      const typed = ts(ctx);
      const pkg = {
        name: ctx.name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: typed
          ? { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" }
          : { dev: "node --watch src/index.js", start: "node src/index.js" },
      };
      const server = [
        `import express${typed ? ", { type Request, type Response }" : ""} from "express";`,
        "",
        "const app = express();",
        "const port = Number(process.env.PORT ?? 3000);",
        "",
        "app.use(express.json());",
        "",
        `app.get("/", (_req${typed ? ": Request" : ""}, res${typed ? ": Response" : ""}) => {`,
        `  res.json({ message: ${JSON.stringify(`Hello from ${ctx.name}!`)} });`,
        "});",
        "",
        "app.listen(port, () => {",
        "  console.log(`Listening on http://localhost:${port}`);",
        "});",
        "",
      ].join("\n");
      const files: FileSpec[] = [
        { path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n` },
        { path: ".gitignore", content: NODE_GITIGNORE },
        { path: typed ? "src/index.ts" : "src/index.js", content: server },
      ];
      if (typed) files.push({ path: "tsconfig.json", content: TSCONFIG_NODE });
      const express = ctx.version ? `express@^${ctx.version.version}` : "express";
      return {
        files,
        steps: [
          inRoot(ctx, "scaffold.step.deps", addCmd(ctx.pm, [express])),
          ...(typed ? [inRoot(ctx, "scaffold.step.devDeps", addCmd(ctx.pm, ["typescript", "tsx", "@types/node", "@types/express"], true))] : []),
        ],
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "fastify",
    name: "Fastify",
    category: "backend",
    logo: "fastify",
    descriptionKey: "scaffold.tpl.fastify",
    versions: { kind: "npm", package: "fastify" },
    defaultName: "fastify-api",
    npmName: true,
    pms: ALL_PMS,
    options: [LANGUAGE],
    requirements: (ctx) => [nodeRequirement(ctx, "Fastify"), ...pmRequirements(ctx)],
    // Express's, on Fastify: one file and the package, no generator. Fastify ships its own types.
    plan: (ctx) => {
      const typed = ts(ctx);
      const pkg = {
        name: ctx.name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: typed
          ? { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" }
          : { dev: "node --watch src/index.js", start: "node src/index.js" },
      };
      const server = [
        'import Fastify from "fastify";',
        "",
        "const app = Fastify({ logger: true });",
        "const port = Number(process.env.PORT ?? 3000);",
        "",
        `app.get("/", async () => ({ message: ${JSON.stringify(`Hello from ${ctx.name}!`)} }));`,
        "",
        "try {",
        "  await app.listen({ port });",
        "} catch (error) {",
        "  app.log.error(error);",
        "  process.exit(1);",
        "}",
        "",
      ].join("\n");
      const files: FileSpec[] = [
        { path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n` },
        { path: ".gitignore", content: NODE_GITIGNORE },
        { path: typed ? "src/index.ts" : "src/index.js", content: server },
      ];
      if (typed) files.push({ path: "tsconfig.json", content: TSCONFIG_NODE });
      const fastify = ctx.version ? `fastify@^${ctx.version.version}` : "fastify";
      return {
        files,
        steps: [
          inRoot(ctx, "scaffold.step.deps", addCmd(ctx.pm, [fastify])),
          ...(typed ? [inRoot(ctx, "scaffold.step.devDeps", addCmd(ctx.pm, ["typescript", "tsx", "@types/node"], true))] : []),
        ],
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "koa",
    name: "Koa",
    category: "backend",
    logo: "koa",
    descriptionKey: "scaffold.tpl.koa",
    versions: { kind: "npm", package: "koa" },
    defaultName: "koa-api",
    npmName: true,
    pms: ALL_PMS,
    options: [LANGUAGE],
    requirements: (ctx) => [nodeRequirement(ctx, "Koa"), ...pmRequirements(ctx)],
    // Express's shape on Koa: one server file and the packages, no generator — Koa has none. Routing
    // is `@koa/router`, which Koa leaves out of its core; the router ships its own types, Koa does
    // not (`@types/koa`). Run in JS and TS and answered on `/`, 2026-10-01.
    plan: (ctx) => {
      const typed = ts(ctx);
      const pkg = {
        name: ctx.name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: typed
          ? { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" }
          : { dev: "node --watch src/index.js", start: "node src/index.js" },
      };
      const server = [
        'import Koa from "koa";',
        'import Router from "@koa/router";',
        "",
        "const app = new Koa();",
        "const router = new Router();",
        "const port = Number(process.env.PORT ?? 3000);",
        "",
        'router.get("/", (ctx) => {',
        `  ctx.body = { message: ${JSON.stringify(`Hello from ${ctx.name}!`)} };`,
        "});",
        "",
        "app.use(router.routes()).use(router.allowedMethods());",
        "",
        "app.listen(port, () => {",
        "  console.log(`Listening on http://localhost:${port}`);",
        "});",
        "",
      ].join("\n");
      const files: FileSpec[] = [
        { path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n` },
        { path: ".gitignore", content: NODE_GITIGNORE },
        { path: typed ? "src/index.ts" : "src/index.js", content: server },
      ];
      if (typed) files.push({ path: "tsconfig.json", content: TSCONFIG_NODE });
      const koa = ctx.version ? `koa@^${ctx.version.version}` : "koa";
      return {
        files,
        steps: [
          inRoot(ctx, "scaffold.step.deps", addCmd(ctx.pm, [koa, "@koa/router"])),
          ...(typed ? [inRoot(ctx, "scaffold.step.devDeps", addCmd(ctx.pm, ["typescript", "tsx", "@types/node", "@types/koa"], true))] : []),
        ],
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "hapi",
    name: "hapi",
    category: "backend",
    logo: "hapi",
    descriptionKey: "scaffold.tpl.hapi",
    versions: { kind: "npm", package: "@hapi/hapi" },
    defaultName: "hapi-api",
    npmName: true,
    pms: ALL_PMS,
    options: [LANGUAGE],
    requirements: (ctx) => [nodeRequirement(ctx, "hapi"), ...pmRequirements(ctx)],
    // The same again on hapi, which has no generator either and ships its own types. Its routes are
    // configuration rather than calls, and starting is awaited — at the top level, as an ES module.
    plan: (ctx) => {
      const typed = ts(ctx);
      const pkg = {
        name: ctx.name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: typed
          ? { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" }
          : { dev: "node --watch src/index.js", start: "node src/index.js" },
      };
      const server = [
        'import Hapi from "@hapi/hapi";',
        "",
        'const server = Hapi.server({ port: Number(process.env.PORT ?? 3000), host: "localhost" });',
        "",
        "server.route({",
        '  method: "GET",',
        '  path: "/",',
        `  handler: () => ({ message: ${JSON.stringify(`Hello from ${ctx.name}!`)} }),`,
        "});",
        "",
        "await server.start();",
        "console.log(`Listening on ${server.info.uri}`);",
        "",
      ].join("\n");
      const files: FileSpec[] = [
        { path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n` },
        { path: ".gitignore", content: NODE_GITIGNORE },
        { path: typed ? "src/index.ts" : "src/index.js", content: server },
      ];
      if (typed) files.push({ path: "tsconfig.json", content: TSCONFIG_NODE });
      const hapi = ctx.version ? `@hapi/hapi@^${ctx.version.version}` : "@hapi/hapi";
      return {
        files,
        steps: [
          inRoot(ctx, "scaffold.step.deps", addCmd(ctx.pm, [hapi])),
          ...(typed ? [inRoot(ctx, "scaffold.step.devDeps", addCmd(ctx.pm, ["typescript", "tsx", "@types/node"], true))] : []),
        ],
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "hono",
    name: "Hono",
    category: "backend",
    logo: "hono",
    descriptionKey: "scaffold.tpl.hono",
    engines: { kind: "npm", package: "hono" },
    defaultName: "hono-app",
    npmName: true,
    pms: ALL_PMS,
    options: [HONO_RUNTIME],
    requirements: (ctx) =>
      ctx.opts.runtime === "bun" ? [{ tool: "bun" }] : [nodeRequirement(ctx, "Hono"), ...pmRequirements(ctx)],
    plan: (ctx) => {
      // Bun's starter is Bun's: it installs and runs with it, whatever manager is picked.
      const pm = ctx.opts.runtime === "bun" ? "bun" : ctx.pm;
      return {
        steps: [
          // `create-hono` makes the folder, installs and starts no repository. Template, manager and
          // install are all flags, so it asks nothing (run in a pty, 2026-10-01).
          inParent(
            ctx,
            "scaffold.step.generate",
            dlx(pm, "create-hono@latest", [ctx.name, "--template", String(ctx.opts.runtime ?? "nodejs"), "--pm", pm, "--install"]),
          ),
        ],
        run: runCmd(pm, "dev"),
      };
    },
  },
  {
    id: "nest",
    name: "NestJS",
    category: "backend",
    logo: "nest",
    descriptionKey: "scaffold.tpl.nest",
    versions: { kind: "npm", package: "@nestjs/cli" },
    versionFilter: (line) => Number(line.line) >= 10,
    defaultName: "nest-api",
    npmName: true,
    pms: ["npm", "pnpm", "yarn"],
    options: [LANGUAGE, NEST_PLATFORM, ...NEST_DEPENDENCY_OPTIONS],
    requirements: (ctx) => [nodeRequirement(ctx, "NestJS"), ...pmRequirements(ctx)],
    plan: (ctx) => {
      const fastify = ctx.opts.platform === "fastify";
      // Released with `@nestjs/core`, so pinned to the major `nest new` wrote — the CLI's own.
      const core = (name: string) => (Number.isFinite(major(ctx)) ? `${name}@^${major(ctx)}` : name);
      // Ticked and still on offer: a pick the form hides (a version or platform switched after it)
      // is not installed either.
      const picked = NEST_DEPENDENCIES.filter(
        (dependency) =>
          ctx.opts[dependency.id] === true && nestFits(dependency, major(ctx)) && (!dependency.when || dependency.when(ctx.opts)),
      );
      // On Nest 12 `nest new` installs and wires Observe itself; the flag stands in for the package.
      const cliObserve = major(ctx) >= 12;
      const observe = picked.some((dependency) => dependency.id === "nestObserve");
      // Once each: two picks can share one (Webhooks and Outbox; Apollo and Mercurius on GraphQL).
      const packages = [
        ...new Set([
          ...(fastify ? [core("@nestjs/platform-fastify")] : []),
          ...picked
            .filter((dependency) => !(cliObserve && dependency.id === "nestObserve"))
            .flatMap((dependency) => dependency.packages(fastify).map((name) => (dependency.core ? core(name) : name))),
        ]),
      ];
      const types = ts(ctx) ? picked.flatMap((dependency) => dependency.types?.(fastify) ?? []) : [];
      return {
        steps: [
          inParent(
            ctx,
            "scaffold.step.generate",
            dlx(ctx.pm, `@nestjs/cli@${at(ctx)}`, [
              "new",
              ctx.name,
              "--skip-git",
              "--package-manager",
              ctx.pm,
              "--language",
              ts(ctx) ? "TypeScript" : "JavaScript",
              ...(cliObserve ? [observe ? "--observe" : "--no-observe"] : []),
            ]),
            // The schematic behind `nest new` asks ESM-or-CommonJS and has no flag for it; told there
            // is no TTY, the schematics runner takes the default (ESM) instead of asking.
            { NG_FORCE_TTY: "false" },
          ),
          ...(packages.length > 0 ? [inRoot(ctx, "scaffold.step.deps", addCmd(ctx.pm, packages))] : []),
          ...(types.length > 0 ? [inRoot(ctx, "scaffold.step.devDeps", addCmd(ctx.pm, types, true))] : []),
          ...(fastify ? [inRoot(ctx, "scaffold.step.fastify", ["node", "-e", NEST_FASTIFY_PATCH])] : []),
        ],
        run: runCmd(ctx.pm, "start:dev"),
      };
    },
  },
  {
    id: "adonis",
    name: "AdonisJS",
    category: "backend",
    logo: "adonis",
    descriptionKey: "scaffold.tpl.adonis",
    // No picker: the kits come from AdonisJS's repositories, and the generator's previous major takes
    // other flags (`--db`, `--auth-guard`) — always the current one.
    engines: { kind: "npm", package: "create-adonisjs" },
    defaultName: "adonis-app",
    npmName: true,
    pms: ALL_PMS,
    options: [ADONIS_KIT],
    requirements: (ctx) => [nodeRequirement(ctx, "AdonisJS"), ...pmRequirements(ctx)],
    plan: (ctx) => {
      const kit = String(ctx.opts.kit || "hypermedia");
      return {
        steps: [
          // Asks nothing with a folder and a kit. Installs with the manager it is told (`--pkg`: run
          // through npx it would take npm), writes `.env`, generates the app key and migrates its
          // SQLite database; starts no repository. `--verbose`, or a failure is one line under a spinner.
          inParent(
            ctx,
            "scaffold.step.generate",
            dlx(ctx.pm, "create-adonisjs@latest", [ctx.name, `--kit=${kit}`, `--pkg=${ctx.pm}`, "--verbose"]),
          ),
          adonisCheck(ctx, kit),
        ],
        // `node ace serve --hmr`, or turbo in the monorepo; on :3333.
        run: runCmd(ctx.pm, "dev"),
      };
    },
  },
  {
    id: "spring",
    name: "Spring Boot",
    category: "backend",
    logo: "spring",
    descriptionKey: "scaffold.tpl.spring",
    defaultName: "demo",
    spring: true,
    options: [],
    requirements: (ctx) => [
      {
        tool: "java",
        // Until start.spring.io has answered there is no Java to ask for — its own metadata says which
        // one each Boot line takes — so only presence is checked.
        range: ctx.spring ? `>=${ctx.spring.javaVersion}` : null,
        because: ctx.spring ? `Spring Boot ${ctx.spring.bootVersion} · Java ${ctx.spring.javaVersion}` : "Spring Boot",
      },
    ],
    plan: (ctx) => {
      const gradle = ctx.spring?.type.startsWith("gradle");
      const windows = ctx.platform === "windows";
      return {
        spring: ctx.spring,
        steps: [],
        run: gradle ? `${windows ? "gradlew.bat" : "./gradlew"} bootRun` : `${windows ? "mvnw.cmd" : "./mvnw"} spring-boot:run`,
      };
    },
  },
  {
    id: "quarkus",
    name: "Quarkus",
    category: "backend",
    logo: "quarkus",
    descriptionKey: "scaffold.tpl.quarkus",
    versions: { kind: "quarkus" },
    defaultName: "quarkus-app",
    options: [
      {
        id: "buildTool",
        kind: "choice",
        labelKey: "scaffold.spring.build",
        choices: [
          { value: "MAVEN", label: "Maven" },
          { value: "GRADLE", label: "Gradle" },
          { value: "GRADLE_KOTLIN_DSL", label: "Gradle (Kotlin DSL)" },
        ],
        default: "MAVEN",
      },
      {
        id: "groupId",
        kind: "text",
        labelKey: "scaffold.spring.group",
        default: () => "org.acme",
        validate: (value) => (VALID_JAVA_PACKAGE.test(value) ? null : "scaffold.err.javaPackage"),
      },
      ...QUARKUS_EXTENSIONS.map(
        (extension): ToggleOption => ({
          id: extension.id,
          kind: "toggle",
          label: extension.label,
          default: extension.default === true,
          group: "scaffold.opt.extensions",
          section: extension.section,
          popular: extension.popular,
        }),
      ),
    ],
    // The JDK is all it needs: the zip carries the Maven or Gradle wrapper. Which Java the project is
    // built for is the backend's to decide, against the JDK found (see `scaffold/quarkus.rs`).
    requirements: (ctx) => [
      { tool: "java", range: ctx.version?.requires ?? null, because: ctx.version ? `Quarkus ${ctx.version.version}` : "Quarkus" },
    ],
    plan: (ctx) => {
      const buildTool = String(ctx.opts.buildTool || "MAVEN") as QuarkusRequest["buildTool"];
      const windows = ctx.platform === "windows";
      return {
        quarkus: {
          stream: ctx.version?.line ?? "",
          groupId: String(ctx.opts.groupId || "org.acme"),
          buildTool,
          extensions: QUARKUS_EXTENSIONS.filter((extension) => ctx.opts[extension.id] === true).map((extension) => extension.extension),
        },
        steps: [],
        // Dev mode, with live reload. Its first start asks about anonymous build data and moves on by
        // itself after ten seconds when nobody answers.
        run:
          buildTool === "MAVEN"
            ? `${windows ? "mvnw.cmd" : "./mvnw"} quarkus:dev`
            : `${windows ? "gradlew.bat" : "./gradlew"} --console=plain quarkusDev`,
      };
    },
  },
  {
    id: "go",
    name: "Go",
    category: "backend",
    logo: "go",
    descriptionKey: "scaffold.tpl.go",
    defaultName: "go-service",
    options: [
      {
        id: "framework",
        kind: "choice",
        labelKey: "scaffold.opt.framework",
        choices: [
          { value: "stdlib", label: "net/http" },
          { value: "gin", label: "Gin" },
          { value: "echo", label: "Echo" },
          { value: "chi", label: "chi" },
          { value: "fiber", label: "Fiber" },
        ],
        default: "stdlib",
      },
      {
        id: "module",
        kind: "text",
        labelKey: "scaffold.opt.module",
        default: (name) => `example.com/${name.toLowerCase()}`,
        validate: (value) => (VALID_GO_MODULE.test(value) ? null : "scaffold.err.goModule"),
      },
    ],
    requirements: () => [{ tool: "go" }],
    plan: (ctx) => ({
      files: [
        { path: "main.go", content: goMain(String(ctx.opts.framework || "stdlib"), ctx.name) },
        { path: ".gitignore", content: "/bin/\n*.exe\n*.test\n*.out\n.env\n.DS_Store\n" },
      ],
      steps: [
        inRoot(ctx, "scaffold.step.module", ["go", "mod", "init", String(ctx.opts.module || `example.com/${ctx.name}`)]),
        // Resolves whatever main.go imports — the framework, at its latest release.
        inRoot(ctx, "scaffold.step.deps", ["go", "mod", "tidy"]),
      ],
      run: "go run .",
    }),
  },
  {
    id: "django",
    name: "Django",
    category: "backend",
    logo: "django",
    descriptionKey: "scaffold.tpl.django",
    versions: { kind: "pypi", package: "django" },
    ltsLine: (line) => line.endsWith(".2"),
    defaultName: "django-site",
    options: [PY_ENV, PY_VERSION],
    requirements: (ctx) => pythonRequirements(ctx, `Django ${ctx.version?.version ?? ""}`.trim(), ctx.version?.requires ?? null),
    plan: (ctx) => {
      const python = ctx.opts.env === "venv" ? venvPython(ctx) : null;
      return {
        files: [{ path: ".gitignore", content: PYTHON_GITIGNORE }],
        steps: [
          ...pythonSteps(ctx, [`django${compatible(ctx.version)}`], ctx.version?.requires ?? null),
          // `config` for the settings package: the name the project itself carries is not always a
          // valid Python identifier (a hyphen is enough), and `config` never collides with an app.
          python
            ? inRoot(ctx, "scaffold.step.generate", [python, "-m", "django", "startproject", "config", "."])
            : inRoot(ctx, "scaffold.step.generate", ["uv", "run", "django-admin", "startproject", "config", "."]),
        ],
        run: pythonRun(ctx, "uv run python manage.py runserver", "python manage.py runserver"),
      };
    },
  },
  {
    id: "fastapi",
    name: "FastAPI",
    category: "backend",
    logo: "fastapi",
    descriptionKey: "scaffold.tpl.fastapi",
    engines: { kind: "pypi", package: "fastapi" },
    defaultName: "fastapi-service",
    options: [PY_ENV, PY_VERSION],
    requirements: (ctx) => pythonRequirements(ctx, "FastAPI", ctx.engines?.requires ?? null),
    plan: (ctx) => ({
      files: [
        { path: ".gitignore", content: PYTHON_GITIGNORE },
        {
          path: "main.py",
          content: `from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef read_root():\n    return {"message": ${JSON.stringify(`Hello from ${ctx.name}!`)}}\n`,
        },
      ],
      steps: pythonSteps(ctx, ["fastapi[standard]"], ctx.engines?.requires ?? null),
      run: pythonRun(ctx, "uv run fastapi dev main.py", "fastapi dev main.py"),
    }),
  },
  {
    id: "flask",
    name: "Flask",
    category: "backend",
    logo: "flask",
    descriptionKey: "scaffold.tpl.flask",
    versions: { kind: "pypi", package: "flask" },
    defaultName: "flask-app",
    options: [PY_ENV, PY_VERSION],
    requirements: (ctx) => pythonRequirements(ctx, `Flask ${ctx.version?.version ?? ""}`.trim(), ctx.version?.requires ?? null),
    plan: (ctx) => ({
      files: [
        { path: ".gitignore", content: PYTHON_GITIGNORE },
        {
          path: "app.py",
          content: `from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.get("/")\ndef index():\n    return {"message": ${JSON.stringify(`Hello from ${ctx.name}!`)}}\n`,
        },
      ],
      steps: pythonSteps(ctx, [`flask${compatible(ctx.version)}`], ctx.version?.requires ?? null),
      run: pythonRun(ctx, "uv run flask --app app run --debug", "flask --app app run --debug"),
    }),
  },
  {
    id: "laravel",
    name: "Laravel",
    category: "backend",
    logo: "laravel",
    descriptionKey: "scaffold.tpl.laravel",
    versions: { kind: "packagist", package: "laravel/laravel" },
    versionFilter: (line) => Number(line.line) >= 10,
    defaultName: "laravel-app",
    options: [],
    requirements: (ctx) => [
      { tool: "php", range: ctx.version?.requires ?? null, because: `Laravel ${ctx.version?.version ?? ""}`.trim() },
      { tool: "composer" },
    ],
    plan: (ctx) => ({
      steps: [
        inParent(ctx, "scaffold.step.generate", [
          "composer",
          "create-project",
          `laravel/laravel:^${ctx.version?.line ?? "*"}.0`,
          ctx.name,
          "--prefer-dist",
          "--no-interaction",
        ]),
      ],
      run: "php artisan serve",
    }),
  },
  {
    id: "rails",
    name: "Ruby on Rails",
    category: "backend",
    logo: "rails",
    descriptionKey: "scaffold.tpl.rails",
    versions: { kind: "rubygems", package: "rails" },
    // 7.2 is the oldest line checked on the Rubies current today (4.0 included).
    versionFilter: (line) => Number(line.line) >= 7.2,
    defaultName: "rails-app",
    options: [
      {
        id: "database",
        kind: "choice",
        labelKey: "scaffold.opt.database",
        // MySQL through Trilogy, Rails' own client: `mysql` needs the MySQL client libraries
        // installed to build its gem, and without them fails inside a `rails new` that exits 0.
        choices: [
          { value: "sqlite3", label: "SQLite" },
          { value: "postgresql", label: "PostgreSQL" },
          { value: "trilogy", label: "MySQL (Trilogy)" },
        ],
        default: "sqlite3",
      },
      { id: "api", kind: "toggle", labelKey: "scaffold.opt.apiOnly", default: false },
      // With import maps, Tailwind needs no Node; the bundler-based CSS and JavaScript options all do
      // (and fail without a word when yarn or bun is missing), so they are left out.
      { id: "tailwind", kind: "toggle", label: "Tailwind CSS", default: false, when: (opts) => !opts.api },
    ],
    requirements: (ctx) => [
      { tool: "ruby", range: ctx.version?.requires ?? null, because: ctx.version ? `Rails ${ctx.version.version}` : "Rails" },
    ],
    plan: (ctx) => {
      const version = ctx.version?.version ?? null;
      const api = ctx.opts.api === true;
      return {
        steps: [
          { title: ctx.label("scaffold.step.gems"), cwd: ctx.parent, sh: RUBY_GEM_HOME },
          inParent(ctx, "scaffold.step.rails", ["gem", "install", "rails", ...(version ? ["-v", version] : []), "--no-document"]),
          // Not `--skip-git`: it also drops `.gitignore`, while `config/master.key` is still written
          // — the first commit would carry the key. Rails' own `git init` makes no commit and the
          // runner's re-initialises. Not `--skip-bundle` either: importmap, Solid and Kamal are set up
          // after the bundle.
          inParent(ctx, "scaffold.step.generate", [
            "ruby",
            "-e",
            RAILS_BIN,
            version ?? ">= 0",
            "new",
            ctx.name,
            `--database=${String(ctx.opts.database || "sqlite3")}`,
            ...(api ? ["--api"] : []),
            ...(!api && ctx.opts.tailwind ? ["--css=tailwind"] : []),
          ]),
          // `rails new` exits 0 when its bundle failed, leaving an app with gems missing; this is
          // what says so, and stops the script before git commits half a project.
          inRoot(ctx, "scaffold.step.verify", ["bundle", "check"]),
        ],
        run: ctx.platform === "windows" ? "ruby bin\\rails server" : "bin/rails server",
      };
    },
  },
  {
    id: "dotnet",
    name: ".NET",
    category: "backend",
    logo: "dotnet",
    descriptionKey: "scaffold.tpl.dotnet",
    versions: { kind: "runtime", product: "dotnet" },
    versionFilter: (line) => !line.eol,
    defaultName: "DotnetApp",
    options: [
      {
        id: "kind",
        kind: "choice",
        labelKey: "scaffold.opt.kind",
        choices: [
          { value: "webapi", label: "Web API" },
          { value: "mvc", label: "MVC" },
          { value: "blazor", label: "Blazor" },
          { value: "worker", label: "Worker" },
          { value: "console", label: "Console" },
          { value: "classlib", labelKey: "scaffold.opt.library" },
        ],
        default: "webapi",
      },
    ],
    requirements: (ctx) => [
      { tool: "dotnet", range: ctx.version ? `>=${ctx.version.line}.0.0` : null, because: ctx.version ? `.NET ${ctx.version.line}` : ".NET" },
    ],
    plan: (ctx) => ({
      steps: [
        inParent(ctx, "scaffold.step.generate", [
          "dotnet",
          "new",
          String(ctx.opts.kind || "webapi"),
          "--name",
          ctx.name,
          "--output",
          ctx.name,
          ...(ctx.version ? ["--framework", `net${ctx.version.line}.0`] : []),
        ]),
        inRoot(ctx, "scaffold.step.gitignore", ["dotnet", "new", "gitignore"]),
      ],
      run: ctx.opts.kind === "classlib" ? "dotnet build" : "dotnet watch",
    }),
  },
  {
    id: "rust",
    name: "Rust",
    category: "backend",
    logo: "rust",
    descriptionKey: "scaffold.tpl.rust",
    defaultName: "rust-app",
    options: [
      {
        id: "kind",
        kind: "choice",
        labelKey: "scaffold.opt.kind",
        choices: [
          { value: "bin", labelKey: "scaffold.opt.binary" },
          { value: "lib", labelKey: "scaffold.opt.library" },
        ],
        default: "bin",
      },
    ],
    requirements: () => [{ tool: "cargo" }],
    plan: (ctx) => ({
      steps: [
        inParent(ctx, "scaffold.step.generate", [
          "cargo",
          "new",
          ctx.name,
          "--vcs",
          "none",
          ...(ctx.opts.kind === "lib" ? ["--lib"] : []),
        ]),
      ],
      run: ctx.opts.kind === "lib" ? "cargo test" : "cargo run",
    }),
  },
];

const TSCONFIG_NODE = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
      rootDir: "src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src"],
  },
  null,
  2,
)}\n`;

/** main.go for each router — the smallest server that answers on :8080. */
function goMain(framework: string, name: string): string {
  const hello = JSON.stringify(`Hello from ${name}!`);
  switch (framework) {
    case "gin":
      return `package main\n\nimport "github.com/gin-gonic/gin"\n\nfunc main() {\n\tr := gin.Default()\n\tr.GET("/", func(c *gin.Context) {\n\t\tc.JSON(200, gin.H{"message": ${hello}})\n\t})\n\tr.Run(":8080")\n}\n`;
    case "echo":
      return `package main\n\nimport (\n\t"net/http"\n\n\t"github.com/labstack/echo/v4"\n)\n\nfunc main() {\n\te := echo.New()\n\te.GET("/", func(c echo.Context) error {\n\t\treturn c.JSON(http.StatusOK, map[string]string{"message": ${hello}})\n\t})\n\te.Logger.Fatal(e.Start(":8080"))\n}\n`;
    case "chi":
      return `package main\n\nimport (\n\t"log"\n\t"net/http"\n\n\t"github.com/go-chi/chi/v5"\n\t"github.com/go-chi/chi/v5/middleware"\n)\n\nfunc main() {\n\tr := chi.NewRouter()\n\tr.Use(middleware.Logger)\n\tr.Get("/", func(w http.ResponseWriter, r *http.Request) {\n\t\tw.Write([]byte(${hello}))\n\t})\n\tlog.Fatal(http.ListenAndServe(":8080", r))\n}\n`;
    case "fiber":
      return `package main\n\nimport (\n\t"log"\n\n\t"github.com/gofiber/fiber/v2"\n)\n\nfunc main() {\n\tapp := fiber.New()\n\tapp.Get("/", func(c *fiber.Ctx) error {\n\t\treturn c.JSON(fiber.Map{"message": ${hello}})\n\t})\n\tlog.Fatal(app.Listen(":8080"))\n}\n`;
    default:
      return `package main\n\nimport (\n\t"fmt"\n\t"log"\n\t"net/http"\n)\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {\n\t\tfmt.Fprintln(w, ${hello})\n\t})\n\tlog.Println("listening on :8080")\n\tlog.Fatal(http.ListenAndServe(":8080", mux))\n}\n`;
  }
}

export const CATEGORY_LABELS: Record<Category, TranslationKey> = {
  general: "scaffold.cat.general",
  frontend: "scaffold.cat.frontend",
  backend: "scaffold.cat.backend",
  mobile: "scaffold.cat.mobile",
};

export const CATEGORY_ORDER: Category[] = ["general", "frontend", "backend", "mobile"];

/** Where `template`'s runtime requirement is read, for what has been picked so far: each choice and
 *  toggle as chosen, or its default. Text and runtime answers never decide it. */
export function enginesFor(template: Template, chosen: Options): VersionSource | undefined {
  if (typeof template.engines !== "function") return template.engines;
  const opts: Options = {};
  for (const option of template.options) {
    if (option.kind === "choice" || option.kind === "toggle") opts[option.id] = chosen[option.id] ?? option.default;
  }
  return template.engines(opts);
}

/** What a template is called on screen: its brand, or — for one named by a word — that word in the
 *  app's language. */
export function templateName(template: Template, t: (key: TranslationKey) => string): string {
  return template.nameKey ? t(template.nameKey) : template.name;
}

/** Where the dialog opens: the top of its list, which is grouped by `CATEGORY_ORDER` — never the
 *  template used last, which sat mid-list with nothing on screen saying why. */
export const FIRST_TEMPLATE = TEMPLATES.find((template) => template.category === CATEGORY_ORDER[0]) ?? TEMPLATES[0];

/**
 * pnpm runs no dependency's build script (`postinstall` and friends) that nobody approved, and from
 * pnpm 11 on it also **fails the install** over each one it held back — `ERR_PNPM_IGNORED_BUILDS`,
 * exit 1 — after writing it into `pnpm-workspace.yaml` as `allowBuilds: { core-js: set this to true
 * or false }`. Every install after that fails the same way until each one is decided. A generator
 * that installs its project itself fails mid-way (`nest new`: core-js and unrs-resolver on NestJS 12),
 * and so does our own `pnpm add` after it.
 *
 * Measured 2026-10-01 against pnpm 10.33.2, 11.5.0 and 12.6.0:
 * - `pnpm_config_strict_dep_builds=false` turns the failure back into pnpm 10's warning, inherited by
 *   whatever `pnpm dlx` starts. The `npm_config_` spelling is no longer read from pnpm 11 on.
 * - The placeholders are written either way, so the plan ends by settling them as `false` — the
 *   scripts stay unrun, as pnpm already left them, but the project now installs (a clone, CI, the
 *   next `pnpm add`). Approving one is the user's call: `pnpm approve-builds`, or `true` in the file.
 * - Written by a script rather than `pnpm approve-builds !<name>`: pnpm 10 reads no names there, it
 *   opens its menu instead — which, in a pty with nobody answering, never returns. pnpm 10 writes no
 *   placeholders and never fails, so on it the step finds nothing to do.
 *
 * Single quotes only, as in `NEST_FASTIFY_PATCH`: one argument to `node -e` on both shells.
 */
const PNPM_SETTLE_BUILDS = [
  "const fs=require('fs');",
  "const file='pnpm-workspace.yaml';",
  "if(!fs.existsSync(file))process.exit(0);",
  "const held=[];",
  "const text=fs.readFileSync(file,'utf8').replace(/^([ \\t]+)(.+?):[ \\t]*set this to true or false[ \\t]*$/gm,",
  "(line,indent,name)=>{held.push(name);return indent+name+': false';});",
  "if(held.length===0)process.exit(0);",
  "fs.writeFileSync(file,text);",
  "console.log(file+'  allowBuilds:');",
  "for(const name of held)console.log('  '+name+': false');",
].join("");

/** A plan as the runner runs it: the template's own, plus what any plan that runs pnpm needs (see
 *  `PNPM_SETTLE_BUILDS`) — keyed on the steps that call pnpm, not on the package manager picked, since
 *  a template can run on Bun's tools whatever was picked (Hono on Bun). */
export function planFor(template: Template, ctx: TemplateContext): Plan {
  const plan = template.plan(ctx);
  const pnpm = (step: Step) => step.argv?.[0] === "pnpm";
  if (!plan.steps.some(pnpm)) return plan;
  return {
    ...plan,
    steps: [
      ...plan.steps.map((step) => (pnpm(step) ? { ...step, env: { ...step.env, pnpm_config_strict_dep_builds: "false" } } : step)),
      { ...inRoot(ctx, "scaffold.step.builds", ["node", "-e", PNPM_SETTLE_BUILDS]), optional: true },
    ],
  };
}

/** The git steps every plan ends with. `commit` is optional-tolerant: a machine with no git identity
 *  still gets a repository, just without the first commit, and is told so in the terminal.
 *
 *  `empty` (`Plan.emptyCommit`) is for a folder with nothing to add. It is never the default: a
 *  generator that commits its own work (Expo does) would get an empty twin of that commit. */
export function gitSteps(root: string, label: (key: TranslationKey) => string, commit: boolean, empty = false): Step[] {
  const steps: Step[] = [{ title: label("scaffold.step.git"), cwd: root, argv: ["git", "init", "-q"] }];
  const allow = empty ? " --allow-empty" : "";
  if (commit)
    steps.push({
      title: label("scaffold.step.commit"),
      cwd: root,
      optional: true,
      sh: `git add -A && git commit -q${allow} -m 'Initial commit'`,
      ps: `git add -A; Cf-Check; git commit -q${allow} -m 'Initial commit'; Cf-Check`,
    });
  return steps;
}

/** npm's name rules, beyond what a folder allows: lowercase, no spaces, nothing a URL would mangle. */
export function npmNameProblem(name: string): TranslationKey | null {
  if (name !== name.toLowerCase()) return "scaffold.err.npmLowercase";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return "scaffold.err.npmChars";
  return null;
}
