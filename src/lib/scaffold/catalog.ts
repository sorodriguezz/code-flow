import type { TranslationKey } from "../i18n/translations";
import type { FileSpec, ScaffoldPlatform, SpringRequest, VersionLine, VersionSource } from "./api";
import type { Step } from "./script";
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
 *
 * Anything a future release adds is still only a question in the terminal the dialog shows, which is
 * why the commands run in a pty at all (see `src-tauri/src/scaffold/run.rs`).
 *
 * **Git is the runner's, not the template's.** Every generator that would initialise a repository is
 * told not to, and the runner adds `git init` and an initial commit to every plan the same way — so a
 * project is a repository (which is what lets it be imported into a workspace at all) and its first
 * commit is the user's, whichever tool made it.
 */

export type Category = "frontend" | "backend" | "mobile";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type OptionValue = string | boolean;
export type Options = Record<string, OptionValue>;

interface OptionBase {
  id: string;
  /** Brand words (Pinia, Tailwind CSS) are not translated; everything else is a key. */
  label?: string;
  labelKey?: TranslationKey;
  /** Shown only when this holds. */
  when?: (opts: Options) => boolean;
}

export interface ChoiceOption extends OptionBase {
  kind: "choice";
  choices: { value: string; label?: string; labelKey?: TranslationKey }[];
  default: string;
}

export interface ToggleOption extends OptionBase {
  kind: "toggle";
  default: boolean;
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
  /** Written into the project folder before the steps run. */
  files?: FileSpec[];
  steps: Step[];
  /** How to start it, shown when it is done. */
  run?: string;
}

export interface Template {
  id: string;
  name: string;
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
  /** Where the runtime requirement lives when it is not the generator's: Nuxt's is `nuxt`'s. */
  engines?: VersionSource;
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

// ── The catalogue ───────────────────────────────────────────────────────────────────────────────

export const TEMPLATES: Template[] = [
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
    engines: { kind: "npm", package: "create-expo-app" },
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
    options: [LANGUAGE],
    requirements: (ctx) => [nodeRequirement(ctx, "NestJS"), ...pmRequirements(ctx)],
    plan: (ctx) => ({
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
            ...(major(ctx) >= 12 ? ["--no-observe"] : []),
          ]),
          // The schematic behind `nest new` asks ESM-or-CommonJS and has no flag for it; told there
          // is no TTY, the schematics runner takes the default (ESM) instead of asking.
          { NG_FORCE_TTY: "false" },
        ),
      ],
      run: runCmd(ctx.pm, "start:dev"),
    }),
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
  frontend: "scaffold.cat.frontend",
  backend: "scaffold.cat.backend",
  mobile: "scaffold.cat.mobile",
};

export const CATEGORY_ORDER: Category[] = ["frontend", "backend", "mobile"];

/** The git steps every plan ends with. `commit` is optional-tolerant: a machine with no git identity
 *  still gets a repository, just without the first commit, and is told so in the terminal. */
export function gitSteps(root: string, label: (key: TranslationKey) => string, commit: boolean): Step[] {
  const steps: Step[] = [{ title: label("scaffold.step.git"), cwd: root, argv: ["git", "init", "-q"] }];
  if (commit)
    steps.push({
      title: label("scaffold.step.commit"),
      cwd: root,
      optional: true,
      sh: "git add -A && git commit -q -m 'Initial commit'",
      ps: "git add -A; Cf-Check; git commit -q -m 'Initial commit'; Cf-Check",
    });
  return steps;
}

/** npm's name rules, beyond what a folder allows: lowercase, no spaces, nothing a URL would mangle. */
export function npmNameProblem(name: string): TranslationKey | null {
  if (name !== name.toLowerCase()) return "scaffold.err.npmLowercase";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return "scaffold.err.npmChars";
  return null;
}
