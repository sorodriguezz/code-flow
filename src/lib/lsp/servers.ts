/** Which language server backs each language.
 *
 * The same shape, and the same deal, as `debugAdapters.ts`: the server is a separate program the
 * user installs, and what lives here is a command line plus the configuration it wants. Adding a
 * language is an entry in this array — no code — which is the whole reason the backend
 * (`lsp.rs`) speaks protocol and nothing else.
 *
 * **Two tiers, and the difference is only where it can be found.** Tier 0 is published to npm, so
 * `npx` can run a copy that is already present — in the project's own `node_modules/.bin`, or
 * installed globally — which means a repo carrying its server as a devDependency needs no global
 * install at all. A fetch is never authorised: `client.ts` probes with `npx --no` and launches the
 * same way. Tier 1 is a binary that has to be on `PATH`. Nothing else about them differs — a tier is a hint for the Settings badge and
 * for how hard the app should try before giving up.
 *
 * **What is deliberately not here:**
 *
 * - **TypeScript and JavaScript.** `useTypeScript.ts` already drives the project's own `tsserver`
 *   through `tsserver.rs`, which is the same architecture as this one and a better fit for those
 *   two languages specifically: it is `tsserver`'s own protocol rather than LSP's translation of
 *   it, and it is already wired to the npm install flow. A `typescript-language-server` entry here
 *   would be a second, worse answer competing with it in the same completion list.
 * - **JSON, CSS, SCSS, HTML.** Monaco bundles real language services for these and `monacoSetup.ts`
 *   already wires up their workers. A server would be work to draw even.
 * - **Vue, Svelte, Astro, Terraform** share a Monaco language with plainer files (`html`, `hcl`),
 *   so their servers are routed by *extension* — see [`lspLanguageOf`]: the file is `vue` to the
 *   server and `html` to Monaco. TOML has a grammar of its own (`monacoToml`) and needs no mapping.
 * - **Scala.** Metals is installed through Coursier and bootstraps itself on first run, which is a
 *   different install story than "a binary on `PATH`". Java and Kotlin are in (tier 1): `jdtls`'s
 *   wrapper finds the JVM itself, and keeps its index under the temp dir keyed by the folder it is
 *   started in — which `lsp.rs` makes the repository.
 * - **SQL.** `sqlCompletion.ts` completes from the *live connection's* tables. No generic SQL
 *   server knows that, so one here would be a downgrade.
 */

export interface LanguageServer {
  id: string;
  label: string;
  /** 0 = published to npm and runnable through `npx`; 1 = a binary that must be on `PATH`. */
  tier: 0 | 1;
  /** Monaco language ids this server answers for. More than one server may claim a language —
   * Tailwind sits alongside whatever else is completing in a `.css` or `.tsx` file — and Monaco
   * merges what every registered provider returns. */
  languages: string[];
  command: string;
  args: string[];
  /** The npm package `npx` should run when `command` isn't on `PATH`. `null` for tier 1. */
  npm: string | null;
  /** Arguments that make the command print its version, for the found/not-found badge. */
  versionArgs: string[];
  /** Files at the repo root that mean this project is one this server has something to say about.
   * Empty claims every repo. Starting `rust-analyzer` in a repo with no `Cargo.toml` costs a
   * process, a few hundred MB and an error the user did nothing to deserve. */
  rootFiles: string[];
  /** Passed in `initialize`. Some servers read only this and ignore the rest. */
  initializationOptions: Record<string, unknown>;
  /** Answered to `workspace/configuration`, and pushed as `didChangeConfiguration`. Some servers
   * read only *this* and ignore `initializationOptions`; which one is not settled by the protocol,
   * so both are always sent. */
  settings: Record<string, unknown>;
  /** What to install when it isn't found — shown verbatim, the same as a debug adapter's. */
  install: string;
}

/**
 * The language a file is to its servers, where that is not what Monaco calls it.
 *
 * `.vue`, `.svelte` and `.astro` open as `html` (`monacoLanguage`) — that is what colours their
 * markup and brings tag completion and Emmet — and `.tf` as `hcl`. A server is told the real thing:
 * the language id in `didOpen` is what Volar, the Svelte server and `terraform-ls` key on, and an
 * HTML file must not be sent to any of them.
 */
const LSP_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  tf: "terraform",
  tfvars: "terraform-vars",
};

/** Monaco's id for each language above — what providers are registered against. */
const MONACO_LANGUAGE_OF: Record<string, string> = {
  vue: "html",
  svelte: "html",
  astro: "html",
  terraform: "hcl",
  "terraform-vars": "hcl",
};

