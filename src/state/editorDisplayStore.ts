import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

const WORD_WRAP_KEY = "editor_word_wrap";
const INLAY_HINTS_KEY = "editor_inlay_hints";
const FONT_SIZE_KEY = "editor_font_size";
const IMPORT_COST_KEY = "editor_import_cost";
const PRISMA_HIGHLIGHT_KEY = "editor_prisma_highlight";
const IMPLEMENTATION_LENS_KEY = "editor_implementation_lens";
const INDENT_KEY = "editor_indent";
const FONT_FAMILY_KEY = "editor_font_family";
const LIGATURES_KEY = "editor_ligatures";
const MINIMAP_KEY = "editor_minimap";
const WHITESPACE_KEY = "editor_whitespace";
const RULERS_KEY = "editor_rulers";
const STICKY_SCROLL_KEY = "editor_sticky_scroll";
const AUTO_SAVE_KEY = "editor_auto_save";
const EDITORCONFIG_KEY = "editor_editorconfig";
const TRIM_TRAILING_KEY = "editor_trim_trailing_whitespace";
const FINAL_NEWLINE_KEY = "editor_insert_final_newline";
const LINKED_EDITING_KEY = "editor_linked_editing";
const EMMET_KEY = "editor_emmet";
const JSON_SCHEMAS_KEY = "editor_json_schemas";
const VSCODE_SETTINGS_KEY = "editor_vscode_settings";

/** Indentation: `auto` reads it off each file (Monaco's `detectIndentation`), the rest impose it. */
export type EditorIndent = "auto" | "2" | "4" | "8" | "tab";
export type EditorWhitespace = "none" | "boundary" | "trailing" | "all";
/** VS Code's `files.autoSave`, less `onWindowChange`: a second after typing stops, or when the tab or
 *  the editor loses focus. Off by default, as there. */
export type EditorAutoSave = "off" | "afterDelay" | "onFocusChange";

const INDENTS: EditorIndent[] = ["auto", "2", "4", "8", "tab"];
const WHITESPACES: EditorWhitespace[] = ["none", "boundary", "trailing", "all"];
const AUTO_SAVES: EditorAutoSave[] = ["off", "afterDelay", "onFocusChange"];

/** The size the editor always drew at, and the range the slider offers. */
export const DEFAULT_EDITOR_FONT_SIZE = 13;
export const EDITOR_FONT_SIZES = { min: 10, max: 22 } as const;

/**
 * How the Editor lays its text out — Settings › Editor › Display, and ⌥Z from the code.
 *
 * Four switches and a size.
 *
 * **Word wrap.** With it on, a line wider than the pane carries on underneath instead of running off
 * to the right, and where it breaks is the pane's own width — Monaco's `wordWrap: "on"`, not a column
 * somebody has to pick (the user's ask, 2026-10-03: "el límite que lo ponga el mismo editor").
 * Narrowing a split or opening the explorer re-wraps it. **Off unless turned on**, as in VS Code: code
 * is read by its indentation, and a wrapped line can pass for two. Somebody reading prose, a long JSON
 * value or a minified file knows they want it.
 *
 * **Inlay hints** — the type the compiler inferred and the name of the parameter a literal argument
 * lands in, drawn faint beside the code (the user's ask, 2026-10-03). **On unless turned off**, the
 * other way round from word wrap: they were asked for by name, and they change nothing but what is
 * drawn. The switch is Monaco's own `inlayHints.enabled`, so with it off no server is even asked —
 * the providers (`useTypeScript`, `useLanguageServer`) stay registered and simply go unconsulted.
 *
 * **Font size** — 13 px until 2026-10-09, when it became a setting: the editor and its side-by-side
 * diff follow it; the terminal, notes and the SQL console keep their own.
 *
 * **Package weights** — what each imported package weighs on disk, at the end of its import line
 * (`useImportCost`). **On unless turned off**, as it always was; the switch (the user's ask,
 * 2026-10-14) is for whoever finds a number on every import line noise. Off, nothing is measured.
 *
 * **Prisma colours** — `schema.prisma` highlighted (`monacoPrisma`). **On unless turned off**, and
 * off draws the file plain rather than taking its language away.
 *
 * **Implementations** — the "N implementations" / "Implements X" / "Overrides X.m" lines above types
 * and members (`components/editor/implementationLens`, the user's ask, 2026-10-15). **On unless
 * turned off.** Off, the provider answers nothing and asks no engine; Monaco's own `codeLens` option
 * stays on, because the package.json lenses are drawn by it too.
 *
 * Global rather than per file, and remembered: both were asked for as preferences of the editor, and
 * ⌥Z flips the same preference rather than a per-tab override nobody could find again.
 *
 * Read lazily, like `editorFormatStore` — the Editor and the settings pane ask for it when they
 * mount, and nothing else in the app needs it.
 */
