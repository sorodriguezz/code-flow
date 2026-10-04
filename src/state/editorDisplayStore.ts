import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

const WORD_WRAP_KEY = "editor_word_wrap";
const INLAY_HINTS_KEY = "editor_inlay_hints";

/**
 * How the Editor lays its text out — Settings › Editor › Display, and ⌥Z from the code.
 *
 * Two switches so far.
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
 * Global rather than per file, and remembered: both were asked for as preferences of the editor, and
 * ⌥Z flips the same preference rather than a per-tab override nobody could find again.
 *
 * Read lazily, like `editorFormatStore` — the Editor and the settings pane ask for it when they
 * mount, and nothing else in the app needs it.
 */
interface EditorDisplayState {
  wordWrap: boolean;
  inlayHints: boolean;
  init: () => Promise<void>;
  setWordWrap: (on: boolean) => Promise<void>;
  toggleWordWrap: () => Promise<void>;
  setInlayHints: (on: boolean) => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useEditorDisplayStore = create<EditorDisplayState>((set, get) => ({
  wordWrap: false,
  inlayHints: true,

  init: () =>
    (loading ??= getSettings([WORD_WRAP_KEY, INLAY_HINTS_KEY])
      .then((stored) =>
        set({
          wordWrap: stored[WORD_WRAP_KEY] === "true",
          // Anything but an explicit "off" is on — including the absent key of every install
          // that predates the switch.
          inlayHints: stored[INLAY_HINTS_KEY] !== "false",
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
}));

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
watchSettings([WORD_WRAP_KEY, INLAY_HINTS_KEY], () => {
  loading = null;
  return useEditorDisplayStore.getState().init();
});
