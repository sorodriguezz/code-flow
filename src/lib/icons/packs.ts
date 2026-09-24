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
 * pattern's own trailing slash decides. `packs.test.ts` checks that every one exists in the set and
 * that no rule is shadowed by one above it.
 *
 * Order inside a table is the matching order: exact names and prefixes before compound suffixes
 * (`*.d.ts`, `*.spec.ts`) before plain extensions, because the list is first-match-wins.
 */

type Row = readonly [pattern: string, icon: string];

function rows(prefix: string, table: readonly Row[]): IconRule[] {
  return table.map(([pattern, icon]) => {
    const parsed = parseIconPattern(pattern);
    const kind = parsed.target === "folder" ? "folder-type" : "file-type";
    return { id: `${prefix}:${pattern}`, ...parsed, icon: `vscode-icons:${kind}-${icon}`, enabled: true };
  });
}

/** Several extensions, one glyph. */
const ext = (icon: string, ...extensions: string[]): Row[] => extensions.map((e) => [`*.${e}`, icon]);
/** Several exact names (or patterns), one glyph. */
const named = (icon: string, ...patterns: string[]): Row[] => patterns.map((p) => [p, icon]);
/** Several folder names, one glyph. */
const dirs = (icon: string, ...names: string[]): Row[] => names.map((n) => [`${n}/`, icon]);

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
  ...named("bun", "bun.lockb", "bun.lock"),
  ...named("bunfig", "bunfig.toml"),
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

/** The General pack's rules: its folders, then its named files, then the extensions. */
export const GENERAL_RULES: IconRule[] = rows("g", [
  ...GENERAL_FOLDERS,
  ...GENERAL_NAMED_FILES,
  ...GENERAL_EXTENSIONS,
]);

// ---------------------------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------------------------

const ANGULAR: Row[] = [
  ["*.component.ts", "ng-component-ts"],
  ["*.component.html", "ng-component-html"],
  ["*.component.scss", "ng-component-scss"],
  ["*.component.sass", "ng-component-sass"],
  ["*.component.less", "ng-component-less"],
  ["*.component.css", "ng-component-css"],
  ["*.service.ts", "ng-service-ts"],
  // Above `*.module.ts`, because a routing module ends in it too.
  ["*-routing.module.ts", "ng-routing-ts"],
  ["*.routes.ts", "ng-routing-ts"],
  ["*.resolver.ts", "ng-routing-ts"],
  ["*.module.ts", "ng-module-ts"],
  ["*.directive.ts", "ng-directive-ts"],
  ["*.pipe.ts", "ng-pipe-ts"],
  ["*.guard.ts", "ng-guard-ts"],
  ["*.interceptor.ts", "ng-interceptor-ts"],
  ["app.config.ts", "angular"],
  ["ngsw-config.json", "angular"],
  ["proxy.conf.*", "config"],
  ["resolvers/", "route"],
];

/** What React adds to General — which already draws `.tsx`/`.jsx`, tests, stories and the tooling. */
const REACT: Row[] = [
  ["components.json", "shadcn"],
  ["craco.config.*", "craco"],
  ["react-router.config.*", "reactrouter"],
  ["routes.tsx", "reactrouter"],
  ["routes.ts", "reactrouter"],
  ["slices/", "redux"],
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

const VUE: Row[] = [
  ["app.config.ts", "nuxt"],
  ["nuxt.schema.ts", "nuxt"],
  ["directives/", "plugin"],
];

const NEST: Row[] = [
  ["*.controller.ts", "nest-controller-ts"],
  ["*.service.ts", "nest-service-ts"],
  ["*.module.ts", "nest-module-ts"],
  ["*.guard.ts", "nest-guard-ts"],
  ["*.strategy.ts", "nest-guard-ts"],
  ["*.pipe.ts", "nest-pipe-ts"],
  ["*.filter.ts", "nest-filter-ts"],
  ["*.interceptor.ts", "nest-interceptor-ts"],
  ["*.middleware.ts", "nest-middleware-ts"],
  ["*.gateway.ts", "nest-gateway-ts"],
  ["*.decorator.ts", "nest-decorator-ts"],
  ["*.adapter.ts", "nest-adapter-ts"],
  ["*.resolver.ts", "graphql"],
  ["*.entity.ts", "db"],
  ["*.repository.ts", "db"],
  ["*.schema.ts", "db"],
  ["*.dto.ts", "typescriptdef"],
  ["*.interface.ts", "typescriptdef"],
  ["main.ts", "nestjs"],
  ["repositories/", "db"],
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
 */
function pack(prefix: string, specific: readonly Row[]): IconRule[] {
  const own = rows(prefix, specific);
  return [...own, ...GENERAL_RULES.filter((rule) => !own.some((mine) => sameRuleTarget(mine, rule)))];
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
  { id: "angular", name: "Angular", rules: pack("ng", ANGULAR) },
  { id: "react", name: "React", rules: pack("react", REACT) },
  { id: "nextjs", name: "Next.js", rules: pack("next", NEXT) },
  { id: "vue", name: "Vue / Nuxt", rules: pack("vue", VUE) },
  { id: "nestjs", name: "NestJS", rules: pack("nest", NEST) },
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
  angular: ["ng-component-ts", "ng-service-ts", "ng-module-ts", "ng-pipe-ts"],
  react: ["reactts", "testts", "storybook", "vite"],
  nextjs: ["next", "reactts", "layout", "rest"],
  vue: ["vue", "nuxt", "vueconfig", "typescript"],
  nestjs: ["nest-controller-ts", "nest-service-ts", "nest-module-ts", "nest-guard-ts"],
  spring: ["java", "maven", "rest", "config"],
  dotnet: ["csharp", "csproj", "razor", "nuget"],
  fastapi: ["python", "pytest", "json-schema", "pip"],
  django: ["django", "python", "db", "pytest"],
  laravel: ["php", "blade", "composer", "phpunit"],
};

/** The preview for any profile: the shipped pick, or — for one the user wrote — the first four
 * different file glyphs its rules draw. Catalogue ids, ready for `IconGlyph`. */
export function previewIcons(profile: { id: string; rules: IconRule[] }): string[] {
  const picked = PREVIEWS[profile.id];
  if (picked) return picked.map((name) => `vscode-icons:file-type-${name}`);
  const seen = new Set<string>();
  for (const rule of profile.rules) {
    if (rule.target !== "file" || !rule.enabled || seen.has(rule.icon)) continue;
    seen.add(rule.icon);
    if (seen.size === 4) break;
  }
  return [...seen];
}
