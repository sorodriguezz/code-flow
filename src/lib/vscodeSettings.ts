import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { readFileText } from "./tauri/commands";
import { stripJsonc } from "./vscodeTasks";
import { lspLanguageOf } from "./lsp/servers";
import { useEditorDisplayStore } from "../state/editorDisplayStore";

/**
 * The repository's `.vscode/settings.json`, applied over Settings › Editor while one of its files is
 * open — so a project that says "two spaces, rulers at 100, format on save, hide `dist`" is edited
 * that way here too, without anyone copying the file's contents into this app's preferences.
 *
 * What is read, flat keys and their `[language]` blocks alike (`"[python]": { "editor.tabSize": 4 }`):
 *
 * - `editor.tabSize`, `editor.insertSpaces`, `editor.detectIndentation`
 * - `editor.rulers`, `editor.wordWrap`, `editor.formatOnSave`
 * - `files.trimTrailingWhitespace`, `files.insertFinalNewline`, `files.eol`
 * - `files.exclude` (the explorer and the search) and `search.exclude` (the search)
 *
 * The order is VS Code's: this app's preference, then the workspace file, then its block for the
 * file's language — and `.editorconfig` over all of them, as the EditorConfig extension does.
 * Everything else in the file is VS Code's business and is left alone.
 */

export const VSCODE_SETTINGS_FILE = ".vscode/settings.json";

export interface FileEditorSettings {
  tabSize?: number;
  insertSpaces?: boolean;
  detectIndentation?: boolean;
  rulers?: number[];
  wordWrap?: boolean;
  formatOnSave?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  eol?: "\n" | "\r\n";
}

export interface ParsedVscodeSettings {
  base: Record<string, unknown>;
  /** `"[typescript][javascript]"` is split, so each id carries the block. */
  byLanguage: Record<string, Record<string, unknown>>;
  filesExclude: string[];
  searchExclude: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The globs of an exclude object that are switched on (`true`; a `{ "when": … }` is not read). */
function excludeGlobs(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
}

export function parseVscodeSettings(text: string): ParsedVscodeSettings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const base: Record<string, unknown> = {};
  const byLanguage: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const languages = /^(\[[^\]]+\])+$/.test(key) ? [...key.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]) : null;
    if (languages && isRecord(value)) {
      for (const language of languages) byLanguage[language] = { ...byLanguage[language], ...value };
    } else {
      base[key] = value;
    }
  }
  return {
    base,
    byLanguage,
    filesExclude: excludeGlobs(base["files.exclude"]),
    searchExclude: excludeGlobs(base["search.exclude"]),
  };
}

/** The ids VS Code would give this file, most specific first — its own names, not Monaco's. */
export function vscodeLanguageIds(path: string, monacoLanguage: string): string[] {
  const extension = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  const name = path.split("/").pop() ?? path;
  if (extension === "tsx") return ["typescriptreact"];
  if (extension === "jsx") return ["javascriptreact"];
  if (extension === "jsonc" || /^(tsconfig|jsconfig)(\..*)?\.json$/i.test(name) || path.startsWith(".vscode/")) return ["jsonc"];
  const own = lspLanguageOf(path, monacoLanguage);
  const renamed: Record<string, string> = { shell: "shellscript", hcl: "terraform", "terraform-vars": "terraform" };
  return [renamed[own] ?? own];
}

function readSettings(source: Record<string, unknown>): FileEditorSettings {
  const out: FileEditorSettings = {};
  const tabSize = source["editor.tabSize"];
  if (typeof tabSize === "number" && tabSize > 0 && tabSize <= 16) out.tabSize = Math.round(tabSize);
  if (typeof source["editor.insertSpaces"] === "boolean") out.insertSpaces = source["editor.insertSpaces"];
  if (typeof source["editor.detectIndentation"] === "boolean") out.detectIndentation = source["editor.detectIndentation"];
  const rulers = source["editor.rulers"];
  if (Array.isArray(rulers)) {
    // A ruler may be `{ "column": 80, "color": "…" }`; only the column is drawn here.
    out.rulers = rulers
      .map((ruler) => (typeof ruler === "number" ? ruler : isRecord(ruler) ? ruler.column : null))
      .filter((column): column is number => typeof column === "number" && column > 0);
  }
  const wrap = source["editor.wordWrap"];
  if (typeof wrap === "string") out.wordWrap = wrap !== "off";
  if (typeof source["editor.formatOnSave"] === "boolean") out.formatOnSave = source["editor.formatOnSave"];
  if (typeof source["files.trimTrailingWhitespace"] === "boolean") out.trimTrailingWhitespace = source["files.trimTrailingWhitespace"];
  if (typeof source["files.insertFinalNewline"] === "boolean") out.insertFinalNewline = source["files.insertFinalNewline"];
  const eol = source["files.eol"];
  if (eol === "\n" || eol === "\r\n") out.eol = eol;
  return out;
}

