import { fileGlyphId, folderGlyphId } from "./frameworkGlyphs";
import { parseIconPattern, sameRuleTarget, type IconRule } from "./rules";

/**
 * The icon packs this app ships: a General base that covers the file types and folders of every
 * common stack, and one pack per framework that lays that framework's own conventions over it.
 *
 * # Why the base is big now
 *
 * This used to ship three short profiles on the argument that the built-in Lucide table already
 * covers extensions. It does — as a column of one-colour silhouettes, where a `.py`, a `.go` and a
 * `.rb` are the same grey page. The user asked for the opposite ("that General does not look so
 * empty"), so General now answers the extensions, the well-known file names (every package
 * manager's manifest and lockfile, every linter's and bundler's config) and the folder names a
 * project is made of, with the vscode-icons glyph for each — the same catalogue the rules already
 * drew from, so nothing new is downloaded.
 *
 * # Why a framework pack repeats the base
 *
 * A profile is a self-contained, ordered, editable list (see `profiles.ts`): that is what makes it
 * restorable, exportable and searchable in the panel. So a pack is its framework's rules **first** —
 * they are the ones that know `*.service.ts` is an Angular service here and a Nest provider there —
 * followed by every General rule the pack did not already claim. The copy is made here, in code,
 * from one source; nobody maintains eleven lists of `*.ts`.
 *
 * # How the tables are written
 *
 * As the patterns the panel itself reads — `*.spec.ts`, `src/`, `vite.config.*`, `Dockerfile` —
 * parsed by `parseIconPattern`, so a shipped rule looks in the list exactly like one typed there.
 * The icon is the vscode-icons name without its `file-type-`/`folder-type-` prefix, which the
 * pattern's own trailing slash decides — or, for a glyph this repo draws itself (`localSet.ts`), its
 * full id, `cf:nest-guard`, taken as written. `packs.test.ts` checks that every one exists and that
 * no rule is shadowed by one above it.
 *
 * Order inside a table is the matching order: exact names and prefixes before compound suffixes
 * (`*.d.ts`, `*.spec.ts`) before plain extensions, because the list is first-match-wins.
 */

type Row = readonly [pattern: string, icon: string];

function rows(prefix: string, table: readonly Row[]): IconRule[] {
  return table.map(([pattern, icon]) => {
    const parsed = parseIconPattern(pattern);
    const kind = parsed.target === "folder" ? "folder-type" : "file-type";
    const id = icon.includes(":") ? icon : `vscode-icons:${kind}-${icon}`;
    return { id: `${prefix}:${pattern}`, ...parsed, icon: id, enabled: true };
  });
}

/** Several extensions, one glyph. */
const ext = (icon: string, ...extensions: string[]): Row[] => extensions.map((e) => [`*.${e}`, icon]);
/** Several exact names (or patterns), one glyph. */
const named = (icon: string, ...patterns: string[]): Row[] => patterns.map((p) => [p, icon]);
/** Several folder names, one glyph. */
const dirs = (icon: string, ...names: string[]): Row[] => names.map((n) => [`${n}/`, icon]);
/**
 * Patterns drawn with one framework's own glyphs — its mark in the kind's colour, with the kind's
 * emblem (`frameworkGlyphs.ts`, which says why not vscode-icons'): `files` names a kind of file,
 * `dirs` a kind of folder.
 */
function drawn(framework: string) {
  return {
    files: (kind: string, ...patterns: string[]): Row[] => patterns.map((p) => [p, fileGlyphId(framework, kind)]),
    dirs: (kind: string, ...names: string[]): Row[] => names.map((n) => [`${n}/`, folderGlyphId(framework, kind)]),
  };
}

// ---------------------------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------------------------

