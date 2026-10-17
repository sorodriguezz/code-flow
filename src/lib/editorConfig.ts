import { readFileText } from "./tauri/commands";

/**
 * `.editorconfig` (editorconfig.org), as VS Code's official extension applies it: the files from the
 * edited file's folder up to the repository root — or to the first one that says `root = true` —
 * nearer ones winning, and within one file the later section winning. What the editor takes from
 * it: indentation (`indent_style`, `indent_size`, `tab_width`) when the file opens, and line endings
 * (`end_of_line`), `trim_trailing_whitespace` and `insert_final_newline` when it is saved.
 *
 * Only the repository's own files: nothing above the repository is read, so a stray
 * `~/.editorconfig` never decides how a project is written.
 */

export interface EditorConfigProps {
  indent_style?: "tab" | "space";
  /** `"tab"` means "the tab width". */
  indent_size?: number | "tab";
  tab_width?: number;
  end_of_line?: "lf" | "crlf" | "cr";
  trim_trailing_whitespace?: boolean;
  insert_final_newline?: boolean;
}

interface Section {
  glob: string;
  props: Record<string, string>;
}

export interface ParsedEditorConfig {
  root: boolean;
  sections: Section[];
}

/** The INI dialect editorconfig uses: `[glob]` headers, `key = value`, `#`/`;` comments, keys and
 *  values case-insensitive except the glob. */