/** What the file says about one file: the workspace keys, then its language's block over them. */
export function settingsForFile(parsed: ParsedVscodeSettings, path: string, monacoLanguage: string): FileEditorSettings {
  let out = readSettings(parsed.base);
  for (const id of vscodeLanguageIds(path, monacoLanguage)) {
    const block = parsed.byLanguage[id];
    if (block) out = { ...out, ...readSettings(block) };
  }
  return out;
}

/** VS Code's exclude globs over repo-relative paths: `**\/node_modules` anywhere, `dist` at the root,
 *  `*.log` by name at the root. A folder that matches takes everything under it. */
export function excludeMatcher(globs: string[]): ((relPath: string) => boolean) | null {
  if (globs.length === 0) return null;
  const patterns = globs.map((glob) => {
    const clean = glob.replace(/^\.?\//, "").replace(/\/+$/, "");
    let out = "";
    for (let i = 0; i < clean.length; i++) {
      const char = clean[i];
      if (char === "*" && clean[i + 1] === "*") {
        out += clean[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += clean[i + 2] === "/" ? 2 : 1;
      } else if (char === "*") out += "[^/]*";
      else if (char === "?") out += "[^/]";
      else if (char === "{") {
        const close = clean.indexOf("}", i);
        if (close < 0) out += "\\{";
        else {
          out += `(?:${clean
            .slice(i + 1, close)
            .split(",")
            .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&"))
            .join("|")})`;
          i = close;
        }
      } else out += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${out}(?:/.*)?$`);
  });
  return (relPath) => {
    const path = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    return patterns.some((pattern) => pattern.test(path));
  };
}

/**
 * Exclude globs in the shape the search backend reads (`search.rs`'s `build_globs`): a comma list,
 * so `{a,b}` is spelled out first, and each glob also as `glob/**`, since a folder excluded in VS
 * Code takes its contents with it and a glob set matches only the path itself.
 */
export function searchExcludeGlobs(globs: string[]): string[] {
  const out: string[] = [];
  for (const glob of globs) {
    const clean = glob.replace(/^\.?\//, "").replace(/\/+$/, "");
    const brace = /\{([^{}]*)\}/.exec(clean);
    const expanded = brace ? brace[1].split(",").map((part) => clean.replace(brace[0], part)) : [clean];
    for (const one of expanded) if (one) out.push(one, `${one}/**`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per repository, read once and again whenever the file is saved
// ---------------------------------------------------------------------------

interface VscodeSettingsState {
  /** `null`: the repository has no such file (or it does not parse). Missing: not read yet. */
  byRepo: Record<string, ParsedVscodeSettings | null>;
  load: (repoPath: string) => Promise<ParsedVscodeSettings | null>;
  /** Read again — after the file was saved from the editor. */
  reload: (repoPath: string) => Promise<void>;
}

const inflight = new Map<string, Promise<ParsedVscodeSettings | null>>();

export const useVscodeSettingsStore = create<VscodeSettingsState>((set, get) => ({
  byRepo: {},
  load: (repoPath) => {
    if (repoPath in get().byRepo) return Promise.resolve(get().byRepo[repoPath]);
    const pending = inflight.get(repoPath);
    if (pending) return pending;
    const attempt = readFileText(repoPath, VSCODE_SETTINGS_FILE)
      .then((text) => parseVscodeSettings(text))
      .catch(() => null)
      .then((parsed) => {
        set((state) => ({ byRepo: { ...state.byRepo, [repoPath]: parsed } }));
        return parsed;
      })
      .finally(() => inflight.delete(repoPath));
    inflight.set(repoPath, attempt);
    return attempt;
  },
  reload: async (repoPath) => {
    set((state) => {
      const next = { ...state.byRepo };
      delete next[repoPath];
      return { byRepo: next };
    });
    await get().load(repoPath);
  },
}));

/** The settings for one file, or `{}` when the switch is off or the repository has no file. */
export async function vscodeSettingsForFile(repoPath: string, path: string, monacoLanguage: string): Promise<FileEditorSettings> {
  if (!useEditorDisplayStore.getState().vscodeSettings) return {};
  const parsed = await useVscodeSettingsStore.getState().load(repoPath);
  return parsed ? settingsForFile(parsed, path, monacoLanguage) : {};
}

/** The repository's exclude globs for the explorer (`files`) or the search (`search`: both lists,
 *  shaped by `searchExcludeGlobs`). */
export function useVscodeExcludes(repoPath: string, scope: "files" | "search"): string[] {
  const on = useEditorDisplayStore((s) => s.vscodeSettings);
  const parsed = useVscodeSettingsStore((s) => s.byRepo[repoPath]);
  useEffect(() => {
    if (on && parsed === undefined) void useVscodeSettingsStore.getState().load(repoPath);
  }, [on, parsed, repoPath]);
  return useMemo(() => {
    if (!on || !parsed) return NONE;
    return scope === "files" ? parsed.filesExclude : searchExcludeGlobs([...parsed.filesExclude, ...parsed.searchExclude]);
  }, [on, parsed, scope]);
}

const NONE: string[] = [];
