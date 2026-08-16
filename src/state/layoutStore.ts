import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";

export type LayoutKey =
  | "sidebarWidth"
  | "graphDiffWidth"
  | "changesListWidth"
  | "settingsNavWidth"
  | "editorTreeWidth"
  | "editorChangesWidth"
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
  | "remoteSftpLocalWidth"
  | "notesSidebarWidth"
  | "notesOutlineWidth"
  | "diagramsSidebarWidth";

const STORAGE_KEYS: Record<LayoutKey, string> = {
  sidebarWidth: "layout_sidebar_width",
  graphDiffWidth: "layout_graph_diff_width",
  changesListWidth: "layout_changes_list_width",
  settingsNavWidth: "layout_settings_nav_width",
  editorTreeWidth: "layout_editor_tree_width",
  editorChangesWidth: "layout_editor_changes_width",
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
  notesSidebarWidth: "layout_notes_sidebar_width",
  notesOutlineWidth: "layout_notes_outline_width",
  diagramsSidebarWidth: "layout_diagrams_sidebar_width",
};

export const LAYOUT_DEFAULTS: Record<LayoutKey, number> = {
  sidebarWidth: 256,
  graphDiffWidth: 440,
  changesListWidth: 288,
  settingsNavWidth: 208,
  editorTreeWidth: 260,
  editorChangesWidth: 300,
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
  // Wider than the host tree, and for the opposite reason: this one nests. A note four folders
  // deep starts 64px in before its title does, so the width that leaves a readable title at depth
  // four is the width that has to be the default.
  notesSidebarWidth: 288,
  // Narrow on purpose. The outline is headings, and a heading long enough to need more than this
  // is one the note should have shortened — widening the rail to fit it would take the room from
  // the prose, which is the thing being read.
  notesOutlineWidth: 220,
  // The notes sidebar's width, and deliberately the same number: it is the same tree of the same
  // shape at the same indent, and two workspaces whose sidebars start eight pixels apart look
  // misaligned rather than distinct.
  diagramsSidebarWidth: 288,
};

/**
 * Persisted layout booleans, kept beside the sizes rather than in `uiStore`.
 *
 * `uiStore` is session state, which is right for something opened and shut several times an hour —
 * the AI panel, the command palette. A pane collapsed down to its icons is the opposite: it is a
 * decision made once about how much room that pane deserves, and having to make it again at every
 * launch is the whole reason it needs to be remembered.
 *
 * `sidebarCollapsed` moved here from `uiStore` when the sidebar stopped disappearing entirely and
 * started collapsing to a rail of project chips, the way the settings nav collapses to its icons —
 * same control, same question, so the same answer about remembering it.
 */
export type LayoutFlag = "settingsNavCollapsed" | "sidebarCollapsed" | "notesTagsByCount";

const FLAG_STORAGE_KEYS: Record<LayoutFlag, string> = {
  settingsNavCollapsed: "layout_settings_nav_collapsed",
  sidebarCollapsed: "layout_sidebar_collapsed",
  notesTagsByCount: "layout_notes_tags_by_count",
};

const FLAG_DEFAULTS: Record<LayoutFlag, boolean> = {
  settingsNavCollapsed: false,
  sidebarCollapsed: false,
  // Alphabetical by default. Frequency reads as unsorted in a young workspace, where most tags have
  // been used once and the order is really "whatever the tie-break said" — a name is always
  // findable. The toggle is there for the workspace that has outgrown that.
  notesTagsByCount: false,
};

/**
 * The order the app rail's icons are in, as a JSON array of that rail's own keys.
 *
 * Here rather than in a store of its own for the reason the flags are here: it is persisted layout,
 * decided once and expected to survive a relaunch, and this store already makes exactly one
 * round-trip for every such value. A second store would be a second `getSettings` on the launch
 * path to carry one row.
 *
 * A single row rather than a column-per-app, because what is stored is a *sequence* — the rail's
 * own reading of it (`ordered` in `AppRail`) is what turns it back into positions, and it treats an
 * app the list has never heard of, or one it names that no longer exists, as an ordinary case.
 * Being in `app_settings` is also what puts it in the backup: that table travels whole.
 */