export function lspLanguageOf(path: string, monacoLanguage: string): string {
  const extension = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return LSP_LANGUAGE_BY_EXTENSION[extension] ?? monacoLanguage;
}

export function monacoLanguageOf(lspLanguage: string): string {
  return MONACO_LANGUAGE_OF[lspLanguage] ?? lspLanguage;
}

/**
 * `initializationOptions` and `settings` with `${repo}` replaced by the repository's path — Volar
 * and the Astro server must be told where the project's own TypeScript lives, and refuse to start
 * without it.
 */
export function withRepoPath<T>(value: T, repoPath: string): T {
  if (typeof value === "string") return value.split("${repo}").join(repoPath) as T;
  if (Array.isArray(value)) return value.map((item) => withRepoPath(item, repoPath)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withRepoPath(inner, repoPath)])) as T;
  }
  return value;
}

export const LANGUAGE_SERVERS: LanguageServer[] = [
  // ── Tier 0 ────────────────────────────────────────────────────────────────────────────────
  {
    id: "pyright",
    label: "Python (Pyright)",
    tier: 0,
    languages: ["python"],
    command: "pyright-langserver",
    args: ["--stdio"],
    npm: "pyright",
    versionArgs: ["--version"],
    rootFiles: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    initializationOptions: {},
    settings: {
      python: {
        analysis: {
          autoSearchPaths: true,
          useLibraryCodeForTypes: true,
          // `basic` rather than `strict`: an editor that opens someone else's untyped Python and
          // paints every line red has told the reader nothing they can act on.
          typeCheckingMode: "basic",
        },
      },
    },
    install: "npm i -g pyright  ·  pip install pyright",
  },
  {
    id: "yaml",
    label: "YAML",
    tier: 0,
    languages: ["yaml"],
    command: "yaml-language-server",
    args: ["--stdio"],
    npm: "yaml-language-server",
    versionArgs: ["--version"],
    rootFiles: [],
    initializationOptions: {},
    settings: {
      // Schema association by filename is what turns this from a linter into the thing that
      // completes a GitHub Actions step or a compose service.
      // `schemaStore` is the catalogue the JSON side reads too (`lib/jsonSchemas`): workflows,
      // compose files, Kubernetes manifests and the rest are matched by file name, as in VS Code.
      yaml: {
        schemas: {},
        schemaStore: { enable: true, url: "https://www.schemastore.org/api/json/catalog.json" },
        validate: true,
        completion: true,
        hover: true,
        format: { enable: true },
      },
    },
    install: "npm i -g yaml-language-server",
  },
  {
    id: "docker",
    label: "Dockerfile",
    tier: 0,
    languages: ["dockerfile"],
    command: "docker-langserver",
    args: ["--stdio"],
    npm: "dockerfile-language-server-nodejs",
    versionArgs: ["--version"],
    rootFiles: [],
    initializationOptions: {},
    settings: {},
    install: "npm i -g dockerfile-language-server-nodejs",
  },
  {
    id: "tailwind",
    label: "Tailwind CSS",
    tier: 0,
    // Claims the languages a class attribute appears in, which is why it sits beside the other
    // servers rather than replacing one.
    languages: ["css", "scss", "html", "typescript", "javascript", "vue", "svelte", "astro"],
    command: "tailwindcss-language-server",
    args: ["--stdio"],
    npm: "@tailwindcss/language-server",
    versionArgs: ["--version"],
    // Only started where Tailwind actually is: everywhere else it would attach to every `.ts` file
    // in the repo and complete nothing.
    rootFiles: ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs", "tailwind.config.mjs"],
    initializationOptions: {},
    settings: {
      tailwindCSS: { validate: true, classAttributes: ["class", "className", "ngClass"] },
    },
    install: "npm i -g @tailwindcss/language-server",
  },
  {
    id: "bash",
    label: "Shell",
    tier: 0,
    languages: ["shell"],
    command: "bash-language-server",
    args: ["start"],
    npm: "bash-language-server",
    versionArgs: ["--version"],
    rootFiles: [],
    initializationOptions: {},
    settings: {},
    install: "npm i -g bash-language-server",
  },
  {
    id: "intelephense",
    label: "PHP",
    tier: 0,
    languages: ["php"],
    command: "intelephense",
    args: ["--stdio"],
    npm: "intelephense",
    versionArgs: ["--version"],
    rootFiles: ["composer.json", "index.php"],
    initializationOptions: {},
    settings: {},
    install: "npm i -g intelephense",
  },

  {
    id: "vue",
    label: "Vue (Volar)",
    tier: 0,
    languages: ["vue"],
    command: "vue-language-server",
    args: ["--stdio"],
    // Pinned to 2: from 3 on the server only answers through a TypeScript plugin inside VS Code's
    // own tsserver, and talks to nothing else. 2 still runs on its own (`hybridMode: false`).
    npm: "@vue/language-server@2",
    versionArgs: ["--version"],
    rootFiles: ["vite.config.ts", "vite.config.js", "nuxt.config.ts", "nuxt.config.js", "vue.config.js"],
    initializationOptions: {
      typescript: { tsdk: "${repo}/node_modules/typescript/lib" },
      vue: { hybridMode: false },
    },
    settings: {},
    install: "npm i -g @vue/language-server@2 typescript",
  },
  {
    id: "svelte",
    label: "Svelte",
    tier: 0,
    languages: ["svelte"],
    command: "svelteserver",
    args: ["--stdio"],
    npm: "svelte-language-server",
    // Prints nothing and exits 0 — enough for the probe, which reads the exit status.
    versionArgs: ["--version"],
    rootFiles: ["svelte.config.js", "svelte.config.mjs", "svelte.config.ts"],
    initializationOptions: {},
    settings: {},
    install: "npm i -g svelte-language-server",
  },
  {
    id: "astro",
    label: "Astro",
    tier: 0,
    languages: ["astro"],
    command: "astro-ls",
    args: ["--stdio"],
    npm: "@astrojs/language-server",
    versionArgs: ["--version"],
    rootFiles: ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
    initializationOptions: { typescript: { tsdk: "${repo}/node_modules/typescript/lib" } },
    settings: {},
    install: "npm i -g @astrojs/language-server typescript",
  },

  // ── Tier 1 ────────────────────────────────────────────────────────────────────────────────
  {
    id: "rust-analyzer",
    label: "Rust",
    tier: 1,
    languages: ["rust"],
    command: "rust-analyzer",
    args: [],
    npm: null,
    versionArgs: ["--version"],
    rootFiles: ["Cargo.toml"],
    initializationOptions: {
      // Indexing a cold workspace is minutes of CPU; `$/progress` is forwarded so the status line
      // can say so instead of the editor looking broken.
      cachePriming: { enable: true },
      checkOnSave: true,
    },
    settings: { "rust-analyzer": { checkOnSave: true, cargo: { buildScripts: { enable: true } } } },
    install: "rustup component add rust-analyzer",
  },
  {
    id: "gopls",
    label: "Go",
    tier: 1,
    languages: ["go"],
    command: "gopls",
    args: ["serve"],
    npm: null,
    versionArgs: ["version"],
    rootFiles: ["go.mod", "go.work"],
    initializationOptions: {},
    // gopls computes no inlay hints until told which, unlike rust-analyzer and clangd. These are the
    // ones that say what Go leaves unsaid: a `:=`'s type, a range variable's, a literal argument's
    // parameter, a constant's value. The composite-literal ones would repeat field names Go code
    // already spells out, and are left off. Whether any are drawn is the Editor's switch.
    settings: {
      gopls: {
        usePlaceholders: true,
        staticcheck: false,
        hints: {
          assignVariableTypes: true,
          rangeVariableTypes: true,
          parameterNames: true,
          constantValues: true,
          functionTypeParameters: true,
        },
      },
    },
    install: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "clangd",
    label: "C / C++",
    tier: 1,
    languages: ["c", "cpp"],
    command: "clangd",
    // Without a background index, "find references" only sees the file in front of it.
    args: ["--background-index"],
    npm: null,
    versionArgs: ["--version"],
    rootFiles: ["compile_commands.json", "CMakeLists.txt", "Makefile", ".clangd"],
    initializationOptions: {},
    settings: {},
    // Microsoft's own C/C++ extension is licensed for use only from Microsoft products — the same
    // wall `debugAdapters.ts` hits with `vsdbg` — so this is the open one, which is also the
    // better one.
    // `brew install llvm` is deliberately not offered: it installs clangd into a keg-only prefix
    // that is not on `PATH`, so the user would follow this panel's whole flow — read "not found",
    // copy, run, press Check again — and still read "not found", with nothing on screen saying why.
    install: "brew install llvm && echo 'export PATH=\"$(brew --prefix llvm)/bin:$PATH\"' >> ~/.zshrc  ·  apt install clangd",
  },
  {
    id: "ruff",
    label: "Python (Ruff)",
    tier: 1,
    languages: ["python"],
    command: "ruff",
    args: ["server"],
    npm: null,
    versionArgs: ["--version"],
    rootFiles: ["pyproject.toml", "ruff.toml", ".ruff.toml", "setup.py", "requirements.txt"],
    initializationOptions: {},
    settings: {},
    // Runs beside Pyright rather than instead of it: Pyright answers about types, Ruff about lint
    // and formatting, and Monaco merges both.
    install: "pip install ruff  ·  brew install ruff",
  },
  {
    id: "csharp",
    label: "C#",
    tier: 1,
    languages: ["csharp"],
    command: "csharp-ls",
    args: [],
    npm: null,
    versionArgs: ["--version"],
    rootFiles: [],
    initializationOptions: {},
    settings: {},
    install: "dotnet tool install --global csharp-ls",
  },
  {
    id: "lua",
    label: "Lua",
    tier: 1,
    languages: ["lua"],
    command: "lua-language-server",
    args: [],
    npm: null,
    versionArgs: ["--version"],
    rootFiles: [],
    initializationOptions: {},
    settings: {},
    install: "brew install lua-language-server",
  },
  {
    id: "ruby",
    label: "Ruby",
    tier: 1,
    languages: ["ruby"],
    command: "ruby-lsp",
    args: [],
    npm: null,
    versionArgs: ["--version"],
    rootFiles: ["Gemfile", ".ruby-version"],
    initializationOptions: {},
    settings: {},
    install: "gem install ruby-lsp",
  },
  {
    id: "taplo",
    label: "TOML (Taplo)",
    tier: 1,
    languages: ["toml"],
    command: "taplo",
    args: ["lsp", "stdio"],
    // Not the npm build: `@taplo/cli` 0.9 exits 1 on every command and never answers `initialize`.
    npm: null,
    versionArgs: ["--version"],
    rootFiles: [],
    initializationOptions: {},
    settings: {},
    install: "brew install taplo  ·  cargo install taplo-cli --locked --features lsp",
  },
  {
    id: "terraform",
    label: "Terraform",
    tier: 1,
    languages: ["terraform", "terraform-vars"],
    command: "terraform-ls",
    args: ["serve"],
    npm: null,
    versionArgs: ["version"],
    rootFiles: [],
    initializationOptions: {},
    settings: {},
    install: "brew install hashicorp/tap/terraform-ls",
  },
  {
    id: "jdtls",
    label: "Java (Eclipse JDT LS)",
    tier: 1,
    languages: ["java"],
    command: "jdtls",
    args: [],
    npm: null,
    // The wrapper has no version flag of its own; `--help` exits 0 once Python and the JVM are found.
    versionArgs: ["--help"],
    rootFiles: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", ".project"],
    initializationOptions: {},
    settings: {
      java: {
        inlayHints: { parameterNames: { enabled: "literals" } },
        signatureHelp: { enabled: true },
        format: { enabled: true },
      },
    },
    install: "brew install jdtls  ·  needs a JDK 21+ on PATH",
  },
  {
    id: "kotlin",
    label: "Kotlin",
    tier: 1,
    languages: ["kotlin"],
    command: "kotlin-language-server",
    args: [],
    npm: null,
    versionArgs: ["--version"],
    rootFiles: ["build.gradle.kts", "settings.gradle.kts", "build.gradle", "pom.xml"],
    initializationOptions: {},
    settings: {},
    install: "brew install kotlin-language-server",
  },
];

/** The servers worth starting for a repo whose root contains `rootEntries`.
 *
 * A server with no `rootFiles` claims everything: YAML and shell files turn up in any repo, and
 * there is no marker that would predict them. */
export function serversForRepo(rootEntries: string[]): LanguageServer[] {
  const present = new Set(rootEntries);
  return LANGUAGE_SERVERS.filter(
    (server) => server.rootFiles.length === 0 || server.rootFiles.some((file) => present.has(file)),
  );
}

/** The command line to actually spawn: the binary if it is on `PATH`, otherwise `npx` for the
 * tier-0 servers — which runs a copy that is already there rather than fetching one. */
export function spawnFor(server: LanguageServer, direct: boolean): { command: string; args: string[] } {
  if (direct || !server.npm) return { command: server.command, args: server.args };
  // `--yes` would authorise a fetch, and the one caller rewrites it to `--no` for exactly that
  // reason (see `probe` in `client.ts`) — it is written here so the flag a fetching variant would
  // need is visible in one place rather than invented at the call site.
  return { command: "npx", args: ["--yes", "--package", server.npm, server.command, ...server.args] };
}
