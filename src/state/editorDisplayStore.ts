import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

const WORD_WRAP_KEY = "editor_word_wrap";
const INLAY_HINTS_KEY = "editor_inlay_hints";
const FONT_SIZE_KEY = "editor_font_size";
const IMPORT_COST_KEY = "editor_import_cost";
const PRISMA_HIGHLIGHT_KEY = "editor_prisma_highlight";
const IMPLEMENTATION_LENS_KEY = "editor_implementation_lens";

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
  init: () => Promise<void>;
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

  init: () =>
    (loading ??= getSettings([
      WORD_WRAP_KEY,
      INLAY_HINTS_KEY,
      FONT_SIZE_KEY,
      IMPORT_COST_KEY,
      PRISMA_HIGHLIGHT_KEY,
      IMPLEMENTATION_LENS_KEY,
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

  setFontSize: async (px) => {
    const size = clampFontSize(px);
    set({ fontSize: size });
    await setSetting(FONT_SIZE_KEY, String(size)).catch(() => undefined);
  },
}));

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
watchSettings([WORD_WRAP_KEY, INLAY_HINTS_KEY, IMPORT_COST_KEY, PRISMA_HIGHLIGHT_KEY, IMPLEMENTATION_LENS_KEY], () => {
  loading = null;
  return useEditorDisplayStore.getState().init();
});