interface EditorDisplayState {
  wordWrap: boolean;
  inlayHints: boolean;
  fontSize: number;
  importCost: boolean;
  prismaHighlight: boolean;
  implementationLens: boolean;
  /** Settings › Editor › Visualización, the VS Code basics (2026-10-17): indentation, the font and
   *  its ligatures, the minimap, whitespace, column rulers, sticky scroll — and auto save. */
  indent: EditorIndent;
  /** Empty: the app's own code font. */
  fontFamily: string;
  ligatures: boolean;
  minimap: boolean;
  whitespace: EditorWhitespace;
  /** Columns a ruler is drawn at, ascending. */
  rulers: number[];
  stickyScroll: boolean;
  autoSave: EditorAutoSave;
  /** The repository's `.editorconfig` applied per file (indentation, line endings, the two below).
   *  On unless turned off; what it says beats the settings here for the files it covers. */
  editorConfig: boolean;
  /** On save, VS Code's `files.trimTrailingWhitespace` and `files.insertFinalNewline`. Off by
   *  default, as there. */
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  /** Editing an HTML/JSX tag's name edits its pair too (Monaco's linked editing). On by default. */
  linkedEditing: boolean;
  /** Emmet abbreviations in HTML, JSX and CSS (`div.card>ul>li*3` + Tab). On by default. */
  emmet: boolean;
  /** JSON files validated and completed against their SchemaStore schema (or their own `$schema`),
   *  downloaded once and cached. On by default, as `json.schemaDownload.enable` is in VS Code. */
  jsonSchemas: boolean;
  /** The repository's `.vscode/settings.json` applied over these preferences while one of its files
   *  is open (`lib/vscodeSettings`). On by default. */
  vscodeSettings: boolean;
  init: () => Promise<void>;
  setEditorConfig: (on: boolean) => Promise<void>;
  setTrimTrailingWhitespace: (on: boolean) => Promise<void>;
  setInsertFinalNewline: (on: boolean) => Promise<void>;
  setLinkedEditing: (on: boolean) => Promise<void>;
  setEmmet: (on: boolean) => Promise<void>;
  setJsonSchemas: (on: boolean) => Promise<void>;
  setVscodeSettings: (on: boolean) => Promise<void>;
  setIndent: (value: EditorIndent) => Promise<void>;
  setFontFamily: (value: string) => Promise<void>;
  setLigatures: (on: boolean) => Promise<void>;
  setMinimap: (on: boolean) => Promise<void>;
  setWhitespace: (value: EditorWhitespace) => Promise<void>;
  setRulers: (value: number[]) => Promise<void>;
  setStickyScroll: (on: boolean) => Promise<void>;
  setAutoSave: (value: EditorAutoSave) => Promise<void>;
  setFontSize: (px: number) => Promise<void>;
  setWordWrap: (on: boolean) => Promise<void>;
  toggleWordWrap: () => Promise<void>;
  setInlayHints: (on: boolean) => Promise<void>;
  setImportCost: (on: boolean) => Promise<void>;
  setPrismaHighlight: (on: boolean) => Promise<void>;
  setImplementationLens: (on: boolean) => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useEditorDisplayStore = create<EditorDisplayState>((set, get) => ({
  wordWrap: false,
  inlayHints: true,
  fontSize: DEFAULT_EDITOR_FONT_SIZE,
  importCost: true,
  prismaHighlight: true,
  implementationLens: true,
  indent: "auto",
  fontFamily: "",
  ligatures: false,
  minimap: true,
  whitespace: "boundary",
  rulers: [],
  stickyScroll: true,
  autoSave: "off",
  editorConfig: true,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  linkedEditing: true,
  emmet: true,
  jsonSchemas: true,
  vscodeSettings: true,

  init: () =>
    (loading ??= getSettings([
      WORD_WRAP_KEY,
      INLAY_HINTS_KEY,
      FONT_SIZE_KEY,
      IMPORT_COST_KEY,
      PRISMA_HIGHLIGHT_KEY,
      IMPLEMENTATION_LENS_KEY,
      INDENT_KEY,
      FONT_FAMILY_KEY,
      LIGATURES_KEY,
      MINIMAP_KEY,
      WHITESPACE_KEY,
      RULERS_KEY,
      STICKY_SCROLL_KEY,
      AUTO_SAVE_KEY,
      EDITORCONFIG_KEY,
      TRIM_TRAILING_KEY,
      FINAL_NEWLINE_KEY,
      LINKED_EDITING_KEY,
      EMMET_KEY,
      JSON_SCHEMAS_KEY,
      VSCODE_SETTINGS_KEY,
    ])
      .then((stored) =>
        set({
          wordWrap: stored[WORD_WRAP_KEY] === "true",
          // Anything but an explicit "off" is on — including the absent key of every install
          // that predates the switch. The same for the two below.
          inlayHints: stored[INLAY_HINTS_KEY] !== "false",
          fontSize: clampFontSize(Number(stored[FONT_SIZE_KEY])),
          importCost: stored[IMPORT_COST_KEY] !== "false",
          prismaHighlight: stored[PRISMA_HIGHLIGHT_KEY] !== "false",
          implementationLens: stored[IMPLEMENTATION_LENS_KEY] !== "false",
          indent: oneOf(INDENTS, stored[INDENT_KEY], "auto"),
          fontFamily: (stored[FONT_FAMILY_KEY] ?? "").trim(),
          ligatures: stored[LIGATURES_KEY] === "true",
          minimap: stored[MINIMAP_KEY] !== "false",
          whitespace: oneOf(WHITESPACES, stored[WHITESPACE_KEY], "boundary"),
          rulers: parseRulers(stored[RULERS_KEY] ?? ""),
          stickyScroll: stored[STICKY_SCROLL_KEY] !== "false",
          autoSave: oneOf(AUTO_SAVES, stored[AUTO_SAVE_KEY], "off"),
          editorConfig: stored[EDITORCONFIG_KEY] !== "false",
          trimTrailingWhitespace: stored[TRIM_TRAILING_KEY] === "true",
          insertFinalNewline: stored[FINAL_NEWLINE_KEY] === "true",
          linkedEditing: stored[LINKED_EDITING_KEY] !== "false",
          emmet: stored[EMMET_KEY] !== "false",
          jsonSchemas: stored[JSON_SCHEMAS_KEY] !== "false",
          vscodeSettings: stored[VSCODE_SETTINGS_KEY] !== "false",
        }),
      )
      .catch(() => undefined)),

  setWordWrap: async (on) => {
    set({ wordWrap: on });
    await setSetting(WORD_WRAP_KEY, String(on)).catch(() => undefined);
  },

  toggleWordWrap: () => get().setWordWrap(!get().wordWrap),

  setInlayHints: async (on) => {
    set({ inlayHints: on });
    await setSetting(INLAY_HINTS_KEY, String(on)).catch(() => undefined);
  },

  setImportCost: async (on) => {
    set({ importCost: on });
    await setSetting(IMPORT_COST_KEY, String(on)).catch(() => undefined);
  },

  setPrismaHighlight: async (on) => {
    set({ prismaHighlight: on });
    await setSetting(PRISMA_HIGHLIGHT_KEY, String(on)).catch(() => undefined);
  },

  setImplementationLens: async (on) => {
    set({ implementationLens: on });
    await setSetting(IMPLEMENTATION_LENS_KEY, String(on)).catch(() => undefined);
  },

  setIndent: async (value) => {
    set({ indent: value });
    await setSetting(INDENT_KEY, value).catch(() => undefined);
  },
  setFontFamily: async (value) => {
    set({ fontFamily: value.trim() });
    await setSetting(FONT_FAMILY_KEY, value.trim()).catch(() => undefined);
  },
  setLigatures: async (on) => {
    set({ ligatures: on });
    await setSetting(LIGATURES_KEY, String(on)).catch(() => undefined);
  },
  setMinimap: async (on) => {
    set({ minimap: on });
    await setSetting(MINIMAP_KEY, String(on)).catch(() => undefined);
  },
  setWhitespace: async (value) => {
    set({ whitespace: value });
    await setSetting(WHITESPACE_KEY, value).catch(() => undefined);
  },
  setRulers: async (value) => {
    const rulers = parseRulers(value.join(","));
    set({ rulers });
    await setSetting(RULERS_KEY, rulers.join(",")).catch(() => undefined);
  },
  setStickyScroll: async (on) => {
    set({ stickyScroll: on });
    await setSetting(STICKY_SCROLL_KEY, String(on)).catch(() => undefined);
  },
  setAutoSave: async (value) => {
    set({ autoSave: value });
    await setSetting(AUTO_SAVE_KEY, value).catch(() => undefined);
  },

  setEditorConfig: async (on) => {
    set({ editorConfig: on });
    await setSetting(EDITORCONFIG_KEY, String(on)).catch(() => undefined);
  },
  setTrimTrailingWhitespace: async (on) => {
    set({ trimTrailingWhitespace: on });
    await setSetting(TRIM_TRAILING_KEY, String(on)).catch(() => undefined);
  },
  setInsertFinalNewline: async (on) => {
    set({ insertFinalNewline: on });
    await setSetting(FINAL_NEWLINE_KEY, String(on)).catch(() => undefined);
  },
  setLinkedEditing: async (on) => {
    set({ linkedEditing: on });
    await setSetting(LINKED_EDITING_KEY, String(on)).catch(() => undefined);
  },
  setEmmet: async (on) => {
    set({ emmet: on });
    await setSetting(EMMET_KEY, String(on)).catch(() => undefined);
  },
  setJsonSchemas: async (on) => {
    set({ jsonSchemas: on });
    await setSetting(JSON_SCHEMAS_KEY, String(on)).catch(() => undefined);
  },
  setVscodeSettings: async (on) => {
    set({ vscodeSettings: on });
    await setSetting(VSCODE_SETTINGS_KEY, String(on)).catch(() => undefined);
  },

  setFontSize: async (px) => {
    const size = clampFontSize(px);
    set({ fontSize: size });
    await setSetting(FONT_SIZE_KEY, String(size)).catch(() => undefined);
  },
}));

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** `"80, 120"` → `[80, 120]`: whole columns between 1 and 400, once each, ascending. */
export function parseRulers(text: string): number[] {
  const columns = text
    .split(/[\s,;]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 400);
  return [...new Set(columns)].sort((a, b) => a - b);
}

/** The editor's font stack: the chosen family first, the app's own after it as the fallback. */
export function editorFontFamily(family: string, fallback: string): string {
  const name = family.trim();
  if (!name) return fallback;
  return `${/[\s]/.test(name) && !/^["']/.test(name) ? `"${name}"` : name}, ${fallback}`;
}

/** A stored size the editor can draw at — the default for anything else, unset included. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return DEFAULT_EDITOR_FONT_SIZE;
  return Math.min(EDITOR_FONT_SIZES.max, Math.max(EDITOR_FONT_SIZES.min, Math.round(px)));
}

/** The value Monaco takes — `on` wraps at the viewport, which is the whole of what was asked for. */
export function monacoWordWrap(on: boolean): "on" | "off" {
  return on ? "on" : "off";
}

/** Monaco's `inlayHints.enabled`. `off` is what stops it asking the providers at all. */
export function monacoInlayHints(on: boolean): "on" | "off" {
  return on ? "on" : "off";
}

// Switched in Settings or with ⌥Z in any window; a floating editor or a repository window repaints
// with the main one.
watchSettings(
  [
    WORD_WRAP_KEY,
    INLAY_HINTS_KEY,
    IMPORT_COST_KEY,
    PRISMA_HIGHLIGHT_KEY,
    IMPLEMENTATION_LENS_KEY,
    INDENT_KEY,
    FONT_FAMILY_KEY,
    LIGATURES_KEY,
    MINIMAP_KEY,
    WHITESPACE_KEY,
    RULERS_KEY,
    STICKY_SCROLL_KEY,
    AUTO_SAVE_KEY,
    EDITORCONFIG_KEY,
    TRIM_TRAILING_KEY,
    FINAL_NEWLINE_KEY,
    LINKED_EDITING_KEY,
    EMMET_KEY,
    JSON_SCHEMAS_KEY,
    VSCODE_SETTINGS_KEY,
  ],
  () => {
    loading = null;
    return useEditorDisplayStore.getState().init();
  },
);