const RAIL_ORDER_KEY = "layout_app_rail_order";

/** Tolerant on purpose: a corrupt or hand-edited row means "no preference", not a rail that fails
 *  to render. Non-strings are dropped rather than trusted onward as keys. */
function parseRailOrder(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string");
  } catch {
    return [];
  }
}

interface LayoutState {
  sizes: Record<LayoutKey, number>;
  flags: Record<LayoutFlag, boolean>;
  /** Empty means "nobody has rearranged the rail", which is not the same as "no apps" — the rail
   *  falls back to its declared order rather than to nothing. */
  railOrder: string[];
  init: () => Promise<void>;
  /** Live update while dragging — cheap, no disk write. */
  setSize: (key: LayoutKey, value: number) => void;
  /** Called once on drag end to persist the final value. */
  commitSize: (key: LayoutKey, value: number) => void;
  /** Flips a flag and persists it in the same breath — there is no drag to wait for. */
  toggleFlag: (key: LayoutFlag) => void;
  /** Called once when an icon is dropped, for the same reason `commitSize` is: the rail previews
   *  the new order locally while the pointer is down, so this is one write per gesture. */
  setRailOrder: (order: string[]) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sizes: { ...LAYOUT_DEFAULTS },
  flags: { ...FLAG_DEFAULTS },
  railOrder: [],

  // Every stored size and flag in ONE round-trip. This used to be 33 `getSetting` calls plus 2 more
  // for the flags, wrapped in `Promise.all` — which bought nothing: `get_setting` takes the database
  // mutex per key, so the Rust end queued all 35 behind the same lock while the window waited. The
  // whole block is 35 statically-known keys, so it is one `getSettings`.
  //
  // Absence still means "default", exactly as before: `getSetting` answered `null` for an unset key,
  // `getSettings` simply omits it, and `?? null` puts the two back on the same footing — so a size
  // stored as "" still falls through to `LAYOUT_DEFAULTS` and a flag stored as "" is still `false`
  // rather than its default.
  init: async () => {
    const sizeKeys = Object.keys(STORAGE_KEYS) as LayoutKey[];
    const flagKeys = Object.keys(FLAG_STORAGE_KEYS) as LayoutFlag[];
    // One `.catch` for the batch where there used to be one per key. A failure here is the database
    // being unreachable, which failed every individual read too — so the outcome is the same it has
    // always been: the whole layout comes up on its defaults instead of blocking the launch.
    const stored = await getSettings([
      ...sizeKeys.map((key) => STORAGE_KEYS[key]),
      ...flagKeys.map((key) => FLAG_STORAGE_KEYS[key]),
      RAIL_ORDER_KEY,
    ]).catch(() => ({}) as Record<string, string>);

    const sizes = {} as Record<LayoutKey, number>;
    for (const key of sizeKeys) {
      const raw = stored[STORAGE_KEYS[key]] ?? null;
      const num = raw ? Number(raw) : NaN;
      sizes[key] = Number.isFinite(num) ? num : LAYOUT_DEFAULTS[key];
    }
    const flags = {} as Record<LayoutFlag, boolean>;
    for (const key of flagKeys) {
      const raw = stored[FLAG_STORAGE_KEYS[key]] ?? null;
      flags[key] = raw === null ? FLAG_DEFAULTS[key] : raw === "1";
    }
    set({ sizes, flags, railOrder: parseRailOrder(stored[RAIL_ORDER_KEY] ?? null) });
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

  setRailOrder: (order) => {
    void setSetting(RAIL_ORDER_KEY, JSON.stringify(order));
    set({ railOrder: order });
  },
}));
