import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";

export type LayoutKey =
  | "sidebarWidth"
  | "graphDiffWidth"
  | "changesListWidth"
  | "settingsNavWidth"
  | "editorTreeWidth"
  | "graphColRefs"
  | "graphColAuthor"
  | "graphColHash"
  | "graphColDate"
  | "graphColMessage"
  | "aiPanelWidth"
  | "terminalPanelHeight";

const STORAGE_KEYS: Record<LayoutKey, string> = {
  sidebarWidth: "layout_sidebar_width",
  graphDiffWidth: "layout_graph_diff_width",
  changesListWidth: "layout_changes_list_width",
  settingsNavWidth: "layout_settings_nav_width",
  editorTreeWidth: "layout_editor_tree_width",
  graphColRefs: "layout_graph_col_refs",
  graphColAuthor: "layout_graph_col_author",
  graphColHash: "layout_graph_col_hash",
  graphColDate: "layout_graph_col_date",
  graphColMessage: "layout_graph_col_message",
  aiPanelWidth: "layout_ai_panel_width",
  terminalPanelHeight: "layout_terminal_panel_height",
};

export const LAYOUT_DEFAULTS: Record<LayoutKey, number> = {
  sidebarWidth: 256,
  graphDiffWidth: 440,
  changesListWidth: 288,
  settingsNavWidth: 208,
  editorTreeWidth: 260,
  graphColRefs: 130,
  graphColAuthor: 130,
  graphColHash: 70,
  graphColDate: 70,
  graphColMessage: 360,
  aiPanelWidth: 340,
  terminalPanelHeight: 260,
};

interface LayoutState {
  sizes: Record<LayoutKey, number>;
  init: () => Promise<void>;
  /** Live update while dragging — cheap, no disk write. */
  setSize: (key: LayoutKey, value: number) => void;
  /** Called once on drag end to persist the final value. */
  commitSize: (key: LayoutKey, value: number) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sizes: { ...LAYOUT_DEFAULTS },

  init: async () => {
    const loaded = await Promise.all(
      (Object.keys(STORAGE_KEYS) as LayoutKey[]).map(async (key) => {
        const raw = await getSetting(STORAGE_KEYS[key]).catch(() => null);
        const num = raw ? Number(raw) : NaN;
        return [key, Number.isFinite(num) ? num : LAYOUT_DEFAULTS[key]] as const;
      }),
    );
    set({ sizes: Object.fromEntries(loaded) as Record<LayoutKey, number> });
  },

  setSize: (key, value) => set((s) => ({ sizes: { ...s.sizes, [key]: value } })),

  commitSize: (key, value) => {
    void setSetting(STORAGE_KEYS[key], String(Math.round(value)));
  },
}));
