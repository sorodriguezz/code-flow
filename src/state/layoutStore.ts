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
  | "terminalPanelHeight"
  | "apiSidebarWidth"
  | "apiSnippetWidth"
  | "apiResponseHeight"
  | "dbSidebarWidth"
  | "dbResultHeight"
  | "agentsListWidth"
  | "agentsRosterWidth"
  | "storiesListWidth"
  | "storiesRailWidth"
  | "wikiListWidth"
  | "wikiPublishWidth"
  | "huReviewSourceWidth"
  | "huReviewStoryHeight"
  | "huReviewPublishWidth"
  | "huReviewDraftDescWidth"
  | "huReviewDraftCriteriaWidth"
  | "remoteSidebarWidth"
  | "remoteDetailsWidth"
  | "remoteSftpLocalWidth";

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
  apiSidebarWidth: "layout_api_sidebar_width",
  apiSnippetWidth: "layout_api_snippet_width",
  apiResponseHeight: "layout_api_response_height",
  dbSidebarWidth: "layout_db_sidebar_width",
  dbResultHeight: "layout_db_result_height",
  agentsListWidth: "layout_agents_list_width",
  agentsRosterWidth: "layout_agents_roster_width",
  storiesListWidth: "layout_stories_list_width",
  storiesRailWidth: "layout_stories_rail_width",
  wikiListWidth: "layout_wiki_list_width",
  wikiPublishWidth: "layout_wiki_publish_width",
  huReviewSourceWidth: "layout_hu_review_source_width",
  huReviewStoryHeight: "layout_hu_review_story_height",
  huReviewPublishWidth: "layout_hu_review_publish_width",
  huReviewDraftDescWidth: "layout_hu_review_draft_desc_width",
  huReviewDraftCriteriaWidth: "layout_hu_review_draft_criteria_width",
  remoteSidebarWidth: "layout_remote_sidebar_width",
  remoteDetailsWidth: "layout_remote_details_width",
  remoteSftpLocalWidth: "layout_remote_sftp_local_width",
};

export const LAYOUT_DEFAULTS: Record<LayoutKey, number> = {
  sidebarWidth: 256,
  graphDiffWidth: 440,
  changesListWidth: 288,
  settingsNavWidth: 208,
  editorTreeWidth: 260,
  graphColRefs: 200,
  graphColAuthor: 130,
  graphColHash: 70,
  graphColDate: 70,
  graphColMessage: 360,
  aiPanelWidth: 340,
  terminalPanelHeight: 260,
  apiSidebarWidth: 288,
  apiSnippetWidth: 420,
  apiResponseHeight: 320,
  dbSidebarWidth: 300,
  dbResultHeight: 340,
  agentsListWidth: 320,
  agentsRosterWidth: 300,
  storiesListWidth: 300,
  // Wider than the agent roster: this rail holds four dependent dropdowns whose values are Azure
  // paths ("Proyecto\Área\Subárea"), which are unreadable truncated.
  storiesRailWidth: 320,
  wikiListWidth: 260,
  wikiPublishWidth: 280,
  // The review board's outer columns. Only these two are stored: the middle one is what the other
  // two leave, so giving it a width of its own would mean three numbers that have to keep adding
  // up to the window — and a window resize would have to arbitrate between them.
  huReviewSourceWidth: 360,
  // How far the Story tab's read-only blocks scroll before the pane does. Stored because how much
  // of a description is worth seeing at once is a property of the descriptions a team writes, not
  // of the app — and re-dragging it on every work item would make it worth nothing.
  huReviewStoryHeight: 288,
  huReviewPublishWidth: 304,
  // The draft board's first two columns; the tasks pane takes whatever is left, for the same
  // reason the review's middle pane does — three stored widths would have to keep adding up to
  // the window, and a window resize would have to arbitrate between them.
  huReviewDraftDescWidth: 420,
  huReviewDraftCriteriaWidth: 460,
  // Wider than the database explorer's: a host row carries three hover actions to the right of
  // its name, and at 300 the name is what gets truncated to make room for them.
  remoteSidebarWidth: 260,
  // Wider than the host tree: this one holds label-and-control rows, and at the tree's width the
  // control column is narrower than the values it has to show.
  remoteDetailsWidth: 340,
  // Only the *local* half is stored; the remote one takes what is left, for the reason the review
  // board's middle column does — two stored widths would have to keep adding up to the window.
  remoteSftpLocalWidth: 420,
};

/**
 * Persisted layout booleans, kept beside the sizes rather than in `uiStore`.
 *
 * `uiStore` is session state — its own `sidebarCollapsed` resets on every launch, which is fine for
 * something toggled from the title bar several times an hour. A pane collapsed down to its icons is
 * the opposite: it is a decision made once about how much room that pane deserves, and having to
 * make it again at every launch is the whole reason it needs to be remembered.
 */
export type LayoutFlag = "settingsNavCollapsed";

const FLAG_STORAGE_KEYS: Record<LayoutFlag, string> = {
  settingsNavCollapsed: "layout_settings_nav_collapsed",
};

const FLAG_DEFAULTS: Record<LayoutFlag, boolean> = {
  settingsNavCollapsed: false,
};

interface LayoutState {
  sizes: Record<LayoutKey, number>;
  flags: Record<LayoutFlag, boolean>;
  init: () => Promise<void>;
  /** Live update while dragging — cheap, no disk write. */
  setSize: (key: LayoutKey, value: number) => void;
  /** Called once on drag end to persist the final value. */
  commitSize: (key: LayoutKey, value: number) => void;
  /** Flips a flag and persists it in the same breath — there is no drag to wait for. */
  toggleFlag: (key: LayoutFlag) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sizes: { ...LAYOUT_DEFAULTS },
  flags: { ...FLAG_DEFAULTS },

  init: async () => {
    const loaded = await Promise.all(
      (Object.keys(STORAGE_KEYS) as LayoutKey[]).map(async (key) => {
        const raw = await getSetting(STORAGE_KEYS[key]).catch(() => null);
        const num = raw ? Number(raw) : NaN;
        return [key, Number.isFinite(num) ? num : LAYOUT_DEFAULTS[key]] as const;
      }),
    );
    const flags = await Promise.all(
      (Object.keys(FLAG_STORAGE_KEYS) as LayoutFlag[]).map(async (key) => {
        const raw = await getSetting(FLAG_STORAGE_KEYS[key]).catch(() => null);
        return [key, raw === null ? FLAG_DEFAULTS[key] : raw === "1"] as const;
      }),
    );
    set({
      sizes: Object.fromEntries(loaded) as Record<LayoutKey, number>,
      flags: Object.fromEntries(flags) as Record<LayoutFlag, boolean>,
    });
  },

  setSize: (key, value) => set((s) => ({ sizes: { ...s.sizes, [key]: value } })),

  commitSize: (key, value) => {
    void setSetting(STORAGE_KEYS[key], String(Math.round(value)));
  },

  toggleFlag: (key) =>
    set((s) => {
      const next = !s.flags[key];
      void setSetting(FLAG_STORAGE_KEYS[key], next ? "1" : "0");
      return { flags: { ...s.flags, [key]: next } };
    }),
}));
