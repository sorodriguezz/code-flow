import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

const FORMAT_ON_SAVE_KEY = "editor_format_on_save";

/**
 * Whether a save formats the file first — Settings › Editor › Formatting.
 *
 * **Off unless turned on.** A save that rewrites more than was typed is a surprise the first time
 * it happens, and in a repository with no formatter config it is a diff nobody asked for. Somebody
 * who wants it knows they do.
 *
 * Read lazily — by the editor and by the settings pane, whichever mounts first — rather than at
 * boot: nothing else in the app needs it, and a save is the earliest moment it matters.
 */
interface EditorFormatState {
  formatOnSave: boolean;
  init: () => Promise<void>;
  setFormatOnSave: (on: boolean) => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useEditorFormatStore = create<EditorFormatState>((set) => ({
  formatOnSave: false,

  init: () =>
    (loading ??= getSettings([FORMAT_ON_SAVE_KEY])
      .then((stored) => set({ formatOnSave: stored[FORMAT_ON_SAVE_KEY] === "true" }))
      .catch(() => undefined)),

  setFormatOnSave: async (on) => {
    set({ formatOnSave: on });
    await setSetting(FORMAT_ON_SAVE_KEY, String(on));
  },
}));

// Chosen in Settings, which only the main window has; a repository window's editor saves too.
watchSettings([FORMAT_ON_SAVE_KEY], () => {
  loading = null;
  return useEditorFormatStore.getState().init();
});
