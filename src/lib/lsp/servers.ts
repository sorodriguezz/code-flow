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
 * - **Vue, Svelte, Astro, Terraform, TOML.** Their servers are good and their entries would be two
 *   lines each — but Monaco registers no grammar for any of them, so a `.vue` or `.toml` model's
 *   `getLanguageId()` is `plaintext` and nothing would ever be routed to the server. `taplo` was in
 *   here until it was noticed that `monacoLanguage.ts` maps `toml` to an id Monaco does not have.
 *   They are waiting on TextMate grammars, not on this file.
 * - **Java (`jdtls`), Kotlin, Scala.** They need a JVM to be installed and configured before the
 *   server will even start, which is a different install story than "a binary on `PATH`".
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
      yaml: { schemas: {}, validate: true, completion: true, hover: true, format: { enable: true } },
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
    languages: ["css", "scss", "html", "typescript", "javascript"],
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
    settings: { gopls: { usePlaceholders: true, staticcheck: false } },
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
];

export function serverById(id: string): LanguageServer | null {
  return LANGUAGE_SERVERS.find((server) => server.id === id) ?? null;
}

/** Every server that claims this Monaco language — more than one is normal. */
export function serversForLanguage(language: string): LanguageServer[] {
  return LANGUAGE_SERVERS.filter((server) => server.languages.includes(language));
}

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
