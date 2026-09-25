const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  cs: "csharp",
  // clangd and lua-language-server claim these; without a mapping nothing would ever be routed to
  // them. Monaco ships a grammar for all of them, so highlighting comes along for free.
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  lua: "lua",
  // Two ids because the two dialects have different top levels — a class body is declarations, a
  // routine is statements. `.cls` deliberately displaces Monaco's Apex claim on the extension; every
  // editor in the app passes `language` explicitly, so which one wins is decided here and nowhere
  // else. See `monacoObjectScript`.
  cls: "objectscript-class",
  inc: "objectscript",
  mac: "objectscript",
  int: "objectscript",
  rb: "ruby",
  php: "php",
  sql: "sql",
  // Registered by `monacoDbml`, not shipped by Monaco. Mapping it here is what makes a `.dbml`
  // file open highlighted in the editor as well as in the Diagrams workspace's schema editor.
  dbml: "dbml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  xml: "xml",
  dockerfile: "dockerfile",
  // The rest of what Monaco ships a grammar for, by the extensions its own registrations name (see
  // `monaco-editor/esm/vs/languages/definitions/*/register.js`). Added when the Editor grew a status
  // line naming the language (2026-09-25): a `.kt` or a `.swift` used to open as plain text although
  // the highlighting was sitting right there. Deliberately left out where an extension means two
  // things — `.m` (Objective-C or MATLAB), `.v` (Verilog or V), `.ml` (F# claims OCaml's) — since a
  // wrong language is worse than none.
  htm: "html",
  xhtml: "html",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  markdown: "markdown",
  mdx: "mdx",
  jsonc: "json",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  less: "less",
  graphql: "graphql",
  gql: "graphql",
  ini: "ini",
  properties: "ini",
  gitconfig: "ini",
  editorconfig: "ini",
  gitattributes: "ini",
  env: "ini",
  bat: "bat",
  cmd: "bat",
  r: "r",
  pl: "perl",
  pm: "perl",
  dart: "dart",
  scala: "scala",
  sc: "scala",
  sbt: "scala",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  vb: "vb",
  proto: "proto",
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  jl: "julia",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  ex: "elixir",
  exs: "elixir",
  coffee: "coffeescript",
  cshtml: "razor",
  pug: "pug",
  jade: "pug",
  hbs: "handlebars",
  handlebars: "handlebars",
  liquid: "liquid",
  twig: "twig",
  tcl: "tcl",
  sv: "systemverilog",
  svh: "systemverilog",
  rst: "restructuredtext",
  scm: "scheme",
  wgsl: "wgsl",
  bicep: "bicep",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  xaml: "xml",
  csproj: "xml",
  zsh: "shell",
};

export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}

/**
 * Every language id this app can actually hand a file, sorted.
 *
 * Derived from the map above rather than from `monaco.languages.getLanguages()`, and the difference
 * is the whole point: Monaco knows about two hundred languages, but a file only ever *becomes* one
 * of these — so this is the vocabulary a snippet can usefully be scoped to, and anything outside it
 * can never match. Scoping is an exact string comparison (`snippetsFor`), so a plausible-looking id
 * from somewhere else silently does nothing: the shipped snippets carried `javascriptreact` and
 * `typescriptreact`, which are VS Code's ids for `.jsx`/`.tsx` and which this app never assigns —
 * it maps both onto `javascript` and `typescript`.
 */
// `plaintext` belongs in the list even though it is not in the map: `languageForPath` falls back to
// it for every extension the map does not name, so a snippet scoped to it does match — every README
// with no suffix, every `.env`, every dotfile. Leaving it out would mean flagging a correct scope as
// one that can never fire.
export const ASSIGNABLE_LANGUAGES: string[] = [...new Set([...Object.values(EXT_TO_LANGUAGE), "plaintext"])].sort();

/** Whether scoping a snippet to `id` can ever match a file this app opens. */
export function isAssignableLanguage(id: string): boolean {
  return ASSIGNABLE_LANGUAGES.includes(id);
}