const GENERAL_FOLDERS: Row[] = [
  ...dirs("src", "src", "source"),
  ...dirs("app", "app", "apps"),
  ...dirs("library", "lib", "libs", "vendor"),
  ...dirs("package", "packages", "pkg"),
  ...dirs("dist", "dist", "build", "out", "output", ".output", "target", "release"),
  ...dirs("binary", "bin"),
  ...dirs("temp", "tmp", "temp", ".temp", ".cache", "obj"),
  ...dirs("public", "public", "static", "staticfiles"),
  ...dirs("www", "www", "wwwroot"),
  ...dirs("asset", "assets", "asset", "resources"),
  ...dirs("images", "images", "image", "img", "imgs", "icons", "media", "pictures", "screenshots"),
  ...dirs("fonts", "fonts", "font"),
  ...dirs("style", "styles", "style", "stylesheets"),
  ...dirs("css", "css"),
  ...dirs("sass", "sass", "scss"),
  ...dirs("script", "scripts", "script"),
  ...dirs("docs", "docs", "doc", "documentation", "content"),
  ...dirs("test", "test", "tests", "__tests__", "spec", "specs", "testing"),
  ...dirs("e2e", "e2e", "integration"),
  ...dirs("mock", "mocks", "__mocks__", "mock", "fixtures", "fixture", "stubs"),
  ...dirs("config", "config", "configs", "configuration", "configurations", "settings", ".config"),
  ...dirs("environments", "environments", "environment", "envs"),
  ...dirs("helper", "helpers", "helper", "utils", "util", "utilities"),
  ...dirs("component", "components", "component", "widgets", "ui"),
  ...dirs("services", "services", "service", "providers"),
  ...dirs("api", "api", "apis", "endpoints"),
  ...dirs("controller", "controllers", "controller"),
  ...dirs("model", "models", "model", "entities", "entity", "domain", "schemas"),
  ...dirs("view", "views", "view", "pages", "screens"),
  ...dirs("route", "routes", "route", "router", "routers", "routing"),
  ...dirs("middleware", "middleware", "middlewares", "interceptors"),
  ...dirs("hook", "hooks", "composables"),
  ...dirs("typings", "types", "typings", "@types"),
  ...dirs("interfaces", "interfaces", "dto", "dtos"),
  ...dirs("plugin", "plugins", "plugin", "extensions", "addons"),
  ...dirs("module", "modules", "module", "features"),
  ...dirs("shared", "shared"),
  ...dirs("common", "common", "core"),
  ...dirs("template", "templates", "template", "layouts", "layout", "partials"),
  ...dirs("theme", "themes", "theme"),
  ...dirs("locale", "locales", "locale", "i18n", "lang", "langs", "translations", "l10n"),
  ...dirs("log", "logs", "log"),
  ...dirs("db", "db", "database", "databases", "migrations", "migration", "seeders", "seeds", "sql"),
  ...dirs("prisma", "prisma"),
  ...dirs("graphql", "graphql", "gql"),
  ...dirs("server", "server", "backend"),
  ...dirs("client", "client", "frontend"),
  ...dirs("tools", "tools", "tooling"),
  ...dirs("redux", "store", "stores", "redux", "state"),
  ...dirs("notebooks", "notebooks"),
  ...dirs("story", ".storybook", "stories", "storybook"),
  ...dirs("private", "private", "secrets", "security", "internal"),
  ...dirs("include", "include", "includes"),
  ...dirs("video", "videos", "video"),
  ...dirs("audio", "audio", "sounds", "sound"),
  ...dirs("mobile", "mobile"),
  ...dirs("android", "android"),
  ...dirs("ios", "ios"),
  ...dirs("kubernetes", "k8s", "kubernetes", "helm", "charts"),
  ...dirs("docker", "docker", ".docker"),
  ...dirs("certificate", "certs", "certificates", "ssl"),
  ...dirs("notification", "notifications"),
  ...dirs("bot", "bot", "bots"),
  ...dirs("node", "node_modules"),
  ...dirs("git", ".git"),
  ...dirs("github", ".github", "workflows"),
  ...dirs("gitlab", ".gitlab"),
  ...dirs("vscode", ".vscode"),
  ...dirs("idea", ".idea"),
  ...dirs("vs", ".vs"),
  ...dirs("husky", ".husky"),
  ...dirs("devcontainer", ".devcontainer"),
  ...dirs("circleci", ".circleci"),
  ...dirs("coverage", "coverage", ".nyc_output", "htmlcov"),
  ...dirs("cypress", "cypress"),
  ...dirs("next", ".next"),
  ...dirs("nuxt", ".nuxt"),
  ...dirs("angular", ".angular"),
  ...dirs("vercel", ".vercel"),
  ...dirs("netlify", ".netlify"),
  ...dirs("turbo", ".turbo"),
  ...dirs("yarn", ".yarn"),
  ...dirs("expo", ".expo"),
  ...dirs("tauri", "src-tauri"),
  ...dirs("electron", "electron"),
  ...dirs("gradle", "gradle", ".gradle"),
  ...dirs("maven", ".mvn"),
  ...dirs("nuget", ".nuget"),
  ...dirs("cargo", ".cargo"),
  ...dirs("python", ".venv", "venv", "__pycache__", "site-packages"),
  ...dirs("pytest", ".pytest_cache"),
  ...dirs("mypy", ".mypy_cache"),
  ...dirs("aws", ".aws", "aws"),
  ...dirs("azure", ".azure", "azure"),
  ...dirs("supabase", "supabase"),
  ...dirs("webpack", "webpack"),
];

/** Names, prefixes and compound suffixes — everything that must be looked at before the plain
 * extension below it would claim the file. */
