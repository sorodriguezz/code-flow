import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";
import { DEFAULT_SNIPPETS, parseSnippets, type DbSnippet } from "../lib/db/snippets";

/**
 * The database workspace's own preferences: what ⌘↵ runs, and the console's snippets.
 *
 * Settings rows rather than columns anywhere — they describe how this person uses the console, not
 * a connection — and they reach every window through `watchSettings`.
 */
export type DbRunMode = "cursor" | "first";

const RUN_MODE_KEY = "db_run_mode";
const SNIPPETS_KEY = "db_snippets";

interface DbPrefsState {
  loaded: boolean;
  runMode: DbRunMode;
  /** The defaults until the user saves a list of their own. */
  snippets: DbSnippet[];
  load: () => Promise<void>;
  setRunMode: (mode: DbRunMode) => void;
  saveSnippets: (snippets: DbSnippet[]) => void;
}

export const useDbPrefsStore = create<DbPrefsState>((set) => ({
  loaded: false,
  runMode: "cursor",
  snippets: DEFAULT_SNIPPETS,

  load: async () => {
    const [mode, snippets] = await Promise.all([
      getSetting(RUN_MODE_KEY).catch(() => null),
      getSetting(SNIPPETS_KEY).catch(() => null),
    ]);
    set({
      loaded: true,
      runMode: mode === "first" ? "first" : "cursor",
      snippets: snippets === null ? DEFAULT_SNIPPETS : parseSnippets(snippets),
    });
  },

  setRunMode: (runMode) => {
    set({ runMode });
    void setSetting(RUN_MODE_KEY, runMode).catch(() => {});
  },

  saveSnippets: (snippets) => {
    set({ snippets });
    void setSetting(SNIPPETS_KEY, JSON.stringify(snippets)).catch(() => {});
  },
}));

/** Loaded on first use rather than at startup: a workspace that never opens a console pays nothing. */
export function ensureDbPrefsLoaded(): void {
  if (!useDbPrefsStore.getState().loaded) void useDbPrefsStore.getState().load();
}

watchSettings(
  (key) => key === RUN_MODE_KEY || key === SNIPPETS_KEY,
  () => {
    if (useDbPrefsStore.getState().loaded) void useDbPrefsStore.getState().load();
  },
);
