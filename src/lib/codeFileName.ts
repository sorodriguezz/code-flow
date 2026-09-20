/**
 * What to call the file when somebody saves a code block out of an answer.
 *
 * A save dialog with no default name is a save dialog the user has to think about, and the two
 * things that would tell them what to type are both already on screen: the fence's language, and —
 * very often — a path the model wrote on the first line, because models comment their snippets with
 * where the code is supposed to go. This reads both and gets out of the way.
 *
 * Pure and exported on its own so the guessing is testable. The button that calls it lives in
 * `ChatMessageBubble`, injected into the DOM after DOMPurify has run — see the note there.
 */

/** Fence language (lowercased) to the extension it should be written with. */
const EXTENSIONS: Record<string, string> = {
  bash: "sh",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  cs: "cs",
  csharp: "cs",
  css: "css",
  csv: "csv",
  dart: "dart",
  dbml: "dbml",
  diff: "patch",
  go: "go",
  graphql: "graphql",
  groovy: "groovy",
  html: "html",
  ini: "ini",
  java: "java",
  javascript: "js",
  js: "js",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  kotlin: "kt",
  kt: "kt",
  lua: "lua",
  markdown: "md",
  md: "md",
  patch: "patch",
  perl: "pl",
  php: "php",
  proto: "proto",
  prisma: "prisma",
  python: "py",
  py: "py",
  r: "r",
  rb: "rb",
  ruby: "rb",
  rs: "rs",
  rust: "rs",
  scala: "scala",
  scss: "scss",
  sh: "sh",
  shell: "sh",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  tex: "tex",
  toml: "toml",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "sh",
};

/** The handful of languages whose file has a *name* rather than an extension. */
const NAMED: Record<string, string> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
};

/** Anything unrecognised, including a fence with no language at all. `.txt` and not no-extension:
 *  every platform's save dialog and every editor treats an extensionless file worse. */
const FALLBACK_EXTENSION = "txt";

/** What a saved block of this language is called, when its own first line does not say. */
export function extensionForLanguage(language: string | null): string {
  if (!language) return FALLBACK_EXTENSION;
  return EXTENSIONS[language.toLowerCase()] ?? FALLBACK_EXTENSION;
}

/**
 * A filename written as a comment on the first line, if that is what the first line is.
 *
 * Deliberately strict, because the cost of a false positive is a save dialog pre-filled with
 * nonsense from a line that was ordinary prose. Three rules do the work: the line must be *only*
 * the comment, the name must carry an extension that starts with a letter (so `# 1.5` and a
 * sentence ending in `this.` are not filenames), and only the last path segment is kept — a model
 * writing `// src/components/Card.tsx` is saying what the file is called, not where this user's
 * disk should put it.
 */
export function fileNameFromFirstLine(source: string): string | null {
  const first = source.split("\n", 1)[0] ?? "";
  const match = first.match(
    /^\s*(?:\/\/|#|--|;|\/\*|<!--)\s*([A-Za-z0-9_][\w./-]*\.[A-Za-z][A-Za-z0-9]{0,7})\s*(?:\*\/|-->)?\s*$/,
  );
  if (!match) return null;
  const name = match[1].split("/").pop() ?? "";
  // A trailing segment can still be empty (`// src/`) or absurdly long; neither is a filename.
  if (!name || name.length > 64) return null;
  return name;
}

/**
 * The name to put in the save dialog for one code block.
 *
 * The model's own first-line filename wins when there is one — it is the most specific thing
 * anybody knows about this snippet — and otherwise the language decides the extension on a generic
 * stem. `stem` is passed in rather than hardcoded so the caller owns the one user-visible word.
 */
/**
 * Formats with no comment syntax of their own.
 *
 * Deliberately a short, closed list rather than a guess. The naming line on the first row of a block
 * is a convention between the model and this app — the repo-less system prompt asks for it by name —
 * and in every language that *has* comments it is also valid content, so it stays: a Python file
 * whose first line is `# script.py` is a Python file with a comment, and silently deleting it would
 * make the save button disagree with what is on screen for no reason anyone could see.
 *
 * In these three it is not content. `# usuarios.csv` on top of a CSV is a broken CSV — a phantom
 * first row in every spreadsheet that opens it — and in JSON it is a parse error. So for these, and
 * only these, the line is metadata and comes off.
 */
const NO_COMMENT_SYNTAX = new Set(["csv", "tsv", "json"]);

/**
 * What actually gets copied or written to disk for one block.
 *
 * The same text in both places on purpose: a copy that keeps the naming line and a save that drops
 * it would be two different files from one button pair.
 */
export function bodyForBlock(language: string | null, source: string): string {
  if (!NO_COMMENT_SYNTAX.has((language ?? "").toLowerCase())) return source;
  if (!fileNameFromFirstLine(source)) return source;
  // Only the first line, and the newline that ends it. Anything else in the block is the user's.
  const newline = source.indexOf("\n");
  return newline === -1 ? "" : source.slice(newline + 1);
}

export function fileNameForBlock(language: string | null, source: string, stem: string): string {
  const declared = fileNameFromFirstLine(source);
  if (declared) return declared;
  const named = NAMED[(language ?? "").toLowerCase()];
  if (named) return named;
  return `${stem}.${extensionForLanguage(language)}`;
}