const GENERAL_NAMED_FILES: Row[] = [
  // Package managers and runtimes.
  ...named("npm", "package.json", "package-lock.json", ".npmrc", ".npmignore"),
  ...named("yarn", "yarn.lock", ".yarnrc", ".yarnrc.yml"),
  ...named("pnpm", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs"),
  // Bun's own: every pack shows a Bun lockfile and config as Bun's, not only the Bun pack.
  ...drawn("bun").files("lockfile", "bun.lockb", "bun.lock"),
  ...drawn("bun").files("config", "bunfig.toml"),
  ...named("node", ".nvmrc", ".node-version"),
  ...named("deno", "deno.json", "deno.jsonc", "deno.lock"),
  // Language and tool configuration.
  ...named("tsconfig", "tsconfig*"),
  ...named("jsconfig", "jsconfig*"),
  ...named("eslint", ".eslintrc*", "eslint.config.*", ".eslintignore"),
  ...named("prettier", ".prettierrc*", "prettier.config.*", ".prettierignore"),
  ...named("stylelint", ".stylelintrc*", "stylelint.config.*"),
  ...named("biome", "biome.json", "biome.jsonc"),
  ...named("editorconfig", ".editorconfig"),
  ...named("babel", ".babelrc*", "babel.config.*"),
  ...named("swc", ".swcrc"),
  ...named("browserslist", ".browserslistrc", "browserslist"),
  // Bundlers, test runners and the frameworks' own config files — unambiguous wherever they sit.
  ...named("vite", "vite.config.*", "vite-env.d.ts"),
  ...named("vitest", "vitest.config.*", "vitest.workspace*", "vitest.setup.*"),
  ...named("jest", "jest.config.*", "jest.setup.*", "setupTests.*"),
  ...named("webpack", "webpack.*"),
  ...named("rollup", "rollup.config.*"),
  ...named("tailwind", "tailwind.config.*"),
  ...named("postcssconfig", "postcss.config.*", ".postcssrc*"),
  ...named("cypress", "cypress.config.*"),
  ...named("playwright", "playwright.config.*"),
  ...named("karma", "karma.conf.*"),
  ...named("turbo", "turbo.json"),
  ...named("nx", "nx.json"),
  ...named("lerna", "lerna.json"),
  ...named("commitlint", "commitlint.config.*", ".commitlintrc*"),
  ...named("lintstagedrc", ".lintstagedrc*", "lint-staged.config.*"),
  ...named("nodemon", "nodemon.json"),
  ...named("pm2", "ecosystem.config.*"),
  ...named("drizzle-orm", "drizzle.config.*"),
  ...named("knex", "knexfile.*"),
  ...named("sequelize", ".sequelizerc"),
  ...named("svelteconfig", "svelte.config.*"),
  ...named("astroconfig", "astro.config.*"),
  ...named("next", "next.config.*", "next-env.d.ts"),
  ...named("nuxt", "nuxt.config.*", ".nuxtrc", ".nuxtignore"),
  ...named("vueconfig", "vue.config.*"),
  ...named("angular", "angular.json", ".angular-cli.json"),
  ...named("nestjs", "nest-cli.json"),
  // Containers, hosting and CI.
  ...named("docker", "Dockerfile*", "*.dockerfile", "docker-compose*", "compose.yaml", "compose.yml", ".dockerignore"),
  ...named("procfile", "Procfile"),
  ...named("vercel", "vercel.json"),
  ...named("netlify", "netlify.toml"),
  ...named("firebase", "firebase.json", ".firebaserc"),
  ...named("caddy", "Caddyfile"),
  ...named("nginx", "nginx.conf"),
  ...named("apache", ".htaccess"),
  ...named("jenkins", "Jenkinsfile"),
  ...named("travis", ".travis.yml"),
  // Before `.git*`, which would otherwise claim both.
  ...named("gitlab", ".gitlab-ci.yml"),
  ...named("gitpod", ".gitpod.yml"),
  ...named("azurepipelines", "azure-pipelines.yml"),
  ...named("bitbucketpipeline", "bitbucket-pipelines.yml"),
  ...named("helm", "Chart.yaml"),
  ...named("vagrant", "Vagrantfile"),
  ...named("makefile", "Makefile", "*.mk"),
  ...named("cmake", "CMakeLists.txt"),
  ...named("brew", "Brewfile"),
  ...named("taskfile", "Taskfile.yml", "Taskfile.yaml"),
  ...named("just", "justfile"),
  // The repository itself.
  ...named("git", ".git*"),
  ...named("codeowners", "CODEOWNERS"),
  ...named("license", "LICENSE*", "LICENCE*", "COPYING*"),
  ...named("renovate", "renovate.json", ".renovaterc*"),
  ...named("dependabot", "dependabot.yml"),
  ...named("codecov", "codecov.yml", ".codecov.yml"),
  ...named("dotenv", ".env", ".env.*", "*.env"),
  ...named("devcontainer", "devcontainer.json", ".devcontainer.json"),
  ...named("vscode", "*.code-workspace"),
  ...named("robots", "robots.txt"),
  ...named("sitemap", "sitemap.xml"),
  ...named("humanstxt", "humans.txt"),
  ...named("favicon", "favicon.ico"),
  ...named("manifest", "manifest.json", "*.webmanifest"),
  // Other ecosystems' manifests and lockfiles.
  ...named("cargo", "Cargo.toml", "Cargo.lock"),
  ...named("rust-toolchain", "rust-toolchain*"),
  ...named("go-package", "go.mod", "go.sum"),
  ...named("go-work", "go.work"),
  ...named("bundler", "Gemfile", "Gemfile.lock"),
  ...named("rake", "Rakefile"),
  ...named("rubocop", ".rubocop.yml"),
  ...named("composer", "composer.json", "composer.lock"),
  ...named("phpunit", "phpunit.xml*"),
  ...named("maven", "pom.xml", "mvnw*"),
  ...named("gradle", "build.gradle*", "settings.gradle*", "gradle.properties", "gradlew*"),
  ...named("flutter-package", "pubspec.yaml", "pubspec.lock"),
  ...named("dartlang", "analysis_options.yaml"),
  ...named("pip", "requirements.txt", "requirements.in", "requirements-*", "Pipfile", "Pipfile.lock"),
  ...named("pythonconfig", "pyproject.toml", "setup.py", "setup.cfg"),
  ...named("poetry", "poetry.lock"),
  ...named("uv", "uv.lock"),
  ...named("pdm", "pdm.lock"),
  ...named("pyenv", ".python-version"),
  ...named("pytest", "pytest.ini", "conftest.py", "*_test.py"),
  ...named("tox", "tox.ini"),
  ...named("mypy", "mypy.ini", ".mypy.ini"),
  ...named("ruff", "ruff.toml", ".ruff.toml"),
  ...named("pytyped", "py.typed"),
  ...named("nuget", "nuget.config", "packages.config"),
  // Tests, stories and declarations — compound suffixes, ahead of their plain extensions.
  ...named("testts", "*.spec.ts", "*.test.ts", "*.spec.tsx", "*.test.tsx", "*.e2e-spec.ts", "*.e2e.ts"),
  ...named("testjs", "*.spec.js", "*.test.js", "*.spec.jsx", "*.test.jsx", "*.spec.mjs", "*.test.mjs"),
  ...named("cypress-spec", "*.cy.*"),
  ...named("storybook", "*.stories.*"),
  ...named("jest-snapshot", "*.snap"),
  ...named("typescriptdef", "*.d.ts", "*.d.mts", "*.d.cts"),
  ...named("blade", "*.blade.php"),
];

const GENERAL_EXTENSIONS: Row[] = [
  // Web.
  ...ext("typescript", "ts", "mts", "cts"),
  ...ext("reactts", "tsx"),
  ...ext("js", "js", "mjs", "cjs"),
  ...ext("reactjs", "jsx"),
  ...ext("json", "json", "jsonc", "jsonl", "ndjson"),
  ...ext("json5", "json5"),
  ...ext("markdown", "md", "markdown"),
  ...ext("mdx", "mdx"),
  ...ext("html", "html", "htm", "xhtml"),
  ...ext("css", "css"),
  ...ext("scss", "scss"),
  ...ext("sass", "sass"),
  ...ext("less", "less"),
  ...ext("stylus", "styl"),
  ...ext("postcss", "pcss", "postcss"),
  ...ext("vue", "vue"),
  ...ext("svelte", "svelte"),
  ...ext("astro", "astro"),
  ...ext("graphql", "graphql", "gql"),
  ...ext("handlebars", "hbs", "handlebars"),
  ...ext("ejs", "ejs"),
  ...ext("pug", "pug", "jade"),
  ...ext("nunjucks", "njk"),
  ...ext("liquid", "liquid"),
  ...ext("mustache", "mustache"),
  ...ext("wasm", "wasm", "wat"),
  ...ext("map", "map"),
  // Backend and systems languages.
  ...ext("python", "py", "pyw", "pyi"),
  ...ext("jupyter", "ipynb"),
  ...ext("jinja", "j2", "jinja", "jinja2"),
  ...ext("java", "java"),
  ...ext("class", "class"),
  ...ext("jar", "jar", "war", "ear"),
  ...ext("kotlin", "kt", "kts"),
  ...ext("groovy", "groovy"),
  ...ext("gradle", "gradle"),
  ...ext("scala", "scala", "sc"),
  ...ext("jsp", "jsp"),
  ...ext("csharp", "cs", "csx"),
  ...ext("csproj", "csproj"),
  ...ext("sln", "sln", "slnx"),
  ...ext("razor", "cshtml", "razor"),
  ...ext("xaml", "xaml", "axaml"),
  ...ext("fsharp", "fs", "fsx", "fsi"),
  ...ext("fsproj", "fsproj"),
  ...ext("vb", "vb"),
  ...ext("vbproj", "vbproj"),
  ...ext("nuget", "nupkg", "nuspec"),
  ...ext("go", "go"),
  ...ext("rust", "rs"),
  ...ext("ruby", "rb", "gemspec"),
  ...ext("erb", "erb"),
  ...ext("php", "php"),
  ...ext("twig", "twig"),
  ...ext("swift", "swift"),
  ...ext("objectivecpp", "mm"),
  ...ext("dartlang", "dart"),
  ...ext("c", "c"),
  ...ext("cheader", "h"),
  ...ext("cpp", "cpp", "cc", "cxx", "c++"),
  ...ext("cppheader", "hpp", "hh", "hxx"),
  ...ext("lua", "lua"),
  ...ext("r", "r"),
  ...ext("julia", "jl"),
  ...ext("elixir", "ex", "exs"),
  ...ext("erlang", "erl", "hrl"),
  ...ext("haskell", "hs"),
  ...ext("clojure", "clj", "cljs", "cljc", "edn"),
  ...ext("elm", "elm"),
  ...ext("zig", "zig"),
  ...ext("nim", "nim"),
  ...ext("perl", "pl", "pm"),
  ...ext("ocaml", "ml"),
  ...ext("solidity", "sol"),
  ...ext("assembly", "asm", "s"),
  ...ext("shell", "sh", "bash", "zsh", "fish"),
  ...ext("powershell", "ps1", "psm1", "psd1"),
  ...ext("bat", "bat", "cmd"),
  // Data and schemas.
  ...ext("sql", "sql"),
  ...ext("pgsql", "pgsql"),
  ...ext("sqlite", "sqlite", "sqlite3", "db"),
  ...ext("prisma", "prisma"),
  ...ext("dbml", "dbml"),
  ...ext("protobuf", "proto"),
  ...ext("yaml", "yml", "yaml"),
  ...ext("toml", "toml"),
  ...ext("xml", "xml", "xsd", "plist", "resx", "props", "targets"),
  ...ext("xsl", "xsl", "xslt"),
  ...ext("ini", "ini", "cfg"),
  ...ext("config", "conf", "config", "properties"),
  ...ext("http", "http"),
  ...ext("rest", "rest"),
  // Infrastructure.
  ...ext("terraform", "tf", "tfvars"),
  ...ext("hashicorp", "hcl"),
  ...ext("nix", "nix"),
  ...ext("bicep", "bicep"),
  // Media and documents.
  ...ext("svg", "svg"),
  ...ext("image", "png", "jpg", "jpeg", "gif", "bmp", "ico", "tif", "tiff", "heic"),
  ...ext("webp", "webp"),
  ...ext("avif", "avif"),
  ...ext("photoshop", "psd"),
  ...ext("ai", "ai"),
  ...ext("sketch", "sketch"),
  ...ext("font", "woff", "woff2", "ttf", "otf", "eot"),
  ...ext("pdf2", "pdf"),
  ...ext("zip", "zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"),
  ...ext("audio", "mp3", "wav", "ogg", "flac", "m4a", "aac"),
  ...ext("video", "mp4", "mov", "webm", "avi", "mkv"),
  ...ext("excel", "xlsx", "xls", "csv", "tsv"),
  ...ext("word", "docx", "doc"),
  ...ext("powerpoint", "pptx", "ppt"),
  ...ext("drawio", "drawio"),
  ...ext("excalidraw", "excalidraw"),
  ...ext("mermaid", "mmd", "mermaid"),
  ...ext("plantuml", "puml", "plantuml"),
  ...ext("graphviz", "dot", "gv"),
  ...ext("tex", "tex"),
  ...ext("text", "txt"),
  ...ext("log", "log"),
  // Everything else a tree turns up.
  ...ext("bak", "bak"),
  ...ext("patch", "patch"),
  ...ext("diff", "diff"),
  ...ext("cert", "pem", "crt", "cer"),
  ...ext("key", "key"),
  ...ext("gpg", "gpg"),
  ...ext("binary", "exe", "dll", "so", "dylib", "bin"),
  ...ext("vsix", "vsix"),
];

/** General's folders and named files — everything ahead of the plain extensions. */
const GENERAL_NAMES: IconRule[] = rows("g", [...GENERAL_FOLDERS, ...GENERAL_NAMED_FILES]);
const GENERAL_EXTENSION_RULES: IconRule[] = rows("g", GENERAL_EXTENSIONS);

/** The General pack's rules: its folders, then its named files, then the extensions. */
export const GENERAL_RULES: IconRule[] = [...GENERAL_NAMES, ...GENERAL_EXTENSION_RULES];

// ---------------------------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------------------------

const ng = drawn("angular");

/**
 * What `ng generate` writes, what NgRx adds, and the folders they are filed in — each kind with the
 * shield in its colour and its emblem. Tests are here and not left to General, whose flask is the same
 * for every stack.
 */
const ANGULAR: Row[] = [
  ...ng.files("main", "main.ts", "main.server.ts"),
  ...ng.files("config", "app.config.ts", "app.config.server.ts", "environment*"),
  ["ngsw-config.json", "angular"],
  ["proxy.conf.*", "config"],
  // `*.e2e-spec.ts` is not caught by `*.spec.ts` — a dash, not a dot.
  ...ng.files("e2e", "*.e2e-spec.ts", "*.e2e.ts"),
  ...ng.files("spec", "*.spec.ts", "*.test.ts"),
  ...ng.files("component", "*.component.ts"),
  ...ng.files("template", "*.component.html"),
  ...ng.files("style", "*.component.scss", "*.component.sass", "*.component.less", "*.component.css"),
  ...ng.files("service", "*.service.ts"),
  // Above `*.module.ts`, because a routing module ends in it too.
  ...ng.files("route", "*-routing.module.ts", "*.routes.ts", "*.resolver.ts"),
  ...ng.files("module", "*.module.ts"),
  ...ng.files("directive", "*.directive.ts"),
  ...ng.files("pipe", "*.pipe.ts"),
  ...ng.files("guard", "*.guard.ts"),
  ...ng.files("interceptor", "*.interceptor.ts"),
  ...ng.files("validator", "*.validator.ts", "*.validators.ts"),
  ...ng.files("token", "*.token.ts", "*.tokens.ts"),
  ...ng.files("provider", "*.provider.ts", "*.providers.ts"),
  // NgRx, and the signal and component stores.
  ...ng.files("action", "*.actions.ts"),
  ...ng.files("reducer", "*.reducer.ts"),
  ...ng.files("effect", "*.effects.ts"),
  ...ng.files("selector", "*.selectors.ts"),
  ...ng.files("store", "*.store.ts", "*.state.ts", "*.facade.ts"),
  // Contracts — an Angular `*.model.ts` is almost always an interface, not an ORM entity.
  ...ng.files("interface", "*.model.ts", "*.interface.ts", "*.types.ts", "*.type.ts"),
  ...ng.files("enum", "*.enum.ts"),
  ...ng.files("constants", "constants.ts", "*.constants.ts"),
  ...ng.files("util", "*.util.ts", "*.utils.ts", "*.helper.ts", "*.helpers.ts"),
  // The folders. `shared/`, `core/`, `pages/` and `environments/` keep General's.
  ...ng.dirs("component", "components"),
  ...ng.dirs("service", "services"),
  ...ng.dirs("module", "modules"),
  ...ng.dirs("guard", "guards"),
  ...ng.dirs("interceptor", "interceptors"),
  ...ng.dirs("pipe", "pipes"),
  ...ng.dirs("directive", "directives"),
  ...ng.dirs("validator", "validators"),
  ...ng.dirs("route", "resolvers", "routes"),
  ...ng.dirs("store", "store", "state", "+state"),
  ...ng.dirs("interface", "models", "interfaces"),
  ...ng.dirs("enum", "enums"),
];

/** `registerAs` and friends are `database.config.ts`; so is `vitest.config.ts`, which is Vitest's. Read
 * after General's named files, so every tool's config keeps its own glyph and only the rest are the
 * framework's. One row per framework that draws config files. */
const lateConfig = (framework: string): Row[] => drawn(framework).files("config", "*.config.ts");

const react = drawn("react");

/**
 * React's kinds, each with the atom in its colour and its emblem — and every `.tsx`/`.jsx` a
 * component, since that is what they are in a React tree. Everything more specific comes first, or
 * the component rule would claim it: tests, stories, contexts, providers, stores, styles.
 *
 * **Hooks are only `use-*`.** The camel-case `useAuth.ts` is the usual name, but a rule is a prefix
 * and case-blind, so `use*` would claim `UserCard.tsx` and `users.ts` too — a hook icon on every user
 * file is worse than none. `hooks/` is drawn as hooks either way.
 */
const REACT: Row[] = [
  ["components.json", "shadcn"],
  ["craco.config.*", "craco"],
  ["react-router.config.*", "reactrouter"],
  ...react.files("main", "main.tsx", "main.jsx"),
  ...react.files("route", "routes.tsx", "routes.ts", "router.tsx", "router.ts", "*.routes.tsx", "*.routes.ts"),
  ...react.files("spec", "*.test.tsx", "*.spec.tsx", "*.test.jsx", "*.spec.jsx", "*.test.ts", "*.spec.ts", "*.test.js", "*.spec.js"),
  // General's, repeated here so the component rule below does not claim them.
  ["*.stories.*", "storybook"],
  ["*.cy.*", "cypress-spec"],
  ...react.files("hook", "use-*", "*.hook.ts", "*.hooks.ts", "*.hook.tsx"),
  ...react.files("context", "*context.tsx", "*context.ts"),
  ...react.files("provider", "*provider.tsx"),
  ...react.files("store", "*store.ts", "*store.tsx", "*slice.ts"),
  ...react.files("reducer", "*reducer.ts"),
  ...react.files("action", "*actions.ts"),
  ...react.files("selector", "*selectors.ts"),
  ...react.files("query", "*.queries.ts", "*.query.ts"),
  ...react.files("api", "*.api.ts", "*.client.ts"),
  ...react.files("service", "*.service.ts"),
  ...react.files("style", "*.styles.ts", "*.styled.ts", "*.styled.tsx", "*.css.ts"),
  ...react.files("validator", "*.schema.ts", "*.schemas.ts"),
  ...react.files("interface", "*.types.ts", "*.type.ts", "*.interface.ts"),
  ...react.files("enum", "*.enum.ts"),
  ...react.files("constants", "constants.ts", "*.constants.ts"),
  ...react.files("util", "*.util.ts", "*.utils.ts", "*.helper.ts", "*.helpers.ts"),
  ...react.files("component", "*.tsx", "*.jsx"),
  ...react.dirs("component", "components"),
  ...react.dirs("hook", "hooks"),
  ...react.dirs("context", "context", "contexts"),
  ...react.dirs("provider", "providers"),
  ...react.dirs("store", "store", "stores", "slices", "redux", "state"),
  ...react.dirs("api", "api"),
  ...react.dirs("service", "services"),
  ...react.dirs("route", "routes", "router"),
  ...react.dirs("style", "styles"),
];

/** The App Router's reserved file names, and its route-segment folders. */
const NEXT: Row[] = [
  ["middleware.ts", "next"],
  ["middleware.js", "next"],
  ["instrumentation.ts", "next"],
  ["instrumentation.js", "next"],
  ["layout.tsx", "layout"],
  ["layout.jsx", "layout"],
  ["layout.js", "layout"],
  ["template.tsx", "reacttemplate"],
  ["template.jsx", "reacttemplate"],
  ["route.ts", "rest"],
  ["route.js", "rest"],
  ["sitemap.ts", "sitemap"],
  ["robots.ts", "robots"],
  ["manifest.ts", "manifest"],
  ["opengraph-image.*", "image"],
  ["twitter-image.*", "image"],
  // `[slug]`, `[...all]` and `(group)`: a dynamic segment and a route group are both routing.
  ["[*/", "route"],
  ["(*/", "route"],
  ...REACT,
];

const vue = drawn("vue");

/** Vue's and Nuxt's kinds, with the V in each kind's colour. Composables are `use-*` only, for the
 * reason React's hooks are. */
const VUE: Row[] = [
  ["app.config.ts", "nuxt"],
  ["nuxt.schema.ts", "nuxt"],
  ...vue.files("main", "main.ts", "main.js"),
  ...vue.files("e2e", "*.e2e-spec.ts", "*.e2e.ts"),
  ...vue.files("spec", "*.spec.ts", "*.test.ts", "*.spec.js", "*.test.js"),
  ["*.stories.*", "storybook"],
  ...vue.files("component", "*.vue"),
  ...vue.files("composable", "use-*", "*.composable.ts"),
  ...vue.files("store", "*store.ts", "*store.js"),
  ...vue.files("route", "router.ts", "router.js", "routes.ts", "routes.js", "*.routes.ts"),
  ...vue.files("plugin", "*.plugin.ts"),
  ...vue.files("directive", "*.directive.ts"),
  // Nuxt: `auth.global.ts` is route middleware; `users.get.ts` a server route.
  ...vue.files("middleware", "*.global.ts", "*.middleware.ts"),
  ...vue.files("api", "*.get.ts", "*.post.ts", "*.put.ts", "*.patch.ts", "*.delete.ts"),
  ...vue.files("service", "*.service.ts"),
  ...vue.files("validator", "*.schema.ts"),
  ...vue.files("interface", "*.types.ts", "*.type.ts", "*.interface.ts"),
  ...vue.files("enum", "*.enum.ts"),
  ...vue.files("constants", "constants.ts", "*.constants.ts"),
  ...vue.files("util", "*.util.ts", "*.utils.ts", "*.helper.ts", "*.helpers.ts"),
  ...vue.dirs("component", "components"),
  ...vue.dirs("composable", "composables"),
  ...vue.dirs("store", "stores", "store"),
  ...vue.dirs("route", "router", "routes"),
  ...vue.dirs("plugin", "plugins"),
  ...vue.dirs("directive", "directives"),
  ...vue.dirs("middleware", "middleware"),
  ...vue.dirs("service", "services"),
  ...vue.dirs("api", "api"),
];

const bun = drawn("bun");

/**
 * A Bun project — a server on Bun, a CLI, a library — with the bun in each kind's colour. The lockfile
 * and `bunfig.toml` are General's (every pack draws them as Bun's). `index.ts`, which `bun init`
 * makes the entry, is left alone: the same name is every folder's barrel.
 */
const BUN: Row[] = [
  ...bun.files("interface", "bun-env.d.ts", "bun.d.ts", "*.types.ts", "*.type.ts"),
  ...bun.files("main", "main.ts"),
  ...bun.files("server", "server.ts", "*.server.ts"),
  ...bun.files("build", "build.ts", "build.js", "*.build.ts"),
  ...bun.files("macro", "*.macro.ts"),
  ...bun.files("spec", "*.test.ts", "*.spec.ts", "*.test.tsx", "*.test.js", "*.spec.js"),
  ...bun.files("route", "routes.ts", "*.routes.ts", "*.route.ts"),
  ...bun.files("controller", "*.controller.ts"),
  ...bun.files("middleware", "*.middleware.ts"),
  ...bun.files("plugin", "*.plugin.ts"),
  ...bun.files("worker", "*.worker.ts"),
  ...bun.files("service", "*.service.ts"),
  ...bun.files("validator", "*.schema.ts"),
  ...bun.files("constants", "constants.ts", "*.constants.ts"),
  ...bun.files("util", "*.util.ts", "*.utils.ts"),
  ...bun.dirs("route", "routes"),
  ...bun.dirs("controller", "controllers"),
  ...bun.dirs("middleware", "middleware", "middlewares"),
  ...bun.dirs("plugin", "plugins"),
  ...bun.dirs("worker", "workers"),
  ...bun.dirs("service", "services"),
];

const nest = drawn("nest");

/**
 * Every kind of file a Nest project is made of, each with a glyph of its own: what `nest generate`
 * writes, what TypeORM, Mongoose, Passport, CQRS and Bull add to it, and the folders they are filed
 * in. Tests are here and not left to General because General's are the same flask for every stack —
 * the point of this pack is a tree that reads as Nest.
 */
const NEST: Row[] = [
  ...nest.files("main", "main.ts"),
  ...named("jest", "jest-e2e.json"),
  // `nest new` writes `app.e2e-spec.ts` under `test/`. Not caught by `*.spec.ts` — a dash, not a dot.
  ...nest.files("e2e", "*.e2e-spec.ts", "*.e2e-test.ts", "*.e2e.ts"),
  ...nest.files("spec", "*.spec.ts", "*.test.ts"),
  // What `nest generate` writes.
  ...nest.files("module", "*.module.ts"),
  ...nest.files("controller", "*.controller.ts"),
  ...nest.files("service", "*.service.ts"),
  ...nest.files("provider", "*.provider.ts", "*.providers.ts"),
  ...nest.files("guard", "*.guard.ts"),
  ...nest.files("strategy", "*.strategy.ts"),
  ...nest.files("pipe", "*.pipe.ts"),
  ...nest.files("filter", "*.filter.ts"),
  ...nest.files("interceptor", "*.interceptor.ts"),
  ...nest.files("middleware", "*.middleware.ts"),
  ...nest.files("decorator", "*.decorator.ts", "*.decorators.ts"),
  ...nest.files("gateway", "*.gateway.ts"),
  ...nest.files("resolver", "*.resolver.ts"),
  ...nest.files("adapter", "*.adapter.ts"),
  // Data.
  ...nest.files("repository", "*.repository.ts"),
  ...nest.files("entity", "*.entity.ts", "*.model.ts"),
  ...nest.files("schema", "*.schema.ts"),
  ...nest.files("seed", "*.seed.ts", "*.seeder.ts"),
  // Contracts and types — GraphQL's inputs and args are DTOs by another name.
  ...nest.files("dto", "*.dto.ts", "*.input.ts", "*.args.ts", "*.payload.ts", "*.request.ts", "*.response.ts"),
  ...nest.files("interface", "*.interface.ts", "*.interfaces.ts", "*.types.ts", "*.type.ts"),
  ...nest.files("enum", "*.enum.ts", "*.enums.ts"),
  ...nest.files("mapper", "*.mapper.ts", "*.serializer.ts"),
  // Events, CQRS and background work.
  ...nest.files("event", "*.event.ts", "*.events.ts"),
  ...nest.files("listener", "*.listener.ts", "*.handler.ts", "*.subscriber.ts"),
  ...nest.files("command", "*.command.ts"),
  ...nest.files("query", "*.query.ts"),
  ...nest.files("processor", "*.processor.ts", "*.consumer.ts", "*.queue.ts", "*.job.ts"),
  ...nest.files("task", "*.task.ts", "*.tasks.ts", "*.cron.ts", "*.scheduler.ts"),
  ...nest.files("health", "*.health.ts"),
  // Everything around them.
  ...nest.files("exception", "*.exception.ts", "*.error.ts"),
  ...nest.files("factory", "*.factory.ts"),
  ...nest.files("constants", "constants.ts", "*.constants.ts", "*.constant.ts"),
  ...nest.files("util", "*.util.ts", "*.utils.ts", "*.helper.ts", "*.helpers.ts"),
  ...nest.files("config", "configuration.ts", "config.ts"),
  // The folders they live in. `config/`, `utils/`, `common/` and `test/` keep General's.
  ...nest.dirs("module", "modules"),
  ...nest.dirs("controller", "controllers"),
  ...nest.dirs("service", "services"),
  ...nest.dirs("provider", "providers"),
  ...nest.dirs("guard", "guards"),
  ...nest.dirs("strategy", "strategies"),
  ...nest.dirs("pipe", "pipes"),
  ...nest.dirs("filter", "filters"),
  ...nest.dirs("interceptor", "interceptors"),
  ...nest.dirs("middleware", "middleware", "middlewares"),
  ...nest.dirs("decorator", "decorators"),
  ...nest.dirs("gateway", "gateways"),
  ...nest.dirs("resolver", "resolvers"),
  ...nest.dirs("adapter", "adapters"),
  ...nest.dirs("repository", "repositories", "repository"),
  ...nest.dirs("entity", "entities", "entity", "models"),
  ...nest.dirs("schema", "schemas", "schema"),
  ...nest.dirs("seed", "seeds", "seeders", "seed"),
  ...nest.dirs("dto", "dto", "dtos"),
  ...nest.dirs("interface", "interfaces"),
  ...nest.dirs("enum", "enums"),
  ...nest.dirs("mapper", "mappers"),
  ...nest.dirs("event", "events"),
  ...nest.dirs("listener", "listeners", "handlers", "subscribers"),
  ...nest.dirs("command", "commands"),
  ...nest.dirs("query", "queries"),
  ...nest.dirs("processor", "processors", "queues", "consumers", "jobs"),
  ...nest.dirs("task", "tasks", "cron", "schedulers"),
  ...nest.dirs("health", "health"),
  ...nest.dirs("exception", "exceptions", "errors"),
  ...nest.dirs("factory", "factories"),
  ...nest.dirs("constants", "constants"),
];



const SPRING: Row[] = [
  ["application.properties", "config"],
  ["application.yml", "config"],
  ["application.yaml", "config"],
  ["application-*", "config"],
  ["bootstrap.properties", "config"],
  ["bootstrap.yml", "config"],
  ["bootstrap.yaml", "config"],
  ["lombok.config", "config"],
  ["logback*", "log"],
  ["log4j*", "log"],
  ["schema.sql", "db"],
  ["data.sql", "db"],
  ["*Controller.java", "rest"],
  ["*Controller.kt", "rest"],
  ["*Repository.java", "db"],
  ["*Repository.kt", "db"],
  ["*Configuration.java", "config"],
  ["*Config.java", "config"],
  ["*Configuration.kt", "config"],
  ["*Config.kt", "config"],
  ["*Tests.java", "test"],
  ["*Test.java", "test"],
  ["*Tests.kt", "test"],
  ["*Test.kt", "test"],
  ["repository/", "db"],
  ["repositories/", "db"],
  ["dao/", "db"],
  ["kotlin/", "kotlin"],
];

const DOTNET: Row[] = [
  ["appsettings*", "config"],
  ["launchSettings.json", "config"],
  ["Directory.Build.props", "config"],
  ["Directory.Build.targets", "config"],
  ["Directory.Packages.props", "nuget"],
  ["dotnet-tools.json", "nuget"],
  ["*.runsettings", "config"],
  ["*Controller.cs", "rest"],
  ["*Repository.cs", "db"],
  ["*DbContext.cs", "db"],
  ["*Tests.cs", "test"],
  ["*Test.cs", "test"],
  ["Data/", "db"],
  ["Repositories/", "db"],
  ["Properties/", "config"],
  ["Hubs/", "server"],
  ["Areas/", "module"],
  ["TestResults/", "coverage"],
];

/** Shared by the two Python packs: `test_*.py` is pytest's convention, safe to claim there and
 * nowhere else — in General it would put pytest on a `test_data.json`. */
const PYTHON_TESTS: Row[] = [
  ["test_*", "pytest"],
  ["tests/", "pytest"],
  ["test/", "pytest"],
];

const FASTAPI: Row[] = [
  ["schemas.py", "json-schema"],
  ["models.py", "db"],
  ["database.py", "db"],
  ["db.py", "db"],
  ["crud.py", "db"],
  ["config.py", "config"],
  ["settings.py", "config"],
  ["alembic.ini", "db"],
  ["crud/", "db"],
  ["alembic/", "db"],
  ["schemas/", "interfaces"],
  ...PYTHON_TESTS,
];

const DJANGO: Row[] = [
  ["manage.py", "django"],
  ["settings.py", "django"],
  ["urls.py", "django"],
  ["wsgi.py", "django"],
  ["asgi.py", "django"],
  ["apps.py", "django"],
  ["admin.py", "django"],
  ["models.py", "db"],
  ["views.py", "view"],
  ["serializers.py", "json-schema"],
  ["tests.py", "pytest"],
  ["templatetags/", "template"],
  ["management/", "tools"],
  ...PYTHON_TESTS,
];

const LARAVEL: Row[] = [
  ["artisan", "php"],
  ["webpack.mix.js", "webpack"],
  ["*Controller.php", "rest"],
  ["*Test.php", "phpunit"],
  ["*Seeder.php", "db"],
  ["*_table.php", "db"],
  ["vendor/", "composer"],
  ["factories/", "db"],
  ["storage/", "temp"],
  ["bootstrap/", "config"],
  ["Http/", "api"],
  ["Mail/", "notification"],
  ["Policies/", "private"],
];

/**
 * A framework's rules first, then every General rule it did not already claim — the same target,
 * kind and pattern would be a duplicate the panel flags as "never applies".
 *
 * `late` rows go between General's named files and its plain extensions: a suffix broad enough to
 * claim a well-known name (`*.config.ts` and `vite.config.ts`) has to come after that name to lose it.
 */
function pack(prefix: string, specific: readonly Row[], late: readonly Row[] = []): IconRule[] {
  const own = rows(prefix, specific);
  const after = rows(prefix, late);
  const unclaimed = (rule: IconRule) => ![...own, ...after].some((mine) => sameRuleTarget(mine, rule));
  return [...own, ...GENERAL_NAMES.filter(unclaimed), ...after, ...GENERAL_EXTENSION_RULES.filter(unclaimed)];
}

export interface ShippedPack {
  id: string;
  name: string;
  rules: IconRule[];
}

/**
 * Every pack, in the order the selector lists them: General first — it is the fallback when a
 * repository's stack is not recognised — then the frontends, then the backends.
 *
 * The ids of the first three are the ones an existing install already stores (`base`, `angular`,
 * `nestjs`), so upgrading replaces those lists in place instead of adding a second Angular.
 */
export const SHIPPED_PACKS: ShippedPack[] = [
  { id: "base", name: "General", rules: GENERAL_RULES },
  { id: "angular", name: "Angular", rules: pack("ng", ANGULAR, lateConfig("angular")) },
  { id: "react", name: "React", rules: pack("react", REACT, lateConfig("react")) },
  { id: "nextjs", name: "Next.js", rules: pack("next", NEXT, lateConfig("react")) },
  { id: "vue", name: "Vue / Nuxt", rules: pack("vue", VUE, lateConfig("vue")) },
  { id: "nestjs", name: "NestJS", rules: pack("nest", NEST, lateConfig("nest")) },
  { id: "bun", name: "Bun", rules: pack("bun", BUN, lateConfig("bun")) },
  { id: "spring", name: "Spring Boot", rules: pack("spring", SPRING) },
  { id: "dotnet", name: ".NET", rules: pack("dotnet", DOTNET) },
  { id: "fastapi", name: "FastAPI", rules: pack("fastapi", FASTAPI) },
  { id: "django", name: "Django", rules: pack("django", DJANGO) },
  { id: "laravel", name: "Laravel", rules: pack("laravel", LARAVEL) },
];

/**
 * Four glyphs that say what a pack is at a glance, for the icon panel's rows. Hand-picked for the
 * shipped packs — the first rules of Angular are four near-identical component variants, which would
 * say "Angular" four times and nothing else.
 */
const PREVIEWS: Record<string, string[]> = {
  base: ["typescript", "python", "go", "docker"],
  angular: ["cf:angular-component", "cf:angular-service", "cf:angular-module", "cf:angular-pipe"],
  react: ["cf:react-component", "cf:react-hook", "cf:react-context", "cf:react-spec"],
  nextjs: ["next", "cf:react-component", "layout", "rest"],
  vue: ["cf:vue-component", "cf:vue-composable", "cf:vue-store", "cf:vue-route"],
  nestjs: ["cf:nest-controller", "cf:nest-service", "cf:nest-module", "cf:nest-guard"],
  bun: ["cf:bun-server", "cf:bun-spec", "cf:bun-build", "cf:bun-lockfile"],
  spring: ["java", "maven", "rest", "config"],
  dotnet: ["csharp", "csproj", "razor", "nuget"],
  fastapi: ["python", "pytest", "json-schema", "pip"],
  django: ["django", "python", "db", "pytest"],
  laravel: ["php", "blade", "composer", "phpunit"],
};

/** The preview for any profile: the shipped pick, or — for one the user wrote — the first four
 * different file glyphs its rules draw. Catalogue ids, ready for `IconGlyph`. A pick is a
 * vscode-icons file-type name, or a full id when the glyph is this repo's own. */
export function previewIcons(profile: { id: string; rules: IconRule[] }): string[] {
  const picked = PREVIEWS[profile.id];
  if (picked) return picked.map((name) => (name.includes(":") ? name : `vscode-icons:file-type-${name}`));
  const seen = new Set<string>();
  for (const rule of profile.rules) {
    if (rule.target !== "file" || !rule.enabled || seen.has(rule.icon)) continue;
    seen.add(rule.icon);
    if (seen.size === 4) break;
  }
  return [...seen];
}