export function parseEditorConfig(text: string): ParsedEditorConfig {
  let root = false;
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      current = { glob: header[1], props: {} };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    // An inline comment needs whitespace before it, or a `#` in a value would be cut.
    const value = line.slice(eq + 1).replace(/\s[#;].*$/, "").trim().toLowerCase();
    if (current) current.props[key] = value;
    else if (key === "root") root = value === "true";
  }
  return { root, sections };
}

/** An editorconfig glob as a regular expression over a `/`-separated path relative to the folder
 *  of the file that declares it. Without a `/` the glob names a file anywhere below that folder. */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob;
  if (!pattern.includes("/")) pattern = `**/${pattern}`;
  else if (pattern.startsWith("/")) pattern = pattern.slice(1);
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more folders; a bare `**` anything at all.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close < 0) {
        out += "\\[";
        continue;
      }
      const body = pattern.slice(i + 1, close).replace(/\\/g, "\\\\");
      out += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
      i = close;
    } else if (c === "{") {
      const close = pattern.indexOf("}", i + 1);
      const body = close < 0 ? null : pattern.slice(i + 1, close);
      const range = body ? /^(-?\d+)\.\.(-?\d+)$/.exec(body) : null;
      if (body !== null && range) {
        const [from, to] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
        const numbers: number[] = [];
        for (let n = from; n <= to && numbers.length < 1000; n++) numbers.push(n);
        out += `(?:${numbers.join("|")})`;
        i = close;
      } else if (body !== null && body.includes(",")) {
        out += `(?:${body.split(",").map((part) => globToRegExp(`/${part}`).source.slice(1, -1)).join("|")})`;
        i = close;
      } else {
        out += "\\{";
      }
    } else {
      out += c.replace(/[.+^$()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** The properties every section matching `relPath` sets, later sections over earlier ones. */
function propsFor(config: ParsedEditorConfig, relPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of config.sections) {
    let matcher: RegExp;
    try {
      matcher = globToRegExp(section.glob);
    } catch {
      continue;
    }
    if (matcher.test(relPath)) Object.assign(out, section.props);
  }
  return out;
}

/** The raw properties read into the shape the editor uses; `unset` and anything unknown drop. */
export function toEditorConfigProps(raw: Record<string, string>): EditorConfigProps {
  const out: EditorConfigProps = {};
  if (raw.indent_style === "tab" || raw.indent_style === "space") out.indent_style = raw.indent_style;
  if (raw.indent_size === "tab") out.indent_size = "tab";
  else if (Number(raw.indent_size) > 0) out.indent_size = Number(raw.indent_size);
  if (Number(raw.tab_width) > 0) out.tab_width = Number(raw.tab_width);
  if (raw.end_of_line === "lf" || raw.end_of_line === "crlf" || raw.end_of_line === "cr") out.end_of_line = raw.end_of_line;
  if (raw.trim_trailing_whitespace === "true" || raw.trim_trailing_whitespace === "false") {
    out.trim_trailing_whitespace = raw.trim_trailing_whitespace === "true";
  }
  if (raw.insert_final_newline === "true" || raw.insert_final_newline === "false") {
    out.insert_final_newline = raw.insert_final_newline === "true";
  }
  return out;
}

/**
 * Resolves the properties for `relPath` from configs given nearest-folder-first, each with the folder
 * it sits in (repository-relative, `""` for the root). Stops after one that says `root = true`.
 */
export function resolveFromConfigs(relPath: string, configs: { dir: string; config: ParsedEditorConfig }[]): EditorConfigProps {
  const chain: { dir: string; config: ParsedEditorConfig }[] = [];
  for (const entry of configs) {
    chain.push(entry);
    if (entry.config.root) break;
  }
  const raw: Record<string, string> = {};
  // Farthest first, so the nearer file's word is the last.
  for (const { dir, config } of chain.reverse()) {
    const below = dir ? relPath.slice(dir.length + 1) : relPath;
    Object.assign(raw, propsFor(config, below));
  }
  return toEditorConfigProps(raw);
}

/** How long a read `.editorconfig` (or its absence) is trusted — saving one clears it at once. */
const FRESH_MS = 30_000;
const cache = new Map<string, { at: number; config: Promise<ParsedEditorConfig | null> }>();

function readConfig(repoPath: string, dir: string): Promise<ParsedEditorConfig | null> {
  const rel = dir ? `${dir}/.editorconfig` : ".editorconfig";
  const key = `${repoPath}\u0000${rel}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.config;
  const config = readFileText(repoPath, rel).then(parseEditorConfig, () => null);
  cache.set(key, { at: Date.now(), config });
  return config;
}

/** Forgets what was read — after a `.editorconfig` is saved in the editor. */
export function forgetEditorConfigs(): void {
  cache.clear();
}

/** The `.editorconfig` properties for a repository file. `{}` when none applies. */
export async function editorConfigFor(repoPath: string, relPath: string): Promise<EditorConfigProps> {
  const parts = relPath.split("/");
  const dirs: string[] = [];
  for (let n = parts.length - 1; n >= 0; n--) dirs.push(parts.slice(0, n).join("/"));
  const read = await Promise.all(dirs.map((dir) => readConfig(repoPath, dir)));
  const configs = read.flatMap((config, i) => (config ? [{ dir: dirs[i], config }] : []));
  return resolveFromConfigs(relPath, configs);
}

/** What a save does to the text, the settings and `.editorconfig` together — editorconfig's word
 *  winning where it says anything. */
export interface SaveRules {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  eol: "\n" | "\r\n" | "\r" | null;
}

export function saveRulesFor(
  path: string,
  settings: { trimTrailingWhitespace: boolean; insertFinalNewline: boolean },
  config: EditorConfigProps,
): SaveRules {
  // Two trailing spaces are a line break in Markdown: the setting leaves it alone, as VS Code's
  // own Markdown default does — only an `.editorconfig` that asks for it trims there.
  const markdown = /\.(md|markdown|mdx)$/i.test(path);
  return {
    trimTrailingWhitespace: config.trim_trailing_whitespace ?? (settings.trimTrailingWhitespace && !markdown),
    insertFinalNewline: config.insert_final_newline ?? settings.insertFinalNewline,
    eol: config.end_of_line === "lf" ? "\n" : config.end_of_line === "crlf" ? "\r\n" : config.end_of_line === "cr" ? "\r" : null,
  };
}

/** `text` as the rules want it saved. Pure, for a tab with no editor model. */
export function applySaveRules(text: string, rules: SaveRules): string {
  const eol = rules.eol ?? (text.includes("\r\n") ? "\r\n" : "\n");
  let lines = text.split(/\r\n|\r|\n/);
  if (rules.trimTrailingWhitespace) lines = lines.map((line) => line.replace(/[ \t]+$/, ""));
  let out = lines.join(eol);
  if (rules.insertFinalNewline && out.length > 0 && !out.endsWith(eol)) out += eol;
  return out;
}
