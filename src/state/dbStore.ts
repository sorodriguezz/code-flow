import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  dbAddHistory,
  dbAiAssist,
  dbApplyEdits,
  dbCancel,
  dbChildren,
  dbClearHistory,
  dbConnect,
  dbConnected,
  dbCreateConnection,
  dbCreateConsole,
  dbCreateGroup,
  dbReorderGroups,
  dbDeleteConnection,
  dbDeleteConsole,
  dbDeleteGroup,
  dbDeleteHistory,
  dbDisconnect,
  dbDuplicateConnection,
  dbExecute,
  dbExplain,
  dbListHistory,
  dbLoadTree,
  dbForeignKeys,
  dbObjectDdl,
  dbRenameGroup,
  dbReorderConnections,
  dbRowCount,
  dbSchemaDiagram,
  dbSchemaObjects,
  dbMoveConnectionToWorkspace,
  dbMoveGroupToWorkspace,
  dbSetConnectionGroup,
  dbSetConnectionScope,
  dbSetGroupScope,
  dbSetPassword,
  dbTableData,
  dbUpdateConnection,
  dbUpdateConsole,
} from "../lib/tauri/dbCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
// The AI run registry is a different one from the database's: `dbCancel` stops a statement on the
// server, this stops a CLI subprocess. The assistant runs on the second and never the first.
import { isCancellation, newRunId as newAiRunId, useAiRunStore } from "./aiRunStore";
import { unguardedDelete } from "../lib/db/sqlGuards";
import {
  dropContainerSql,
  dropRelationSql,
  type SchemaContents,
} from "../lib/db/dropObject";
import { firstRefusedRedisCommand } from "../lib/db/redisGuards";
import { notify } from "./notificationStore";
import { translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  DEFAULT_MAX_ROWS,
  DEFAULT_PAGE_SIZE,
  EMPTY_QUERY_OPTIONS,
  defaultConnectionConfig,
  engineInfo,
  nodeRefOf,
  type DbConnectionConfig,
  type DbFilterTarget,
  type DbForeignKey,
  type DbConnectionRow,
  type DbConsole,
  type DbExecuteResult,
  type DbGroupRow,
  type DbKind,
  type DbNode,
  type DbNodeRef,
  type DbQueryHistoryEntry,
  type DbQueryOptions,
  type DbRowEdit,
  type DbNodeKind,
  type DbObjectInfo,
  type DbSchemaDiagram,
  type DbServerInfo,
  type DbSortKey,
  type DbStatementResult,
} from "../types/database";
import type { DiagramColumnMode, DiagramDensity } from "../lib/db/erLayout";

/**
 * The database workspace's state.
 *
 * Scoped per workspace, like `apiStore` — a database belongs to the service a workspace's
 * repositories talk to, not to any one repository, so switching repository must not change what is
 * on screen. Which tabs are open is persisted per workspace for the same reason.
 *
 * Three things are worth knowing before reading it:
 *
 * 1. **The explorer tree is a cache, not a model.** `children` maps a node key to what the server
 *    said was under it. Nothing derives structure from it — collapsing and re-expanding re-asks —
 *    so a schema created in a console appears as soon as its folder is refreshed, and there is no
 *    stale-tree class of bug to reason about.
 *
 * 2. **A cell is `string | null`.** `null` is SQL NULL, `""` is an empty string, and the grid keeps
 *    them distinct all the way to the generated `UPDATE`. Anywhere those two collapse into one is a
 *    bug that silently rewrites data.
 *
 * 3. **Edits are staged, never live.** Typing in the grid records a pending change; nothing reaches
 *    the database until "Apply" — which sends the whole batch, shows the statements it generated,
 *    and (on a SQL engine) runs them in one transaction.
 */

const openTabsKey = (workspaceId: string) => `db_open_tabs:${workspaceId}`;
const collapsedKey = (workspaceId: string) => `db_collapsed_groups:${workspaceId}`;

/** The name the ungrouped bucket is *stored* under: none. Kept as a constant so the difference
 *  between "no group" and a group literally called "" is stated once — a connection dragged out of
 *  a folder must not acquire a group named after the label the tree happens to show. */
export const UNGROUPED = "";

/** How many history rows to load. Well under the backend's hard cap — this is a list to scan, not
 * an archive to browse. */
const HISTORY_LIMIT = 300;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * How a tab is being *looked at*, as opposed to what it holds.
 *
 * `DatabaseView` renders one panel per tab *kind* in a single slot with no React key, so every
 * data tab shared one component instance and therefore one `useState` for each of these. Toggling
 * the record layout on one table transposed the next one too, and routing through a console tab
 * threw the choice away entirely instead of leaving it where it was put.
 *
 * A key on the panel would have been the wrong fix: it discards the choice on every switch rather
 * than remembering it. So the state moves to the tab record instead, where it is naturally per tab
 * and dies with the tab.
 *
 * Deliberately absent from [`PersistedTab`], which is an explicit whitelist and drops these by
 * construction: a tab that reopened sideways, with column widths measured against columns the
 * schema may no longer have, would be a surprise rather than a convenience.
 */
export interface DbDataUi {
  /** `"record"` is the transposed read — one record down the page instead of rows across it. */
  layout: "grid" | "record";
  docView: "documents" | "json" | "grid";
  optionsOpen: boolean;
  /** Column pixel widths by column name; a missing entry means the grid's own default. */
  widths: Record<string, number>;
  /** Record-view gutters; `null` means the grid's own default. */
  fieldWidth: number | null;
  recordWidth: number | null;
}

export const DEFAULT_DATA_UI: DbDataUi = {
  layout: "grid",
  docView: "documents",
  optionsOpen: false,
  widths: {},
  fieldWidth: null,
  recordWidth: null,
};

/** The console's own view state — see [`DbDataUi`] for why it lives on the tab. */
export interface DbConsoleUi {
  docView: "documents" | "json" | "grid";
  widths: Record<string, number>;
}

export const DEFAULT_CONSOLE_UI: DbConsoleUi = { docView: "documents", widths: {} };

export type DbSchemaSortKey =
  | "name"
  | "object_type"
  | "created_at"
  | "modified_at"
  | "total_bytes"
  | "used_bytes"
  | "rows";

/** The schema listing's rail selection, filter and sort — see [`DbDataUi`]. */
export interface DbSchemaUi {
  category: DbNodeKind | null;
  query: string;
  sort: { key: DbSchemaSortKey; desc: boolean };
}

export const DEFAULT_SCHEMA_UI: DbSchemaUi = {
  category: null,
  query: "",
  sort: { key: "name", desc: false },
};

/** The ER canvas's view choices and hand-dragged positions — see [`DbDataUi`]. */
export interface DbDiagramUi {
  mode: DiagramColumnMode;
  density: DiagramDensity;
  /** Hand-dragged table positions by node id; everything else is laid out automatically. */
  pinned: Record<string, { x: number; y: number }>;
  selected: string | null;
  query: string;
  highlight: "none" | "noPrimaryKey" | "isolated";
  /**
   * Whether each relationship shows its two multiplicities — `1`, `0..1`, `0..N`.
   *
   * On by default, because an arrow on its own answers "which way does the key point" and a reader
   * of a schema drawing is asking "must every order have a customer, and can a customer have two".
   * A toggle rather than a constant all the same: at eighty relationships the numbers are the
   * densest thing on the canvas, and the person zooming out to see the shape wants the shape.
   */
  cardinality: boolean;
}

export const DEFAULT_DIAGRAM_UI: DbDiagramUi = {
  mode: "keys",
  density: "roomy",
  pinned: {},
  selected: null,
  query: "",
  highlight: "none",
  cardinality: true,
};

/** A statement to run, and what came back. */
export interface DbConsoleTab {
  id: string;
  kind: "console";
  connectionId: string;
  /** `null` until saved — a scratch console exists only here and in the persisted tab list, which
   * is what makes "open a console, type, run" work without creating anything. */
  consoleId: string | null;
  name: string;
  body: string;
  database: string;
  schema: string;
  maxRows: number;
  dirty: boolean;
  running: boolean;
  /** Set while a statement is in flight; the handle `cancel` needs. */
  runId: string | null;
  result: DbExecuteResult | null;
  /** Which statement's result the grid is showing, when a batch produced several. */
  activeResult: number;
  /** An `EXPLAIN` plan, shown instead of a grid until the next run. */
  plan: string | null;
  /** The AI assistant's ask bar and its last answer. `null` until it is first opened, so a console
   * that never uses it costs nothing — and it is never persisted, like every other result here. */
  ai: DbConsoleAi | null;
  /** How this console is being looked at — see [`DbConsoleUi`]. */
  ui: DbConsoleUi;
}

/**
 * The console's AI assistant, per tab.
 *
 * Per tab and not global because the question is about *this* console's scope and *this* console's
 * query: two consoles open on two schemas asking one shared assistant would answer the second
 * question against the first one's tables.
 */
/**
 * One turn of the console's conversation with the model.
 *
 * The assistant used to hold exactly one answer, which decided what it could be asked: a question,
 * a reply, and three buttons — insert, replace, close. Anything that began "and now group that by
 * month" had to be re-asked from scratch, with the schema re-read and the previous answer retyped
 * into the question. Keeping the turns is what makes the second question cheap, and what lets the
 * model see the statement it just wrote when you say "the join is wrong".
 *
 * The user's turns carry nothing but their text. The assistant's carry what the answer panel used
 * to hold on the single answer, per turn, so scrolling back to an earlier statement still offers to
 * insert *that* one and still names the engine that wrote it.
 */
export interface DbAiTurn {
  role: "user" | "assistant";
  /** Markdown for an assistant turn, plain text for a question. */
  text: string;
  /** The runnable statement this turn proposed, when it proposed one. `null` for a pure
   *  explanation, which is an ordinary outcome and not a parse failure. */
  query?: string | null;
  /** The AI run that produced it — the key `RunEngineChip` resolves the model through. */
  runId?: string | null;
  /** How much schema the model was shown, for the caveat under the answer. */
  tablesSeen?: number;
  schemaTruncated?: boolean;
}

export interface DbConsoleAi {
  /** What is typed in the ask box, kept across tab switches so a half-written question survives
   * going to look at the schema tree for the name you were missing. */
  question: string;
  /**
   * The conversation so far, oldest first.
   *
   * Sent back with the next question (see `askConsoleAi`), which is what makes this a chat rather
   * than a list of unrelated answers: the engine is a one-shot CLI with no session of its own, so
   * "and now group that by month" only means anything if the turn it refers to travels with it.
   */
  messages: DbAiTurn[];
  running: boolean;
  /** The **AI** run registry's id — this is `cancelAiRun`'s handle, not `dbCancel`'s. No statement
   * runs on the database here, so there is nothing on that side to stop.
   *
   * **Kept after the run ends**, which is why `running` exists separately: it is also the key the
   * answer's engine chip looks the model up by, and `aiRunStore` deliberately holds `engineByRun`
   * past the end of a run for exactly that read. Clearing it here used to blank that chip the
   * instant the answer arrived — the one moment somebody wants to know which model wrote it. */
  runId: string | null;
  /** Kept on the panel rather than shown as a toast: an answer that failed is something you retry
   * with a reworded question, which means reading the reason while you rewrite it. */
  error: string | null;
}

/** One relation's rows, editable. */
export interface DbDataTab {
  id: string;
  kind: "data";
  connectionId: string;
  node: DbNodeRef;
  name: string;
  offset: number;
  limit: number;
  filter: string;
  /** What is typed in the filter box but not yet applied — so a half-written predicate doesn't run
   * on every keystroke. */
  filterDraft: string;
  /**
   * The rest of the query, on the engines that have one — projection, collation, hint and the
   * skip/limit ceiling. Empty strings throughout on every SQL engine, where the panel doesn't draw
   * the boxes at all.
   */
  options: DbQueryOptions;
  /** The options being typed, applied together with the filter — same split, same reason. */
  optionsDraft: DbQueryOptions;
  /**
   * The sort, in the order the columns were added to it.
   *
   * A list rather than one column and a direction, because "newest first, then by name" is an
   * ordinary thing to want out of a grid and expressing it one column at a time cannot say which
   * of the two breaks the tie. Empty means the server's own order.
   */
  sort: DbSortKey[];
  loading: boolean;
  runId: string | null;
  /**
   * The row count's own run, kept separate from `runId`.
   *
   * The count outlives the page it was asked with — the page is an index read and the count is a
   * full scan — so by the time it matters `runId` is already back to `null`. Without an id of its
   * own there is nothing to cancel, and closing the tab leaves the server scanning a table for a
   * total that has nowhere left to go.
   */
  countRunId: string | null;
  result: DbStatementResult | null;
  /** `null` until the count comes back — it is a separate, slower query. */
  total: number | null;
  /** The relation's columns, for the primary key the data editor needs. */
  columns: DbNode[];
  /** Which columns point at another table, so the grid can offer to follow them. Loaded once per
   * tab, alongside the first page — it is catalog metadata and doesn't change between pages. */
  foreignKeys: DbForeignKey[];
  /** Staged cell edits, keyed `rowIndex:column`. */
  pending: Record<string, string | null>;
  /** Row indexes staged for deletion. */
  deleted: number[];
  /** Rows staged for insertion, in the result's column order. */
  inserted: (string | null)[][];
  /**
   * Whole documents rewritten in the document editor, keyed by row index — MongoDB only.
   *
   * Kept apart from `pending` because it is a different write: `pending` is a `$set` of the fields
   * that changed, and this is a *replacement*, which is the only way to say that a field was
   * removed or an array reordered. A row that has both would be two writes describing the same
   * document, so staging a document edit clears that row's cell edits and vice versa.
   */
  replaced: Record<number, string>;
  /** Documents staged for insertion as text — what Clone produces, and what a new document typed
   *  by hand produces. Alongside `inserted`, which is the grid's own column-shaped version. */
  insertedDocs: string[];
  error: string | null;
  /** How these rows are being looked at — see [`DbDataUi`]. */
  ui: DbDataUi;
}

/** An object's definition, as introspection can reconstruct it. */
export interface DbDdlTab {
  id: string;
  kind: "ddl";
  connectionId: string;
  node: DbNodeRef;
  name: string;
  text: string;
  loading: boolean;
}

/**
 * A whole schema drawn: its tables, their keys, and what points at what.
 *
 * `diagram` is only what the server said. How it is being *looked at* — the column mode, the
 * density, the hand-dragged positions, the highlight — sits beside it in `ui`, per tab and never
 * persisted: a reopened tab could otherwise disagree with a schema that has changed underneath it.
 * (Pan and zoom stay in the panel, because they are re-fitted on every relayout.)
 */
export interface DbDiagramTab {
  id: string;
  kind: "diagram";
  connectionId: string;
  /** The container drawn: a schema on a SQL engine, a database on Mongo. */
  node: DbNodeRef;
  name: string;
  loading: boolean;
  runId: string | null;
  diagram: DbSchemaDiagram | null;
  error: string | null;
  /** How this canvas is being looked at — see [`DbDiagramUi`]. */
  ui: DbDiagramUi;
}

/**
 * A whole schema listed: every table, view, routine and sequence it holds, with what the catalog
 * says about each.
 *
 * The tab that answers "what *is* in here", as opposed to the tree, which answers "what is in
 * here". The tree is a list of names you walk one at a time; this is the same objects side by side
 * with their type, their dates, their size and their comment — which is the view you want the
 * moment you are comparing them rather than opening one.
 *
 * Like the diagram, `objects` is only what the server said; which category is selected, what is
 * typed in the filter and how the grid is sorted sit beside it in `ui`, per tab and never
 * persisted — they are ways of looking at this data rather than part of it.
 */
export interface DbSchemaTab {
  id: string;
  kind: "schema";
  connectionId: string;
  /** The container listed: a schema on the SQL engines, a database on Mongo, which has no schema. */
  node: DbNodeRef;
  name: string;
  loading: boolean;
  runId: string | null;
  objects: DbObjectInfo[] | null;
  error: string | null;
  /** How this listing is being looked at — see [`DbSchemaUi`]. */
  ui: DbSchemaUi;
}

export type DbTab = DbConsoleTab | DbDataTab | DbDdlTab | DbDiagramTab | DbSchemaTab;

/** Which explorer section the sidebar is showing. */
export type DbSidebarSection = "explorer" | "history";

interface PersistedTab {
  kind: DbTab["kind"];
  connectionId: string;
  consoleId?: string | null;
  node?: DbNodeRef;
  name: string;
  body?: string;
  database?: string;
  schema?: string;
}

interface PersistedTabs {
  version: 1;
  tabs: PersistedTab[];
  activeTabId: string | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface DbState {
  workspaceId: string | null;
  loading: boolean;
  connections: DbConnectionRow[];
  /** Folder rows. Not the membership — that is still each connection's `group_name`. These exist
   *  so a group the user made and hasn't filled yet survives a reload; see `DbGroupRow`. */
  groups: DbGroupRow[];
  /** Group names the user has collapsed. Persisted, because folding away the half of the estate
   *  you are not working on is a decision worth making once rather than every launch. */
  collapsedGroups: string[];
  consoles: DbConsole[];
  history: DbQueryHistoryEntry[];
  /** Connection ids with a live session. */
  connected: string[];
  /**
   * Connection ids whose connect or disconnect is in flight right now.
   *
   * Separate from [`connected`] because it is a *third* state, not a shade of the other two. Opening
   * a session is a round trip that can take seconds — a cold Atlas cluster, an SSH tunnel being
   * raised, a DNS lookup — and with only "connected or not" the dot sat unchanged the whole time
   * and then flipped. Nothing said the click had registered, so the honest reading was that it
   * hadn't.
   */
  connecting: string[];
  /**
   * The connection the explorer is pointing at, or `null`.
   *
   * Deliberately *not* persisted and deliberately not tied to anything the tree fetches: this is
   * "which row do the ordering buttons act on", not a second notion of "the current connection" —
   * tabs already carry their own. A connection that goes away takes the selection with it.
   */
  selectedConnectionId: string | null;
  serverInfo: Record<string, DbServerInfo>;
  /** Node key → its children, as last read from the server. */
  children: Record<string, DbNode[]>;
  expanded: string[];
  loadingNodes: string[];
  /** Node key → the error expanding it produced, shown in place of children. */
  nodeErrors: Record<string, string>;
  tabs: DbTab[];
  activeTabId: string | null;
  section: DbSidebarSection;
  /** The saved console whose row in the tree is showing its name as an input, if any. Set on the
   * save that *creates* one, so a console names itself at the moment it becomes something worth
   * finding again rather than staying `Console 3` forever. */
  renamingConsoleId: string | null;

  init: (workspaceId: string) => Promise<void>;
  setWorkspace: (workspaceId: string) => Promise<void>;
  setSection: (section: DbSidebarSection) => void;

  createConnection: (
    kind: DbKind,
    name: string,
    groupName?: string,
  ) => Promise<DbConnectionRow | null>;
  saveConnection: (
    row: DbConnectionRow,
    config: DbConnectionConfig,
    password: string | null,
  ) => Promise<boolean>;
  deleteConnection: (id: string) => Promise<void>;
  /** Returns the copy, so a caller that has somewhere to put it — the dialog's list — can select it. */
  duplicateConnection: (id: string) => Promise<DbConnectionRow | null>;
  reorderConnections: (ids: string[]) => Promise<void>;
  /** Points the explorer's per-row ordering gestures at a connection, or at nothing. */
  selectConnection: (id: string | null) => void;
  /**
   * Moves a connection one place among the rows it is drawn with — its group's members, or the
   * loose list when it is in no group.
   *
   * Order is stored globally, as one list of ids, so a move inside a folder swaps the two rows'
   * places in the full list and leaves every other connection exactly where it was. The single
   * nudge, for the tree's context menu and `Alt`+arrows; [`dropConnection`] is the gesture that can
   * also carry a row into another folder.
   */
  moveConnection: (id: string, direction: -1 | 1) => Promise<void>;

  /** Creates an empty folder. Idempotent on the name — the backend deduplicates. */
  createGroup: (name: string) => Promise<void>;
  /**
   * Moves one folder a place up or down the list.
   *
   * The same shape `moveConnection` has, and offered from the same place in the menu, because it is
   * the same question one level up. A drag would be the other answer; it is not the one the tree
   * already speaks, and the folders are a short list where two clicks beat a gesture.
   *
   * A folder implied by a connection's `group_name` with no `db_groups` row of its own has no id to
   * order, so it cannot move and is not offered the row — see `groupConnections`.
   */
  moveGroup: (name: string, direction: -1 | 1) => Promise<void>;
  /** Renaming onto an existing group merges the two. */
  renameGroup: (from: string, to: string) => Promise<void>;
  /** Deletes the folder. Its connections move to ungrouped — never deleted with it. */
  deleteGroup: (name: string) => Promise<void>;
  /** Files a connection under a group, or under none with `UNGROUPED`. */
  setConnectionGroup: (id: string, group: string) => Promise<void>;
  /** Puts a connection on every workspace's shelf, or takes it back off. Leaves any open session
   *  and its SSH tunnel alone. */
  setConnectionScope: (id: string, global: boolean) => Promise<void>;
  /** Moves a connection to another workspace and files it there. */
  moveConnectionToWorkspace: (id: string, workspaceId: string) => Promise<void>;
  /** Puts a group **and its members** on every workspace's shelf, or takes them back off. */
  setGroupScope: (name: string, global: boolean) => Promise<void>;
  /** Moves a group and its members to another workspace. */
  moveGroupToWorkspace: (name: string, workspaceId: string) => Promise<void>;
  /** A dragged connection released somewhere: into `group`, ahead of `beforeConnectionId` (or last
   * in that group when it is `null`). Reorder and move-between-groups are the same gesture. */
  dropConnection: (id: string, group: string, beforeConnectionId: string | null) => Promise<void>;
  toggleGroup: (group: string) => void;
  /** Re-reads `connected` from the backend, which owns the sessions. */
  syncConnected: () => Promise<void>;
  connect: (id: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  testConnection: (config: DbConnectionConfig) => Promise<DbServerInfo>;

  toggleNode: (connectionId: string, node: DbNodeRef, key: string) => Promise<void>;
  refreshNode: (connectionId: string, node: DbNodeRef, key: string) => Promise<void>;
  /**
   * Removes a table, a view, a collection or a whole schema — from the tree, without writing SQL.
   *
   * The statement is built here (see `lib/db/dropObject.ts`) and sent through the same `db_execute`
   * a console uses, so the connection's read-only flag refuses it in exactly the place every other
   * write is refused. The caller is responsible for asking first: the confirmation names the object
   * and what goes with it, and this runs the moment it is called.
   *
   * `parent` is the tree node the dropped object hung under, re-read afterwards so the row
   * disappears. Passed in rather than derived, because "the node above this one" is a fact the tree
   * has and a `DbNodeRef` does not.
   *
   * Resolves to whether everything ran. A batch that fails halfway — the case `dropContainerSql`
   * documents for the engines with no `CASCADE` — still refreshes and still reports, because the
   * statements before the failure did take effect.
   */
  dropObject: (args: {
    connectionId: string;
    node: DbNode;
    scope: "relation" | "container";
    /** Only read for a container drop on an engine with no `CASCADE`; see `dropContainerSql`. */
    contents?: SchemaContents;
    parent: { ref: DbNodeRef; key: string };
  }) => Promise<boolean>;
  /** `refreshNode` for a reader nobody asked to be one — the SQL console's completion, which reads
   * catalog nodes the user never expanded. Fills `children` and says nothing else: no spinner on a
   * row nobody clicked, and no error painted onto the tree for a table that was a typo. `false`
   * means the read failed, which only the caller cares about. */
  warmNode: (connectionId: string, node: DbNodeRef, key: string) => Promise<boolean>;
  /** Re-reads every branch the user currently has open on one connection. For a settings change
   * that alters what the tree should list without touching the session behind it. */
  refreshOpenNodes: (connectionId: string) => Promise<void>;

  openConsole: (connectionId: string, consoleId?: string) => void;
  newConsole: (connectionId: string, database?: string, schema?: string, body?: string) => void;
  updateConsole: (tabId: string, patch: Partial<DbConsoleTab>) => void;
  saveConsole: (tabId: string) => Promise<void>;
  /** Puts a saved console's row into (or out of, with `null`) rename mode. */
  setRenamingConsole: (consoleId: string | null) => void;
  renameConsole: (consoleId: string, name: string) => Promise<void>;
  deleteConsole: (consoleId: string) => Promise<void>;
  runConsole: (tabId: string, sql?: string) => Promise<void>;
  explainConsole: (tabId: string, sql?: string) => Promise<void>;
  cancelRun: (tabId: string) => Promise<void>;

  /** Opens the console's AI ask bar, or closes it. Opening never clears the last answer — the
   * usual second question is a follow-up on what it just said. */
  toggleConsoleAi: (tabId: string) => void;
  setConsoleAiQuestion: (tabId: string, question: string) => void;
  /**
   * Empties the transcript without closing the panel.
   *
   * A conversation is what the next question is answered against, so a long one that has wandered
   * is a *cost* — the model is being shown ten turns about a different table. This is the way out
   * of that which does not also lose the panel, its scope and its place on screen.
   */
  clearConsoleAi: (tabId: string) => void;
  /** Asks the assistant, with this console's scope, text and last outcome as the context. */
  askConsoleAi: (tabId: string) => Promise<void>;
  cancelConsoleAi: (tabId: string) => Promise<void>;

  openData: (connectionId: string, node: DbNodeRef, name: string, filter?: string) => void;
  /** Opens the table a foreign-key column points at. `null` opens it whole. */
  followForeignKey: (tab: DbDataTab, key: DbForeignKey, value: string | null) => void;
  /** Writes the filter on one target — the schema list, or what one level lists. An empty pattern
   * removes it rather than matching nothing. */
  setFilter: (
    connectionId: string,
    target: DbFilterTarget,
    pattern: string,
    enabled: boolean,
  ) => Promise<void>;
  updateData: (tabId: string, patch: Partial<DbDataTab>) => void;

  /**
   * The per-tab view state — which layout, which document view, the dragged column widths.
   *
   * Separate from `updateConsole`/`updateData` on purpose: none of these persists, and none marks
   * a tab dirty. See [`DbDataUi`] for why the state sits on the tab at all.
   */
  setDataUi: (tabId: string, patch: Partial<DbDataUi>) => void;
  setConsoleUi: (tabId: string, patch: Partial<DbConsoleUi>) => void;
  setSchemaUi: (tabId: string, patch: Partial<DbSchemaUi>) => void;
  setDiagramUi: (tabId: string, patch: Partial<DbDiagramUi>) => void;
  loadData: (tabId: string) => Promise<void>;
  setCell: (tabId: string, row: number, column: string, value: string | null) => void;
  toggleDeleteRow: (tabId: string, row: number) => void;
  /** Stages (or un-stages) a set of rows for deletion in one go — what the grid's selection needs. */
  setDeletedRows: (tabId: string, rows: number[], deleted: boolean) => void;
  addRow: (tabId: string) => void;
  setInsertedCell: (tabId: string, row: number, column: string, value: string | null) => void;
  removeInsertedRow: (tabId: string, row: number) => void;
  /** Stages a whole document in place of the one at `row`. `null` drops the staged rewrite and puts
   *  the server's document back. MongoDB only — see `DbDataTab.replaced`. */
  setDocument: (tabId: string, row: number, document: string | null) => void;
  /** Stages a new document — Clone, or a document written from scratch. Returns nothing; the card
   *  appears at the end of the page, tinted like every other staged insert. */
  addDocument: (tabId: string, document: string) => void;
  setInsertedDocument: (tabId: string, index: number, document: string) => void;
  removeInsertedDocument: (tabId: string, index: number) => void;
  revertEdits: (tabId: string) => void;
  applyEdits: (tabId: string) => Promise<void>;

  openDdl: (connectionId: string, node: DbNodeRef, name: string) => Promise<void>;

  /** Opens (or brings forward) the diagram of a schema — or, on Mongo, of a database. */
  /** Opens (or focuses) the schema overview, and loads it. */
  openSchema: (connectionId: string, node: DbNodeRef, name: string) => void;
  /** Re-reads a schema overview tab. Also the retry after a failure, and what the refresh button
   * calls. */
  loadSchema: (tabId: string) => Promise<void>;
  openDiagram: (connectionId: string, node: DbNodeRef, name: string) => void;
  /** Re-reads the catalog for a diagram tab. Also what a restored tab calls to fill itself in. */
  loadDiagram: (tabId: string) => Promise<void>;

  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;

  refreshHistory: () => Promise<void>;
  deleteHistory: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;

  /** Everything the workspace has sent to a server this session, newest last. See `DbSqlLogEntry`. */
  sqlLog: DbSqlLogEntry[];
  logSql: (entry: Omit<DbSqlLogEntry, "id" | "at">) => void;
  clearSqlLog: () => void;
}

/**
 * One statement the workspace ran, for the log panel.
 *
 * The point of it is the SQL nobody typed: opening a table, turning a page, sorting a column and
 * applying an edit all send statements the user never sees, and "what did clicking that actually
 * do?" has no answer without them. So the text logged is the statement the *server* was given —
 * every entry here comes back from the backend rather than being re-generated on this side, which
 * is the only way the log can't drift from what really ran.
 *
 * In memory only. It is a window onto this session's work, not an archive — the console's own runs
 * are already kept in history, which is the thing that survives a restart.
 */
export interface DbSqlLogEntry {
  id: string;
  /** Epoch milliseconds. */
  at: number;
  /**
   * The workspace the statement was sent from, captured **before** it left — never read back off
   * the store when the answer lands.
   *
   * A statement outlives the screen that launched it: a count over a large table, a catalog read
   * on a cold server, a console query that takes minutes. By the time any of those come back the
   * user may be in another workspace looking at another estate's tree, and an entry appended then
   * is one workspace's SQL listed under another's connections — the one reading of this panel that
   * is worse than no panel at all. The stamp is what lets `logSql` recognise the late arrival and
   * leave it out.
   */
  workspaceId: string | null;
  connectionId: string;
  sql: string;
  /** What made it run: a grid, an edit batch, a console. */
  source: "grid" | "edit" | "console";
  durationMs: number | null;
  rows: number | null;
  error: string | null;
}

/** Beyond this the oldest entries are dropped: a session that pages through a big table all day
 * should not turn the log into a memory leak. */
const SQL_LOG_LIMIT = 300;

/**
 * Guards against the four callers that can race a first load (the view mounting, StrictMode
 * mounting it twice, the workspace switch and a restored session), the same latch `apiStore` uses.
 */
let pendingLoad: { workspaceId: string; promise: Promise<void> } | null = null;

/**
 * Bumped by every deliberate change to `connected`, so `syncConnected` can tell whether the answer
 * it is holding is still about the world it asked about.
 *
 * `syncConnected` replaces the whole array with what the backend said a round trip ago, and it is
 * the only writer that does — the others all derive from the current state. Without this, a sync
 * that left before the user pressed Disconnect can land after it and put the connection back.
 */
let connectedEpoch = 0;

export function ensureDbStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return Promise.resolve();
  return useDbStore.getState().setWorkspace(workspaceId);
}

/**
 * Connections by group: the ungrouped bucket first, then the groups alphabetically.
 *
 * The explorer splits the result rather than drawing it in this order — the folders at the top, the
 * ungrouped connections loose underneath — so the position of the `UNGROUPED` entry is a
 * convention for callers that read it by name, not a layout. The bucket is only present when
 * something is in it: a tree with every connection filed has nothing ungrouped to draw.
 */
export function groupConnections(
  connections: DbConnectionRow[],
  folders: DbGroupRow[] = [],
): [string, DbConnectionRow[]][] {
  const groups = new Map<string, DbConnectionRow[]>();
  // The folder rows go in first, so a group the user created and hasn't filled still gets a
  // heading — the whole reason those rows exist. A group named by a connection but with no row of
  // its own (a restored backup, a rename in flight) is added by the loop below and reads
  // identically.
  for (const folder of folders) groups.set(folder.name.trim(), []);
  for (const connection of connections) {
    const key = connection.group_name.trim();
    const bucket = groups.get(key);
    if (bucket) bucket.push(connection);
    else groups.set(key, [connection]);
  }
  // An ungrouped bucket that nothing fell into is a heading over nothing.
  if (groups.get(UNGROUPED)?.length === 0) groups.delete(UNGROUPED);

  // The order the folders were *given* in, which is `db_groups.sort_order` — `load_tree` reads them
  // `ORDER BY sort_order, name`. This used to sort alphabetically here, which threw that away and
  // made the column unreachable: a user with `Prod`, `Staging` and `Local` could not put them in
  // that order, only in that spelling. A group with no row of its own — a `group_name` nobody
  // created, which the loop above adds — has no `sort_order` to place it by, so it goes after the
  // real folders and among those it is alphabetical.
  const rank = new Map(folders.map((folder, at) => [folder.name.trim(), at]));
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNGROUPED) return -1;
    if (b === UNGROUPED) return 1;
    const rankA = rank.get(a);
    const rankB = rank.get(b);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.localeCompare(b);
  });
}

/**
 * The full order with one connection and the neighbour it would trade places with swapped, or
 * `null` when there is no such neighbour — the first row of a group asked to go up, an id that is
 * no longer there.
 *
 * "Neighbour" means the next connection *in the same group*, not the next one in the list: the
 * tree draws each folder as its own column of rows, so moving up inside one has to skip past
 * whatever happens to sit between them globally. Returning the whole list rather than mutating is
 * what lets the caller hand it straight to `reorderConnections`, which is a list-shaped API because
 * the backend's is.
 */
function swapWithNeighbour(
  connections: DbConnectionRow[],
  id: string,
  direction: -1 | 1,
): string[] | null {
  const row = connections.find((c) => c.id === id);
  if (!row) return null;
  const siblings = connections.filter((c) => c.group_name.trim() === row.group_name.trim());
  const neighbour = siblings[siblings.findIndex((c) => c.id === id) + direction];
  if (!neighbour) return null;
  const ids = connections.map((c) => c.id);
  const from = ids.indexOf(id);
  const to = ids.indexOf(neighbour.id);
  if (from < 0 || to < 0) return null;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  return ids;
}

/** Identifies a node in the `children` cache. Includes the connection, so two connections'
 * identically-named schemas never share an entry. */
export function nodeKey(connectionId: string, node: DbNodeRef): string {
  return [connectionId, node.kind, node.database ?? "", node.schema ?? "", node.name ?? ""].join("|");
}

/** [`nodeKey`] read backwards, for the one caller that has keys and needs the nodes they name:
 * re-reading the branches the user has open. The empty string is how a `null` was written, so it
 * comes back as one. */
function nodeFromKey(key: string): DbNodeRef {
  const [, kind, database, schema, name] = key.split("|");
  return {
    kind: kind as DbNodeRef["kind"],
    database: database || null,
    schema: schema || null,
    name: name || null,
  };
}

/**
 * Whether an edit changes only what the explorer *lists*, and not what it is talking to.
 *
 * The two schema fields decide which branches the tree shows, and `object_filter` which rows appear
 * inside them; every other field is part of reaching the server — host, port, credentials, SSL,
 * the SSH tunnel, the startup script that runs on connect. So this is written as "everything that
 * matters is unchanged" rather than "one of these two changed": a field added to the config later
 * is a field this refuses to keep the session for until somebody has thought about it, which is the
 * failure that costs a reconnect rather than the one that queries the wrong database.
 */
function onlyChangesWhatIsListed(before: DbConnectionConfig, after: DbConnectionConfig): boolean {
  return (
    before.kind === after.kind &&
    before.host === after.host &&
    before.port === after.port &&
    before.database === after.database &&
    before.user === after.user &&
    before.url === after.url &&
    before.ssl === after.ssl &&
    before.read_only === after.read_only &&
    before.connect_timeout_ms === after.connect_timeout_ms &&
    before.show_all_databases === after.show_all_databases &&
    before.keep_alive_secs === after.keep_alive_secs &&
    before.auto_disconnect_secs === after.auto_disconnect_secs &&
    before.startup_script === after.startup_script &&
    before.ssl_ca_file === after.ssl_ca_file &&
    before.ssl_cert_file === after.ssl_cert_file &&
    before.ssl_key_file === after.ssl_key_file &&
    before.ssh_enabled === after.ssh_enabled &&
    before.ssh_host === after.ssh_host &&
    before.ssh_port === after.ssh_port &&
    before.ssh_user === after.ssh_user &&
    before.ssh_key_file === after.ssh_key_file &&
    before.auth_method === after.auth_method &&
    before.tenant_id === after.tenant_id &&
    before.options.length === after.options.length &&
    before.options.every(([key, value], i) => after.options[i]?.[0] === key && after.options[i]?.[1] === value)
  );
}

export const useDbStore = create<DbState>((set, get) => ({
  workspaceId: null,
  loading: false,
  connections: [],
  groups: [],
  collapsedGroups: [],
  consoles: [],
  history: [],
  connected: [],
  connecting: [],
  selectedConnectionId: null,
  serverInfo: {},
  children: {},
  expanded: [],
  loadingNodes: [],
  nodeErrors: {},
  tabs: [],
  activeTabId: null,
  section: "explorer",
  renamingConsoleId: null,
  sqlLog: [],

  init: async (workspaceId) => {
    set({ workspaceId, loading: true });
    try {
      const [tree, history, connected, rawTabs, collapsed] = await Promise.all([
        dbLoadTree(workspaceId),
        dbListHistory(workspaceId, HISTORY_LIMIT),
        dbConnected().catch(() => [] as string[]),
        getSetting(openTabsKey(workspaceId)).catch(() => null),
        getSetting(collapsedKey(workspaceId))
          .then((raw) => parseJson<string[]>(raw, []))
          .catch(() => [] as string[]),
      ]);
      // Two switches in quick succession leave two loads in flight; the one whose workspace is no
      // longer selected must not publish its data.
      if (get().workspaceId !== workspaceId) return;

      const restored = parseJson<PersistedTabs | null>(rawTabs, null);
      const tabs =
        restored?.version === 1
          ? restored.tabs
              // A connection deleted since the tabs were written leaves tabs pointing at nothing.
              .filter((tab) => tree.connections.some((c) => c.id === tab.connectionId))
              .map((tab) => rehydrateTab(tab, tree))
          : [];

      set({
        connections: tree.connections,
        groups: tree.groups,
        collapsedGroups: Array.isArray(collapsed) ? collapsed : [],
        consoles: tree.consoles,
        history,
        connected,
        tabs,
        activeTabId: tabs[0]?.id ?? null,
      });
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      if (get().workspaceId === workspaceId) set({ loading: false });
    }
  },

  setWorkspace: async (workspaceId) => {
    if (pendingLoad?.workspaceId === workspaceId) return pendingLoad.promise;
    // Cleared rather than left to be overwritten: for the length of the load the view would
    // otherwise still show the workspace the user just left — including its tree and its results.
    //
    // **Nothing in flight is cancelled here, and that is deliberate.** Walking to another workspace
    // is not the same decision as closing a tab: four queries and an assistant left running in this
    // one are meant to still be running when the user comes back, which is why every one of them
    // carries the workspace it started in (`askConsoleAi`'s run, `recordHistory`'s row, each
    // `logSql` entry) rather than being identified by whichever tree happens to be loaded. Closing a
    // tab *is* that decision, and `closeTab` cancels there. The cost is that a result landing after
    // the switch has no tab left to be drawn into — which is what the run's own notification is for.
    set({
      connections: [],
      groups: [],
      collapsedGroups: [],
      consoles: [],
      history: [],
      children: {},
      expanded: [],
      nodeErrors: {},
      serverInfo: {},
      tabs: [],
      activeTabId: null,
      // The log is per workspace like everything above it: its rows name connections that are being
      // emptied on the line before, so keeping them would leave the panel describing statements
      // against a tree the user can no longer see. Statements still running keep their own stamp —
      // see `DbSqlLogEntry.workspaceId` — so they cannot refill it from behind either.
      sqlLog: [],
    });
    const promise = get().init(workspaceId);
    pendingLoad = { workspaceId, promise };
    return promise;
  },

  setSection: (section) => set({ section }),

  // ------------------------------------------------------------- connections

  createConnection: async (kind, name, groupName = UNGROUPED) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    const config = defaultConnectionConfig(kind);
    return guarded(async () => {
      const row = await dbCreateConnection(
        workspaceId,
        name,
        groupName,
        kind,
        JSON.stringify(config),
        "",
      );
      set((s) => ({ connections: [...s.connections, row] }));
      return row;
    });
  },

  saveConnection: async (row, config, password) => {
    // The password is stored separately and never lands in `spec`: that column is plain text in the
    // config directory, and the keychain is the only place a database credential belongs.
    const spec = JSON.stringify({ ...config, password: "" });
    const next: DbConnectionRow = { ...row, kind: config.kind, spec };
    // `row` still carries the settings as they were, which is what makes this decidable here and
    // nowhere else. A password the user retyped counts as a change whatever the fields say.
    const previous = parseSpec(row);
    const keepSession =
      password === null && previous !== null && onlyChangesWhatIsListed(previous, config);
    const saved = await guarded(async () => {
      await dbUpdateConnection(next, keepSession);
      if (password !== null) await dbSetPassword(row.id, password);
      return true;
    });
    if (!saved) return false;

    if (keepSession) {
      // The session is the same one, so the dot stays lit and the tree stays where the user left
      // it. What *is* stale is every list read under the old visibility — a schema just unticked is
      // still sitting in `children`. Dropping it and re-reading the open nodes is what makes the
      // change show up in the tree at once, instead of after a manual refresh of each one.
      set((s) => ({
        connections: s.connections.map((c) => (c.id === next.id ? next : c)),
        children: dropConnection(s.children, next.id),
      }));
      await get().refreshOpenNodes(next.id);
      return true;
    }

    connectedEpoch += 1;
    set((s) => ({
      connections: s.connections.map((c) => (c.id === next.id ? next : c)),
      // Saving closed the session on the backend, so the dot has to go with it.
      connected: s.connected.filter((id) => id !== next.id),
      // Anything cached about the old server is now about a server we may not be talking to.
      children: dropConnection(s.children, next.id),
      expanded: s.expanded.filter((key) => !key.startsWith(`${next.id}|`)),
    }));
    return true;
  },

  refreshOpenNodes: async (connectionId) => {
    const prefix = `${connectionId}|`;
    const keys = get().expanded.filter((key) => key.startsWith(prefix));
    // Concurrently: these are independent reads of sibling branches, and doing them one after
    // another makes a tree with a few schemas open feel like a reconnect — which is the thing this
    // whole path exists to avoid.
    await Promise.all(keys.map((key) => get().refreshNode(connectionId, nodeFromKey(key), key)));
  },

  deleteConnection: async (id) => {
    await guarded(async () => {
      await dbDeleteConnection(id);
      connectedEpoch += 1;
      set((s) => ({
        connections: s.connections.filter((c) => c.id !== id),
        consoles: s.consoles.filter((c) => c.connection_id !== id),
        connected: s.connected.filter((c) => c !== id),
        // A selection pointing at a row that no longer exists would leave the ordering arrows
        // enabled and acting on nothing.
        selectedConnectionId: s.selectedConnectionId === id ? null : s.selectedConnectionId,
        children: dropConnection(s.children, id),
        expanded: s.expanded.filter((key) => !key.startsWith(`${id}|`)),
        tabs: s.tabs.filter((tab) => tab.connectionId !== id),
      }));
      const remaining = get().tabs;
      if (!remaining.some((tab) => tab.id === get().activeTabId)) {
        set({ activeTabId: remaining[0]?.id ?? null });
      }
      persistTabs(get);
      return true;
    });
  },

  duplicateConnection: async (id) => {
    let copy: DbConnectionRow | null = null;
    await guarded(async () => {
      copy = await dbDuplicateConnection(id);
      set((s) => ({ connections: [...s.connections, copy as DbConnectionRow] }));
      return true;
    });
    return copy;
  },

  reorderConnections: async (ids) => {
    // Applied locally first: a drag that waits for a round trip looks like it didn't take.
    set((s) => ({
      connections: [...s.connections].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
    }));
    await guarded(() => dbReorderConnections(ids));
  },

  selectConnection: (id) => set({ selectedConnectionId: id }),

  moveConnection: async (id, direction) => {
    const swapped = swapWithNeighbour(get().connections, id, direction);
    if (swapped) await get().reorderConnections(swapped);
  },

  // ------------------------------------------------------------------ groups

  moveGroup: async (name, direction) => {
    const groups = get().groups;
    const at = groups.findIndex((group) => group.name.trim() === name.trim());
    const swap = at + direction;
    if (at < 0 || swap < 0 || swap >= groups.length) return;
    const next = [...groups];
    [next[at], next[swap]] = [next[swap], next[at]];
    // Optimistic, the way `reorderConnections` is: the folder is where it was dropped before the
    // write goes out, because a list that snaps back for a frame reads as a refused action.
    set({ groups: next });
    try {
      await dbReorderGroups(next.map((group) => group.id));
    } catch (e) {
      pushErrorToast(String(e));
      set({ groups });
    }
  },

  createGroup: async (name) => {
    const workspaceId = get().workspaceId;
    const trimmed = name.trim();
    // The ungrouped bucket is the absence of a group, not a group called "". Creating it would put
    // a folder in the tree that every connection without one already falls into.
    if (!workspaceId || !trimmed) return;
    const row = await guarded(() => dbCreateGroup(workspaceId, trimmed));
    if (!row) return;
    // Written from the reply rather than optimistically: the backend deduplicates by name, so
    // "New group" on a name that already exists must add nothing rather than a second row.
    set((s) => ({
      groups: s.groups.some((group) => group.name === row.name) ? s.groups : [...s.groups, row],
    }));
  },

  renameGroup: async (from, to) => {
    const workspaceId = get().workspaceId;
    const target = to.trim();
    if (!workspaceId || from === target || !target || from === UNGROUPED) return;
    set((s) => ({
      connections: s.connections.map((c) =>
        c.group_name === from ? { ...c, group_name: target } : c,
      ),
      // Renaming onto an existing name merges, so the folder rows have to collapse the same way —
      // otherwise the tree would briefly show the target twice.
      groups: s.groups
        .map((group) => (group.name === from ? { ...group, name: target } : group))
        .filter((group, i, all) => all.findIndex((other) => other.name === group.name) === i),
      collapsedGroups: [
        ...new Set(s.collapsedGroups.map((name) => (name === from ? target : name))),
      ],
    }));
    if (!(await guarded(() => dbRenameGroup(workspaceId, from, target)))) void get().init(workspaceId);
  },

  deleteGroup: async (name) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId || name === UNGROUPED) return;
    set((s) => ({
      // The connections stay; they lose the folder, not their existence — and with it neither
      // their consoles nor their saved password.
      connections: s.connections.map((c) =>
        c.group_name === name ? { ...c, group_name: UNGROUPED } : c,
      ),
      groups: s.groups.filter((group) => group.name !== name),
      collapsedGroups: s.collapsedGroups.filter((entry) => entry !== name),
    }));
    if (!(await guarded(() => dbDeleteGroup(workspaceId, name)))) void get().init(workspaceId);
  },

  setConnectionScope: async (id, global) => {
    const previous = get().connections;
    const scope = global ? "global" : "workspace";
    set({ connections: previous.map((c) => (c.id === id ? { ...c, scope } : c)) });
    if (!(await guarded(() => dbSetConnectionScope(id, global)))) set({ connections: previous });
  },

  moveConnectionToWorkspace: async (id, workspaceId) => {
    const from = get().workspaceId;
    if (!from) return;
    if (!(await guarded(() => dbMoveConnectionToWorkspace(id, workspaceId)))) return;
    // The connection leaves this workspace's tree entirely, taking its consoles with it, so the
    // honest move is to reload rather than to patch a row out of three lists.
    void get().init(from);
  },

  setGroupScope: async (name, global) => {
    const workspaceId = get().workspaceId;
    // `UNGROUPED` is the absence of a group, not a group called "". Re-scoping it would ask the
    // backend to write a literal empty name onto every deliberately-ungrouped connection.
    if (!workspaceId || name === UNGROUPED) return;
    const previousGroups = get().groups;
    const previousConnections = get().connections;
    const scope = global ? "global" : "workspace";
    // The members move with the folder, exactly as `set_group_scope` does in SQL: a group whose
    // connections stayed behind renders as an empty folder on every other workspace's shelf.
    set({
      groups: previousGroups.map((group) => (group.name === name ? { ...group, scope } : group)),
      connections: previousConnections.map((c) =>
        c.group_name === name ? { ...c, scope } : c,
      ),
    });
    if (!(await guarded(() => dbSetGroupScope(workspaceId, name, global)))) {
      set({ groups: previousGroups, connections: previousConnections });
    }
  },

  moveGroupToWorkspace: async (name, workspaceId) => {
    const from = get().workspaceId;
    if (!from || name === UNGROUPED) return;
    if (!(await guarded(() => dbMoveGroupToWorkspace(from, name, workspaceId)))) return;
    void get().init(from);
  },

  setConnectionGroup: async (id, group) => {
    const target = group.trim();
    if (get().connections.find((c) => c.id === id)?.group_name === target) return;
    set((s) => ({
      connections: s.connections.map((c) => (c.id === id ? { ...c, group_name: target } : c)),
    }));
    await guarded(() => dbSetConnectionGroup(id, target));
  },

  /**
   * Where a drag ends.
   *
   * The order the backend keeps is one flat list for the whole workspace, and the groups are drawn
   * over it — so a move is expressed as "take this row out and put it back at that index", and the
   * group is a separate field written alongside. Both, in that order: `reorder` writes positions,
   * and doing the group second would leave a frame where the row sits in its new place under its
   * old heading.
   *
   * Applied locally first, in one `set`, so the row never blinks through an intermediate list —
   * the same reason `reorderConnections` does it.
   */
  dropConnection: async (id, group, beforeConnectionId) => {
    const connections = get().connections;
    const moving = connections.find((c) => c.id === id);
    if (!moving || id === beforeConnectionId) return;

    const target = group.trim();
    const without = connections.filter((c) => c.id !== id);
    const moved = { ...moving, group_name: target };
    const at = beforeConnectionId ? without.findIndex((c) => c.id === beforeConnectionId) : -1;
    const next =
      at >= 0
        ? [...without.slice(0, at), moved, ...without.slice(at)]
        : [...without, moved];
    set({ connections: next });

    if (moving.group_name !== target) {
      await guarded(() => dbSetConnectionGroup(id, target));
    }
    await guarded(() => dbReorderConnections(next.map((c) => c.id)));
  },

  toggleGroup: (group) => {
    const workspaceId = get().workspaceId;
    const collapsed = get().collapsedGroups.includes(group)
      ? get().collapsedGroups.filter((name) => name !== group)
      : [...get().collapsedGroups, group];
    set({ collapsedGroups: collapsed });
    if (workspaceId) void setSetting(collapsedKey(workspaceId), JSON.stringify(collapsed)).catch(() => {});
  },

  /**
   * Re-reads which connections the backend actually has a session for.
   *
   * `connected` is otherwise maintained optimistically — `connect` adds, `disconnect` removes — and
   * the backend opens and closes sessions on its own behind that: every command reconnects lazily,
   * the idle sweep expires, and closing the window to the background releases whatever is idle. Both
   * kinds of drift are bad, and the second is worse than it looks: a session the explorer doesn't
   * know about still shows the row's menu offering *Connect*, so the one command that would release
   * it is the one the user cannot reach.
   *
   * Cheap enough to call freely — it is a read of a `HashMap` in the same process.
   */
  syncConnected: async () => {
    const epoch = connectedEpoch;
    const connected = await dbConnected().catch(() => null);
    // Dropped rather than merged: what arrived describes the registry before the user's own action,
    // and merging it would be how a connection they just released reappears as connected.
    if (connected === null || epoch !== connectedEpoch) return;
    set({ connected });
  },

  connect: async (id) => {
    // Marked before the await and cleared in `finally`, so a connection that fails stops looking
    // busy rather than spinning until the next click.
    set((s) => ({ connecting: s.connecting.includes(id) ? s.connecting : [...s.connecting, id] }));
    try {
      const info = await guarded(() => dbConnect(id));
      if (!info) return false;
      connectedEpoch += 1;
      set((s) => ({
        connected: s.connected.includes(id) ? s.connected : [...s.connected, id],
        serverInfo: { ...s.serverInfo, [id]: info },
      }));
      return true;
    } finally {
      set((s) => ({ connecting: s.connecting.filter((c) => c !== id) }));
    }
  },

  disconnect: async (id) => {
    // Shown for the same reason as connecting: closing a pooled session, tearing down an SSH
    // tunnel and waiting on a server that is mid-query are all slower than the click.
    set((s) => ({ connecting: s.connecting.includes(id) ? s.connecting : [...s.connecting, id] }));
    try {
      await guarded(() => dbDisconnect(id));
      connectedEpoch += 1;
      set((s) => ({
        connected: s.connected.filter((c) => c !== id),
        children: dropConnection(s.children, id),
        expanded: s.expanded.filter((key) => !key.startsWith(`${id}|`)),
      }));
    } finally {
      set((s) => ({ connecting: s.connecting.filter((c) => c !== id) }));
    }
  },

  /** Throws rather than toasting: the connection dialog shows the result inline, next to the
   * fields the user is about to fix. */
  testConnection: (config) => dbConnect(config.id, config),

  // ---------------------------------------------------------------- explorer

  toggleNode: async (connectionId, node, key) => {
    const expanded = get().expanded;
    if (expanded.includes(key)) {
      set({ expanded: expanded.filter((entry) => entry !== key) });
      return;
    }
    set({ expanded: [...expanded, key] });
    // Already read once — collapsing and re-expanding shouldn't re-query. `refreshNode` is the
    // explicit way to re-ask.
    if (get().children[key]) return;
    await get().refreshNode(connectionId, node, key);
  },

  refreshNode: async (connectionId, node, key) => {
    set((s) => ({
      loadingNodes: [...s.loadingNodes, key],
      nodeErrors: omit(s.nodeErrors, key),
    }));
    try {
      const children = await dbChildren(connectionId, node);
      set((s) => ({
        children: { ...s.children, [key]: children },
        // Reaching the server means there is a session, whether or not "Connect" was ever clicked.
        connected: s.connected.includes(connectionId)
          ? s.connected
          : [...s.connected, connectionId],
      }));
    } catch (e) {
      // Shown against the node rather than as a toast: "permission denied on schema auth" is about
      // that row, and a toast would leave the tree looking merely empty.
      set((s) => ({ nodeErrors: { ...s.nodeErrors, [key]: String(e) } }));
    } finally {
      set((s) => ({ loadingNodes: s.loadingNodes.filter((entry) => entry !== key) }));
    }
  },

  warmNode: async (connectionId, node, key) => {
    // Deliberately none of `refreshNode`'s bookkeeping. A warm is nobody's request: the SQL console
    // reads the columns of a table you *named in a query* and the tables of a schema you only
    // mentioned, so its spinner would appear on rows the user is not touching and — the reason this
    // exists — its failures would paint an error onto them. `from usres` must not put a red row in
    // the explorer. The result is written where the tree will find it and nothing else is said.
    if (get().children[key]) return true;
    try {
      const children = await dbChildren(connectionId, node);
      set((s) => ({
        // Never over an answer that arrived while this was in flight: the explorer's own read is
        // the newer one, and it is the one the user is looking at.
        children: s.children[key] ? s.children : { ...s.children, [key]: children },
        connected: s.connected.includes(connectionId)
          ? s.connected
          : [...s.connected, connectionId],
      }));
      return true;
    } catch {
      return false;
    }
  },

  dropObject: async ({ connectionId, node, scope, contents, parent }) => {
    const kind = get().connections.find((c) => c.id === connectionId)?.kind;
    if (!kind) return false;
    const sql =
      scope === "relation"
        ? dropRelationSql(node, kind)
        : dropContainerSql(node, kind, contents ?? { tables: [], views: [] });
    // `null` means this engine has no such operation. The menu already refuses to offer the row, so
    // reaching here is a bug rather than a user action — and silence is the right answer to it.
    if (!sql) return false;

    const runId = newRunId();
    // The scope the statement runs in. A Mongo `dropDatabase` is the reason this is not always the
    // console's current context: `db` in that shell *is* `ctx.database`, so dropping the database
    // you right-clicked means naming it here. `max_rows: 0` — a DROP returns nothing to cap.
    const ctx = {
      database: node.database ?? null,
      schema: scope === "relation" ? node.schema ?? null : null,
      max_rows: 0,
    };

    const result = await guarded(() => dbExecute(connectionId, sql, ctx, runId));
    // The tree is re-read either way: a batch that failed on its fourth statement still dropped
    // three tables, and a tree that goes on listing them is worse than one that is a little ahead
    // of the error message.
    await get().refreshNode(connectionId, parent.ref, parent.key);
    void get().syncConnected();
    if (!result) return false;

    // `db_execute` resolves for a statement the server *rejected* — the error rides on the result
    // rather than on the promise, which is what lets a console show four green rows and one red
    // one. Here there is no grid to show it in, so the first failure becomes the toast.
    const failed = result.results.find((entry) => entry.error);
    if (failed?.error) {
      pushErrorToast(failed.error);
      return false;
    }

    // Tabs opened on what has just been dropped. A data grid pointed at a table that no longer
    // exists is a panel that can only ever error, and its refresh runs on a timer — so it would
    // keep erroring. Compared on the ref rather than the name so a table dropped in one schema
    // leaves a same-named one in another alone. A container drop takes everything under it, which
    // `sameNode` cannot express: the match there is on database and schema.
    const gone = get().tabs.filter((tab) => {
      if (tab.connectionId !== connectionId) return false;
      if (!("node" in tab)) return false;
      if (scope === "relation") return sameNode(tab.node, nodeRefOf(node));
      const schema = node.schema ?? node.name;
      return (tab.node.database ?? "") === (node.database ?? "") && (tab.node.schema ?? "") === schema;
    });
    for (const tab of gone) get().closeTab(tab.id);

    useToastStore
      .getState()
      .pushToast(translate("db.dropDone", { name: node.name }), "success");
    return true;
  },

  // ---------------------------------------------------------------- consoles

  openConsole: (connectionId, consoleId) => {
    if (consoleId) {
      const existing = get().tabs.find(
        (tab) => tab.kind === "console" && tab.consoleId === consoleId,
      );
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }
      const saved = get().consoles.find((c) => c.id === consoleId);
      if (saved) {
        addTab(set, get, {
          id: newId(),
          kind: "console",
          connectionId,
          consoleId: saved.id,
          name: saved.name,
          body: saved.body,
          database: saved.database_name,
          schema: saved.schema_name,
          maxRows: DEFAULT_MAX_ROWS,
          dirty: false,
          running: false,
          runId: null,
          result: null,
          activeResult: 0,
          plan: null,
          ai: null,
          ui: DEFAULT_CONSOLE_UI,
        });
        return;
      }
    }
    get().newConsole(connectionId);
  },

  newConsole: (connectionId, database, schema, body) => {
    const connection = get().connections.find((c) => c.id === connectionId);
    const config = connection ? parseSpec(connection) : null;
    addTab(set, get, {
      id: newId(),
      kind: "console",
      connectionId,
      consoleId: null,
      name: `Console ${get().tabs.filter((tab) => tab.kind === "console").length + 1}`,
      body: body ?? "",
      database: database ?? config?.database ?? "",
      schema: schema ?? "",
      maxRows: DEFAULT_MAX_ROWS,
      dirty: (body ?? "").length > 0,
      running: false,
      runId: null,
      result: null,
      activeResult: 0,
      plan: null,
      ai: null,
      ui: DEFAULT_CONSOLE_UI,
    });
  },

  updateConsole: (tabId, patch) => {
    patchTab<DbConsoleTab>(set, tabId, "console", (tab) => ({ ...tab, ...patch }));
    if (patch.body !== undefined || patch.name !== undefined) persistTabs(get);
  },

  saveConsole: async (tabId) => {
    const tab = findTab<DbConsoleTab>(get, tabId, "console");
    if (!tab) return;
    await guarded(async () => {
      if (tab.consoleId) {
        const existing = get().consoles.find((c) => c.id === tab.consoleId);
        if (!existing) return true;
        const next: DbConsole = {
          ...existing,
          name: tab.name,
          body: tab.body,
          database_name: tab.database,
          schema_name: tab.schema,
        };
        await dbUpdateConsole(next);
        set((s) => ({ consoles: s.consoles.map((c) => (c.id === next.id ? next : c)) }));
      } else {
        const created = await dbCreateConsole(
          tab.connectionId,
          tab.name,
          tab.body,
          tab.database,
          tab.schema,
        );
        set((s) => ({ consoles: [...s.consoles, created] }));
        patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
          ...current,
          consoleId: created.id,
        }));
        // A console lands in a folder the user may have closed, under a name the app chose. Opening
        // the connection and putting the new row straight into rename mode is the naming prompt —
        // without a dialog in front of the editor to dismiss, and skippable by carrying on typing.
        //
        // Only `expanded` is written, never a fetch: saving a console is a local act, and making it
        // open a session against the server would be a surprising thing for ⌘S to do.
        const rootKey = nodeKey(tab.connectionId, {
          kind: "root",
          database: null,
          schema: null,
          name: null,
        });
        set((s) => ({
          expanded: s.expanded.includes(rootKey) ? s.expanded : [...s.expanded, rootKey],
          renamingConsoleId: created.id,
        }));
      }
      patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({ ...current, dirty: false }));
      persistTabs(get);
      return true;
    });
  },

  setRenamingConsole: (consoleId) => set({ renamingConsoleId: consoleId }),

  renameConsole: async (consoleId, name) => {
    const trimmed = name.trim();
    const existing = get().consoles.find((c) => c.id === consoleId);
    // Out of rename mode first, whatever happens next: leaving the row as an input because the
    // write failed would trap the user in a field that keeps failing.
    set({ renamingConsoleId: null });
    if (!existing || !trimmed || trimmed === existing.name) return;
    const next: DbConsole = { ...existing, name: trimmed };
    await guarded(async () => {
      await dbUpdateConsole(next);
      set((s) => ({
        consoles: s.consoles.map((c) => (c.id === next.id ? next : c)),
        // The open tab carries the same name and `saveConsole` writes it back, so leaving it stale
        // would rename the console and then quietly rename it back on the next ⌘S.
        tabs: s.tabs.map((tab) =>
          tab.kind === "console" && tab.consoleId === consoleId ? { ...tab, name: trimmed } : tab,
        ),
      }));
      persistTabs(get);
      return true;
    });
  },

  deleteConsole: async (consoleId) => {
    await guarded(async () => {
      await dbDeleteConsole(consoleId);
      set((s) => ({
        consoles: s.consoles.filter((c) => c.id !== consoleId),
        // The tab stays open, as a scratch console: the text is still on screen and the user did
        // not ask to lose it.
        tabs: s.tabs.map((tab) =>
          tab.kind === "console" && tab.consoleId === consoleId
            ? { ...tab, consoleId: null, dirty: true }
            : tab,
        ),
      }));
      return true;
    });
  },

  runConsole: async (tabId, sql) => {
    const tab = findTab<DbConsoleTab>(get, tabId, "console");
    if (!tab || tab.running) return;
    const statement = (sql ?? tab.body).trim();
    if (!statement) return;

    // The one statement that is never a typo you can recover from. See `unguardedDelete`.
    const kind = get().connections.find((c) => c.id === tab.connectionId)?.kind;
    if (kind && engineInfo(kind).sql) {
      const unguarded = unguardedDelete(statement);
      if (unguarded) {
        pushErrorToast(translate("db.deleteNeedsWhere", { statement: unguarded }));
        return;
      }
    }
    // Redis's equivalent, and a copy of the driver's own check — the backend refuses these too and
    // is what actually protects the server. This one only makes the refusal instant. See
    // `redisGuards`.
    if (kind && engineInfo(kind).consoleLanguage === "redis") {
      const refused = firstRefusedRedisCommand(statement);
      if (refused) {
        pushErrorToast(translate("db.redisRefused", { command: refused }));
        return;
      }
    }

    const runId = newRunId();
    patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
      ...current,
      running: true,
      runId,
      plan: null,
      result: null,
    }));

    // Who this statement belongs to, taken now and carried through every write below. A query can
    // take minutes; reading the workspace — or the connection's name — off the store when it comes
    // back reads whatever the user has since switched to, which is how a history row ended up filed
    // under another workspace with an empty `connection_name` (that list is emptied on the switch,
    // so the lookup found nothing to name).
    const runWorkspaceId = get().workspaceId;
    const connectionName = get().connections.find((c) => c.id === tab.connectionId)?.name ?? "";

    const started = Date.now();
    try {
      const result = await dbExecute(tab.connectionId, statement, contextOf(tab), runId);
      patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
        ...current,
        result,
        // The first result with rows, so a `BEGIN; SELECT …; COMMIT;` batch lands on the SELECT
        // rather than on an empty transaction-control result.
        activeResult: Math.max(
          0,
          result.results.findIndex((entry) => entry.columns.length > 0),
        ),
        // Back to the document list on every new result: a `find()` is read as documents, and a
        // view chosen for the last statement should not silently apply to the next one, which may
        // not even be the same shape.
        //
        // Reset here rather than in an effect on `[tab.result]` in the panel, which is where it
        // used to live: one `SqlConsolePanel` serves every console tab, so that effect fired on
        // every *tab switch* too — each tab carries its own `result` object — and would wipe the
        // remembered view the instant the tab was opened.
        ui: { ...current.ui, docView: "documents" },
      }));
      for (const entry of result.results) {
        get().logSql({
          workspaceId: runWorkspaceId,
          connectionId: tab.connectionId,
          sql: entry.statement,
          source: "console",
          durationMs: entry.duration_ms,
          rows: entry.columns.length > 0 ? entry.rows.length : entry.rows_affected,
          error: entry.error,
        });
      }
      if (runWorkspaceId) {
        await recordHistory(
          get,
          tab,
          statement,
          result,
          Date.now() - started,
          runWorkspaceId,
          connectionName,
        );
      }
    } catch (e) {
      const message = String(e);
      patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
        ...current,
        result: {
          results: [
            {
              statement,
              columns: [],
              rows: [],
              documents: [],
              rows_affected: null,
              duration_ms: Date.now() - started,
              truncated: false,
              messages: [],
              error: message,
            },
          ],
          duration_ms: Date.now() - started,
        },
        activeResult: 0,
        // A failed statement is still a new result — same reason as the success path above.
        ui: { ...current.ui, docView: "documents" },
      }));
    } finally {
      patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
        ...current,
        running: false,
        runId: null,
      }));
      // Running a statement is the one path that opens a session without ever touching the tree, so
      // it is where the explorer's dot most reliably went stale: a console restored on startup would
      // connect for real and still be drawn — and offered in the menu — as disconnected, leaving the
      // session it just opened with no way to release it.
      void get().syncConnected();
    }
  },

  explainConsole: async (tabId, sql) => {
    const tab = findTab<DbConsoleTab>(get, tabId, "console");
    if (!tab || tab.running) return;
    const statement = (sql ?? tab.body).trim();
    if (!statement) return;
    const runId = newRunId();
    patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
      ...current,
      running: true,
      runId,
    }));
    try {
      const plan = await dbExplain(tab.connectionId, statement, contextOf(tab), runId);
      patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
        ...current,
        plan,
        result: null,
      }));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
        ...current,
        running: false,
        runId: null,
      }));
      void get().syncConnected();
    }
  },

  cancelRun: async (tabId) => {
    const tab = get().tabs.find((entry) => entry.id === tabId);
    if (!tab) return;
    // Asked structurally rather than by listing the kinds that have a `runId`. The list was
    // `console | data | diagram` and had silently fallen behind: the schema tab grew a `runId` — its
    // catalog read is one of the slowest things the workspace sends — and closing it cancelled
    // nothing. A new cancellable tab kind shouldn't have to remember to come back here.
    //
    // The console's assistant is deliberately **not** collected here even though it is a run on the
    // same tab: it lives in the other registry (`cancel_ai_run`, not `db_cancel`), and this is what
    // the statement's own Cancel button calls — stopping a query the user regrets must not also kill
    // the question they asked about it. Its two stops are `cancelConsoleAi` (the ask bar's button)
    // and `closeTab`, which takes the whole tab and everything on it.
    const runIds = [
      "runId" in tab ? tab.runId : null,
      // The row count is a second run of its own: on a big table it is the full scan while the page
      // beside it was an index read, so it is the one still going when the tab is closed.
      tab.kind === "data" ? tab.countRunId : null,
    ].filter((id): id is string => typeof id === "string" && id.length > 0);
    if (runIds.length === 0) return;
    await Promise.all(runIds.map((runId) => guarded(() => dbCancel(runId))));
  },

  // ---------------------------------------------------------------- assistant

  toggleConsoleAi: (tabId) => {
    const open = findTab<DbConsoleTab>(get, tabId, "console")?.ai;
    // Closing the bar stops the run behind it. Without this the panel goes away and the CLI keeps
    // burning tokens with nowhere left to report — the state it would write back was just thrown
    // away. Closing *is* the cancel, which is why the button says so while one is in flight.
    if (open?.runId) void useAiRunStore.getState().cancel(open.runId);
    patchTab<DbConsoleTab>(set, tabId, "console", (tab) => ({
      ...tab,
      ai: tab.ai
        ? null
        : { question: "", messages: [], running: false, runId: null, error: null },
    }));
  },

  clearConsoleAi: (tabId) => {
    patchTab<DbConsoleTab>(set, tabId, "console", (tab) =>
      tab.ai ? { ...tab, ai: { ...tab.ai, messages: [], error: null } } : tab,
    );
  },

  setConsoleAiQuestion: (tabId, question) => {
    patchTab<DbConsoleTab>(set, tabId, "console", (tab) =>
      tab.ai ? { ...tab, ai: { ...tab.ai, question } } : tab,
    );
  },

  askConsoleAi: async (tabId) => {
    const tab = findTab<DbConsoleTab>(get, tabId, "console");
    const question = tab?.ai?.question.trim();
    if (!tab || !question || tab.ai?.running) return;

    const runId = newAiRunId("db-assist");
    // Which workspace this answer belongs to, captured before anything is awaited. This store *is*
    // per workspace — its connections, its consoles and this tab all came out of one — so the run
    // has a home, and stamping it is what lets the status bar say "in <workspace>" for an assistant
    // the user has since walked away from.
    const runWorkspaceId = get().workspaceId;
    // No target even so: the console it answers into is a tab of the Databases workspace, whose tab
    // ids are minted fresh on every rehydrate, and the notification centre has no vocabulary for
    // "that tab, in that window". Listing it unclickable is still the point — a model is running,
    // and the status bar should say so, under the workspace it is running for.
    useAiRunStore
      .getState()
      .start(runId, { kindKey: "agents.liveKindDb", detail: question, workspaceId: runWorkspaceId });
    // The conversation as it stood *before* this question — what the model is shown. Taken here,
    // ahead of the optimistic write below, or the question would be in its own history.
    const history = (tab.ai?.messages ?? []).map((turn) => ({ role: turn.role, text: turn.text }));
    patchTab<DbConsoleTab>(set, tabId, "console", (current) =>
      current.ai
        ? {
            ...current,
            ai: {
              ...current.ai,
              // The question joins the transcript the moment it is asked, and the box empties. That
              // is what makes this read as a chat rather than as a form: what you typed is on
              // screen, above the answer that is being written for it, instead of sitting in the
              // input until something comes back.
              messages: [...current.ai.messages, { role: "user" as const, text: question }],
              question: "",
              running: true,
              runId,
              error: null,
            },
          }
        : current,
    );
    try {
      const answer = await dbAiAssist(
        tab.connectionId,
        tab.database || null,
        tab.schema || null,
        question,
        tab.body,
        // Only the *shape* of the last run. "No me trae datos" is two different situations — zero
        // rows, or a statement that never ran — and this is what tells them apart. The rows
        // themselves are deliberately left behind: they are the user's data, the assistant has no
        // use for them, and a five-thousand-row grid would otherwise cross IPC again on every
        // question asked about it.
        (tab.result?.results ?? []).map((result) => ({
          error: result.error,
          rows: result.documents.length || result.rows.length,
          rows_affected: result.rows_affected,
          duration_ms: result.duration_ms,
        })),
        history,
        runId,
      );
      // `current.ai?.runId === runId`, not just `current.ai`, on this and both writes below. The bar
      // can be closed and reopened while a question is in flight — closing it cancels, but the CLI
      // takes a moment to die and the answer can still arrive — and `toggleConsoleAi` rebuilds `ai`
      // from scratch. Without the identity check a stale answer lands in a bar that is now asking
      // something else, and the `finally` below flips a *newer* run's `running` to false, hiding its
      // stop button and letting a third question start on top of it.
      patchTab<DbConsoleTab>(set, tabId, "console", (current) =>
        current.ai?.runId === runId
          ? {
              ...current,
              ai: {
                ...current.ai,
                messages: [
                  ...current.ai.messages,
                  {
                    role: "assistant" as const,
                    text: answer.answer,
                    query: answer.query,
                    runId,
                    tablesSeen: answer.tables_seen,
                    schemaTruncated: answer.schema_truncated,
                  },
                ],
                error: null,
              },
            }
          : current,
      );
      // The only run in this workspace that used to report nothing when it finished. It is also one
      // of the ones most likely to finish somewhere else: reading a large schema and answering takes
      // long enough to go and do something in another workspace, and the tab it would have written
      // into is gone by then. Stamped with the workspace it was asked in, so the bell can say so.
      notify({
        source: "db",
        workspaceId: runWorkspaceId,
        titleKey: "notifications.chatDone",
        status: "success",
        detail: question,
      });
    } catch (e) {
      // A stop is not a failure. The panel goes back to how it was, with whatever it was showing
      // before — an error line saying "cancelled" is noise on an action the user just took, and a
      // notification about it is worse: it outlives the panel.
      if (!isCancellation(e)) {
        patchTab<DbConsoleTab>(set, tabId, "console", (current) =>
          current.ai?.runId === runId
            ? { ...current, ai: { ...current.ai, error: String(e) } }
            : current,
        );
        notify({
          source: "db",
          workspaceId: runWorkspaceId,
          titleKey: "notifications.chatFailed",
          status: "error",
          detail: question,
        });
      }
    } finally {
      useAiRunStore.getState().finish(runId);
      // `runId` stays: it is what the answer's engine chip resolves the model through. `running`
      // is what says the run is over, and the cancel button keys off that, not off this id.
      patchTab<DbConsoleTab>(set, tabId, "console", (current) =>
        current.ai?.runId === runId ? { ...current, ai: { ...current.ai, running: false } } : current,
      );
    }
  },

  cancelConsoleAi: async (tabId) => {
    const tab = findTab<DbConsoleTab>(get, tabId, "console");
    // `running`, not just the id: the id outlives the run now (it is the answer chip's key), so
    // asking to stop a finished run would be a request to cancel something already over.
    if (!tab?.ai?.running || !tab.ai.runId) return;
    await useAiRunStore.getState().cancel(tab.ai.runId);
  },

  // -------------------------------------------------------------------- data

  openData: (connectionId, node, name, filter = "") => {
    const existing = get().tabs.find(
      (tab) => tab.kind === "data" && sameNode(tab.node, node) && tab.connectionId === connectionId,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      // Following a foreign key into a table that is already open has to re-point it, or the click
      // looks like it did nothing: the tab comes forward still showing the previous row's filter.
      if (filter && existing.kind === "data" && existing.filter !== filter) {
        patchTab<DbDataTab>(set, existing.id, "data", (tab) => ({
          ...tab,
          filter,
          filterDraft: filter,
          offset: 0,
        }));
        void get().loadData(existing.id);
      }
      return;
    }
    const id = newId();
    addTab(set, get, {
      id,
      kind: "data",
      connectionId,
      node,
      name,
      offset: 0,
      limit: DEFAULT_PAGE_SIZE,
      filter,
      filterDraft: filter,
      options: EMPTY_QUERY_OPTIONS,
      optionsDraft: EMPTY_QUERY_OPTIONS,
      sort: [],
      loading: false,
      runId: null,
      countRunId: null,
      result: null,
      total: null,
      columns: [],
      foreignKeys: [],
      pending: {},
      deleted: [],
      inserted: [],
      replaced: {},
      insertedDocs: [],
      error: null,
      ui: DEFAULT_DATA_UI,
    });
    void get().loadData(id);
    // Alongside the rows rather than before them: the grid is useful without this, and a catalog
    // query that is slow or refused must not be what decides whether the data appears.
    void dbForeignKeys(connectionId, node)
      .then((foreignKeys) =>
        patchTab<DbDataTab>(set, id, "data", (tab) => ({ ...tab, foreignKeys })),
      )
      .catch(() => {});
  },

  /**
   * Opens the table a foreign-key column points at.
   *
   * `value === null` opens it whole — that is the header's meaning, "show me what this column
   * refers to". A value narrows it to the row being pointed at, which is the cell's.
   */
  followForeignKey: (tab, key, value) => {
    const node: DbNodeRef = {
      kind: "table",
      database: tab.node.database,
      schema: key.ref_schema ?? tab.node.schema,
      name: key.ref_table,
    };
    const kind = get().connections.find((c) => c.id === tab.connectionId)?.kind ?? "postgres";
    // A NULL foreign key points at nothing, so the honest destination is the whole table rather
    // than a filter that would match no row.
    const filter =
      value === null
        ? ""
        : `${quoteIdent(key.ref_column, kind)} = ${quoteLiteral(value)}`;
    get().openData(tab.connectionId, node, key.ref_table, filter);
  },

  /**
   * Rewrites the filter on one target.
   *
   * One action rather than one per field, because the dialog only ever edits one filter: the one on
   * whatever was right-clicked. What varies is *which* of the config's fields that lands in, and
   * that is this function's whole job.
   *
   * Blank clears rather than filters, in every target: a pattern that matches nothing has a way to
   * be written on purpose (`!*`), and an empty box is what someone types to undo — a tree emptied by
   * deleting the text would be the worst possible reading of that gesture. A cleared entry is
   * dropped from the list instead of kept as an empty string, so the level falls back to whatever is
   * above it and the dialog stops listing a filter that does nothing.
   *
   * `enabled` is kept even for a blank pattern's sake: it is written alongside, so switching a
   * filter off and clearing it are two different edits that do not undo each other.
   */
  setFilter: async (connectionId, target, pattern, enabled) => {
    const state = get();
    const row = state.connections.find((c) => c.id === connectionId);
    const config = row ? parseSpec(row) : null;
    if (!row || !config) return;
    const trimmed = pattern.trim();

    if (target.kind === "schemas") {
      await state.saveConnection(
        row,
        { ...config, schema_filter: trimmed, schema_filter_enabled: enabled },
        null,
      );
      return;
    }
    if (target.schema === null) {
      await state.saveConnection(
        row,
        { ...config, object_filter: trimmed, object_filter_enabled: enabled },
        null,
      );
      return;
    }

    const schema = target.schema;
    const folder = target.folder ?? null;
    const rest = config.schema_object_filters.filter(
      (entry) =>
        !(
          entry.schema.toLowerCase() === schema.toLowerCase() &&
          (entry.folder ?? null) === folder
        ),
    );
    await state.saveConnection(
      row,
      {
        ...config,
        schema_object_filters: trimmed
          ? [...rest, { schema, folder, pattern: trimmed, enabled }]
          : rest,
      },
      null,
    );
  },

  updateData: (tabId, patch) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({ ...tab, ...patch }));
  },

  setDataUi: (tabId, patch) => patchUi<DbDataTab>(set, tabId, "data", patch),
  setConsoleUi: (tabId, patch) => patchUi<DbConsoleTab>(set, tabId, "console", patch),
  setSchemaUi: (tabId, patch) => patchUi<DbSchemaTab>(set, tabId, "schema", patch),
  setDiagramUi: (tabId, patch) => patchUi<DbDiagramTab>(set, tabId, "diagram", patch),

  loadData: async (tabId) => {
    const tab = findTab<DbDataTab>(get, tabId, "data");
    if (!tab) return;
    const runId = newRunId();
    patchTab<DbDataTab>(set, tabId, "data", (current) => ({
      ...current,
      loading: true,
      runId,
      error: null,
      // A reload lands on different rows, so a staged edit keyed by row index would apply to the
      // wrong one. Dropping them is the only safe answer — and the UI asks before reloading when
      // there is anything staged.
      pending: {},
      deleted: [],
      inserted: [],
      replaced: {},
      insertedDocs: [],
    }));
    // Taken before the read, like every other statement here: a page over a large relation can land
    // long after the user has walked to another workspace, and the log entry has to say which estate
    // it was actually run against rather than which one is on screen when it arrives.
    const runWorkspaceId = get().workspaceId;
    try {
      const result = await dbTableData(
        tab.connectionId,
        {
          node: tab.node,
          offset: tab.offset,
          limit: tab.limit,
          sort: tab.sort,
          filter: tab.filter,
          options: tab.options,
        },
        runId,
      );
      patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, result }));
      // The statement the server was actually given — see `DbSqlLogEntry` for why it is logged
      // rather than rebuilt here.
      get().logSql({
        workspaceId: runWorkspaceId,
        connectionId: tab.connectionId,
        sql: result.statement,
        source: "grid",
        durationMs: result.duration_ms,
        rows: result.rows.length,
        error: null,
      });

      // The columns are what the primary key comes from, so the editor needs them before it can
      // build an `UPDATE`. Fetched once per tab, not per page.
      if (tab.columns.length === 0) {
        const columnNode: DbNodeRef = { ...tab.node, kind: "column_folder" };
        const columns = await dbChildren(tab.connectionId, columnNode).catch(() => [] as DbNode[]);
        patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, columns }));
      }
      // Deliberately after the rows: on a large table the count is a full scan while the page is an
      // index read, so the grid fills first and the total arrives when it arrives. Its run id is
      // kept on the tab so `cancelRun` can reach it — this is the one that is still going when the
      // user gives up and closes the tab.
      const countRunId = newRunId();
      patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, countRunId }));
      void dbRowCount(tab.connectionId, tab.node, tab.filter, tab.options, countRunId)
        .then((total) =>
          patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, total })),
        )
        .catch(() => {})
        .finally(() =>
          patchTab<DbDataTab>(set, tabId, "data", (current) =>
            current.countRunId === countRunId ? { ...current, countRunId: null } : current,
          ),
        );
    } catch (e) {
      patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, error: String(e) }));
      // A failed page is exactly what the log is for: the message alone rarely says which
      // statement produced it, and the tab only keeps the last one.
      get().logSql({
        workspaceId: runWorkspaceId,
        connectionId: tab.connectionId,
        sql: "",
        source: "grid",
        durationMs: null,
        rows: null,
        error: String(e),
      });
    } finally {
      patchTab<DbDataTab>(set, tabId, "data", (current) => ({
        ...current,
        loading: false,
        runId: null,
      }));
      void get().syncConnected();
    }
  },

  setCell: (tabId, row, column, value) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => {
      const key = `${row}:${column}`;
      const original = cellAt(tab, row, column);
      // Setting a cell back to what it was un-stages it, rather than queueing a no-op `UPDATE`.
      if (original === value) return { ...tab, pending: omit(tab.pending, key) };
      return { ...tab, pending: { ...tab.pending, [key]: value } };
    });
  },

  toggleDeleteRow: (tabId, row) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({
      ...tab,
      deleted: tab.deleted.includes(row)
        ? tab.deleted.filter((entry) => entry !== row)
        : [...tab.deleted, row],
    }));
  },

  setDeletedRows: (tabId, rows, deleted) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => {
      const touched = new Set(rows);
      return {
        ...tab,
        deleted: deleted
          ? [...new Set([...tab.deleted, ...rows])]
          : tab.deleted.filter((entry) => !touched.has(entry)),
      };
    });
  },

  addRow: (tabId) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({
      ...tab,
      // A new row starts as all-NULL rather than all-empty-string: a column with a default only
      // takes it when the insert omits the column, and NULL is how "omit this" is expressed here.
      inserted: [...tab.inserted, (tab.result?.columns ?? []).map(() => null)],
    }));
  },

  setInsertedCell: (tabId, row, column, value) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => {
      const index = (tab.result?.columns ?? []).findIndex((entry) => entry.name === column);
      if (index < 0) return tab;
      const inserted = tab.inserted.map((entry, entryIndex) =>
        entryIndex === row ? entry.map((cell, cellIndex) => (cellIndex === index ? value : cell)) : entry,
      );
      return { ...tab, inserted };
    });
  },

  removeInsertedRow: (tabId, row) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({
      ...tab,
      inserted: tab.inserted.filter((_, index) => index !== row),
    }));
  },

  setDocument: (tabId, row, document) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => {
      const replaced = { ...tab.replaced };
      if (document === null) delete replaced[row];
      else replaced[row] = document;
      return {
        ...tab,
        replaced,
        // The cell edits on this row would be a second write describing the same document, and the
        // document the user just wrote by hand is the one they mean.
        pending: Object.fromEntries(
          Object.entries(tab.pending).filter(([key]) => Number(key.split(":")[0]) !== row),
        ),
      };
    });
  },

  addDocument: (tabId, document) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({
      ...tab,
      insertedDocs: [...tab.insertedDocs, document],
    }));
  },

  setInsertedDocument: (tabId, index, document) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({
      ...tab,
      insertedDocs: tab.insertedDocs.map((entry, position) =>
        position === index ? document : entry,
      ),
    }));
  },

  removeInsertedDocument: (tabId, index) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({
      ...tab,
      insertedDocs: tab.insertedDocs.filter((_, position) => position !== index),
    }));
  },

  revertEdits: (tabId) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({
      ...tab,
      pending: {},
      deleted: [],
      inserted: [],
      replaced: {},
      insertedDocs: [],
    }));
  },

  applyEdits: async (tabId) => {
    const tab = findTab<DbDataTab>(get, tabId, "data");
    if (!tab || !tab.result) return;
    const edits = buildEdits(tab);
    if (edits.length === 0) return;

    const runWorkspaceId = get().workspaceId;
    await guarded(async () => {
      const outcome = await dbApplyEdits(tab.connectionId, tab.node, edits);
      // Logged whether or not the batch succeeded: a rejected `UPDATE` is the one you most want to
      // read back, and the toast only carries the server's complaint, not the statement.
      for (const sql of outcome.statements) {
        get().logSql({
          workspaceId: runWorkspaceId,
          connectionId: tab.connectionId,
          sql,
          source: "edit",
          durationMs: null,
          rows: null,
          error: outcome.error,
        });
      }
      if (outcome.error) {
        // Kept staged: the user is about to fix the value the server rejected, and clearing the
        // grid would make them re-type every change in the batch.
        pushErrorToast(outcome.error);
        return true;
      }
      useToastStore
        .getState()
        .pushToast(
          outcome.applied === 1
            ? "1 row saved"
            : `${outcome.applied} rows saved`,
          "success",
        );
      get().revertEdits(tabId);
      await get().loadData(tabId);
      return true;
    });
  },

  // --------------------------------------------------------------------- DDL

  openDdl: async (connectionId, node, name) => {
    const existing = get().tabs.find(
      (tab) => tab.kind === "ddl" && sameNode(tab.node, node) && tab.connectionId === connectionId,
    );
    const id = existing?.id ?? newId();
    if (existing) {
      set({ activeTabId: id });
    } else {
      addTab(set, get, {
        id,
        kind: "ddl",
        connectionId,
        node,
        name,
        text: "",
        loading: true,
      });
    }
    try {
      const text = await dbObjectDdl(connectionId, node);
      patchTab<DbDdlTab>(set, id, "ddl", (current) => ({ ...current, text, loading: false }));
    } catch (e) {
      patchTab<DbDdlTab>(set, id, "ddl", (current) => ({
        ...current,
        text: `-- ${String(e)}`,
        loading: false,
      }));
    } finally {
      void get().syncConnected();
    }
  },

  // ----------------------------------------------------------------- diagram

  openSchema: (connectionId, node, name) => {
    const existing = get().tabs.find(
      (tab) => tab.kind === "schema" && sameNode(tab.node, node) && tab.connectionId === connectionId,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const id = newId();
    addTab(set, get, {
      id,
      kind: "schema",
      connectionId,
      node,
      name,
      loading: false,
      runId: null,
      objects: null,
      error: null,
      ui: DEFAULT_SCHEMA_UI,
    });
    void get().loadSchema(id);
  },

  loadSchema: async (tabId) => {
    const tab = findTab<DbSchemaTab>(get, tabId, "schema");
    if (!tab || tab.loading) return;
    const runId = newRunId();
    patchTab<DbSchemaTab>(set, tabId, "schema", (current) => ({
      ...current,
      loading: true,
      runId,
      error: null,
    }));
    const runWorkspaceId = get().workspaceId;
    const started = Date.now();
    try {
      const objects = await dbSchemaObjects(tab.connectionId, tab.node, runId);
      patchTab<DbSchemaTab>(set, tabId, "schema", (current) => ({ ...current, objects }));
      // A catalog query the user never wrote, on the schema they are looking at — the same reason
      // the diagram logs itself. One line: what the panel *is*, not the SQL behind it.
      get().logSql({
        workspaceId: runWorkspaceId,
        connectionId: tab.connectionId,
        sql: `-- schema objects: ${[tab.node.database, tab.node.schema ?? tab.node.name]
          .filter(Boolean)
          .join(".")}`,
        source: "grid",
        durationMs: Date.now() - started,
        rows: objects.length,
        error: null,
      });
    } catch (e) {
      // Against the tab rather than as a toast: the panel is empty and has room to explain itself.
      patchTab<DbSchemaTab>(set, tabId, "schema", (current) => ({ ...current, error: String(e) }));
    } finally {
      patchTab<DbSchemaTab>(set, tabId, "schema", (current) => ({
        ...current,
        loading: false,
        runId: null,
      }));
      void get().syncConnected();
    }
  },

  openDiagram: (connectionId, node, name) => {
    const existing = get().tabs.find(
      (tab) =>
        tab.kind === "diagram" && sameNode(tab.node, node) && tab.connectionId === connectionId,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const id = newId();
    addTab(set, get, {
      id,
      kind: "diagram",
      connectionId,
      node,
      name,
      loading: false,
      runId: null,
      diagram: null,
      error: null,
      ui: DEFAULT_DIAGRAM_UI,
    });
    void get().loadDiagram(id);
  },

  loadDiagram: async (tabId) => {
    const tab = findTab<DbDiagramTab>(get, tabId, "diagram");
    if (!tab || tab.loading) return;
    const runId = newRunId();
    patchTab<DbDiagramTab>(set, tabId, "diagram", (current) => ({
      ...current,
      loading: true,
      runId,
      error: null,
    }));
    const runWorkspaceId = get().workspaceId;
    const started = Date.now();
    try {
      const diagram = await dbSchemaDiagram(tab.connectionId, tab.node, runId);
      patchTab<DbDiagramTab>(set, tabId, "diagram", (current) => ({ ...current, diagram }));
      // Two catalog queries the user never wrote, on the schema they are looking at — exactly the
      // kind of statement the log exists for. Logged as one line: what the panel *is*.
      get().logSql({
        workspaceId: runWorkspaceId,
        connectionId: tab.connectionId,
        sql: `-- schema diagram: ${[tab.node.database, tab.node.schema ?? tab.node.name]
          .filter(Boolean)
          .join(".")}`,
        source: "grid",
        durationMs: Date.now() - started,
        rows: diagram.tables.length,
        error: null,
      });
    } catch (e) {
      // Against the tab, not as a toast: the panel is empty and has room to explain itself, which
      // a toast that vanishes in four seconds does not.
      patchTab<DbDiagramTab>(set, tabId, "diagram", (current) => ({ ...current, error: String(e) }));
    } finally {
      patchTab<DbDiagramTab>(set, tabId, "diagram", (current) => ({
        ...current,
        loading: false,
        runId: null,
      }));
      void get().syncConnected();
    }
  },

  // -------------------------------------------------------------------- tabs

  closeTab: (tabId) => {
    // Closing the tab is how people stop a query they regret — the Cancel button goes away with the
    // panel, so anything still running would otherwise keep the server working on a result nobody
    // can ever see, and keep the session busy for the next statement on that database.
    void get().cancelRun(tabId);
    // And the assistant, which `cancelRun` cannot reach: it is a CLI subprocess in the AI registry
    // rather than a statement on the server, and with no query in flight `cancelRun` finds nothing
    // to stop and returns having cancelled a model that goes on burning tokens for a tab that no
    // longer exists. Closing a tab is an explicit decision about *this* tab — unlike walking to
    // another workspace, which `setWorkspace` deliberately lets everything survive.
    const ai = findTab<DbConsoleTab>(get, tabId, "console")?.ai;
    if (ai?.running && ai.runId) void useAiRunStore.getState().cancel(ai.runId);
    set((s) => {
      const tabs = s.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId =
        s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    });
    persistTabs(get);
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
    persistTabs(get);
  },

  // ----------------------------------------------------------------- history

  refreshHistory: async () => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    const history = await guarded(() => dbListHistory(workspaceId, HISTORY_LIMIT));
    // The same latch `init` and `recordHistory` use: this list is one workspace's, and the read that
    // was in flight when the user switched must not publish it over the one they are now looking at.
    if (history && get().workspaceId === workspaceId) set({ history });
  },

  deleteHistory: async (id) => {
    await guarded(() => dbDeleteHistory(id));
    set((s) => ({ history: s.history.filter((entry) => entry.id !== id) }));
  },

  clearHistory: async () => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    await guarded(() => dbClearHistory(workspaceId));
    // Emptied on screen only if the screen is still the one that was emptied on disk. A switch
    // during the round trip would otherwise blank the *incoming* workspace's history panel — rows
    // that are still in `db_query_history` and that nothing re-reads until the next load.
    if (get().workspaceId === workspaceId) set({ history: [] });
  },

  logSql: (entry) => {
    set((s) => {
      // Dropped rather than appended when it belongs to a workspace the store has left. The log is
      // the *loaded* workspace's window on its own session — `setWorkspace` empties it for that
      // reason — so a statement that was still in flight across the switch would land in a log that
      // was just cleared for somebody else, as the only row in it, under connections it was never
      // run against. It is not lost work: the run itself keeps its own reporting.
      if (entry.workspaceId !== s.workspaceId) return s;
      return {
        sqlLog: [
          ...s.sqlLog.slice(Math.max(0, s.sqlLog.length - SQL_LOG_LIMIT + 1)),
          { ...entry, id: newRunId(), at: Date.now() },
        ],
      };
    });
  },

  clearSqlLog: () => set({ sqlLog: [] }),
}));

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * Turns a data tab's staged changes into the edits the backend applies.
 *
 * **How a row is identified** is the whole design here. With a primary key, the `WHERE` is that key
 * — narrow, and unaffected by another session changing a different column. Without one, it is every
 * *original* value of the row, which is the only thing that still describes it; that can match more
 * than one row in a table with exact duplicates, and the UI says so before applying.
 *
 * The original values matter, not the edited ones: an `UPDATE … SET name = 'b' WHERE name = 'b'`
 * built from the new value would match nothing.
 */
export function buildEdits(tab: DbDataTab): DbRowEdit[] {
  const result = tab.result;
  if (!result) return [];
  const columns = result.columns;
  const pkColumns = tab.columns
    .filter((column) => column.column?.primary_key)
    .map((column) => column.name)
    .filter((name) => columns.some((entry) => entry.name === name));

  const typeOf = (name: string) =>
    columns.find((entry) => entry.name === name)?.type_name ?? "";

  const keysFor = (row: number) => {
    const names = pkColumns.length > 0 ? pkColumns : columns.map((column) => column.name);
    return names.map((name) => ({
      column: name,
      value: cellAt(tab, row, name),
      type_name: typeOf(name),
    }));
  };

  const edits: DbRowEdit[] = [];

  // A document rewritten as a whole replaces the stored one, keyed the same way an `UPDATE` is.
  // First, alongside the cell updates, and for the same reason they come first: a row staged for
  // deletion is not also rewritten.
  for (const row of Object.keys(tab.replaced)
    .map(Number)
    .sort((a, b) => a - b)) {
    if (tab.deleted.includes(row)) continue;
    edits.push({ kind: "update", values: [], keys: keysFor(row), document: tab.replaced[row] });
  }

  // Updates first, then deletes, then inserts. Deleting before updating would make an update to a
  // deleted row fail; inserting last means a new row can reuse a unique value a delete just freed.
  const touchedRows = new Set<number>();
  for (const key of Object.keys(tab.pending)) {
    const row = Number(key.split(":")[0]);
    if (!tab.deleted.includes(row) && !(row in tab.replaced)) touchedRows.add(row);
  }
  for (const row of [...touchedRows].sort((a, b) => a - b)) {
    const values = Object.entries(tab.pending)
      .filter(([key]) => Number(key.split(":")[0]) === row)
      .map(([key, value]) => ({
        column: key.slice(key.indexOf(":") + 1),
        value,
        type_name: typeOf(key.slice(key.indexOf(":") + 1)),
      }));
    if (values.length > 0) edits.push({ kind: "update", values, keys: keysFor(row) });
  }

  for (const row of [...tab.deleted].sort((a, b) => a - b)) {
    edits.push({ kind: "delete", values: [], keys: keysFor(row) });
  }

  for (const row of tab.inserted) {
    const values = row
      .map((value, index) => ({
        column: columns[index]?.name ?? "",
        value,
        type_name: columns[index]?.type_name ?? "",
      }))
      // A column left NULL in a new row is omitted, so its default (or its identity sequence) gets
      // to apply. Writing an explicit NULL would override both.
      .filter((cell) => cell.column !== "" && cell.value !== null);
    if (values.length > 0) edits.push({ kind: "insert", values, keys: [] });
  }

  for (const document of tab.insertedDocs) {
    edits.push({ kind: "insert", values: [], keys: [], document });
  }

  return edits;
}

/** Whether a table's rows can be identified by a primary key. Drives the warning the UI shows
 * before applying edits without one. */
export function hasPrimaryKey(tab: DbDataTab): boolean {
  return tab.columns.some((column) => column.column?.primary_key);
}

export function pendingCount(tab: DbDataTab): number {
  // One row is one staged change however many of its cells were touched — and a row rewritten as a
  // document counts once too, never twice, since staging one clears the other.
  const updatedRows = new Set(
    [
      ...Object.keys(tab.pending).map((key) => Number(key.split(":")[0])),
      ...Object.keys(tab.replaced).map(Number),
    ].filter((row) => !tab.deleted.includes(row)),
  );
  return (
    updatedRows.size + tab.deleted.length + tab.inserted.length + tab.insertedDocs.length
  );
}

/**
 * The text a document view should draw for a row: the staged rewrite if there is one, else what the
 * server sent.
 *
 * The document counterpart of `displayCell`, and there for the same reason — a card that kept
 * showing the server's version after being edited would make Apply look like it was about to write
 * something nobody typed.
 */
export function displayDocument(tab: DbDataTab, row: number): string {
  return tab.replaced[row] ?? tab.result?.documents[row] ?? "";
}

/** The value a cell currently shows: the staged edit if there is one, else what the server sent. */
export function displayCell(tab: DbDataTab, row: number, column: string): string | null {
  const key = `${row}:${column}`;
  if (key in tab.pending) return tab.pending[key];
  return cellAt(tab, row, column);
}

/** The value the server sent, ignoring anything staged. */
function cellAt(tab: DbDataTab, row: number, column: string): string | null {
  const index = (tab.result?.columns ?? []).findIndex((entry) => entry.name === column);
  if (index < 0) return null;
  return tab.result?.rows[row]?.[index] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contextOf(tab: DbConsoleTab) {
  return {
    database: tab.database || null,
    schema: tab.schema || null,
    max_rows: tab.maxRows,
  };
}

/**
 * An identifier, quoted the way this engine spells one.
 *
 * A second, smaller copy of what `sqlgen::quote_ident` does in Rust — deliberately, and only for
 * the filter fragments built here. The backend keeps owning every statement it *runs*; this is the
 * text that goes into the filter box, which the user then sees and can edit, so it has to be
 * spelled in their dialect rather than handed over as an opaque blob.
 */
function quoteIdent(name: string, kind: DbKind): string {
  if (kind === "sqlserver") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** A string literal. Every SQL engine here spells one the same way, and every engine here coerces
 * it to the column's type — so a numeric key quoted this way still compares correctly. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The connection's saved settings. Returns null on a blob that predates a field rename rather than
 * throwing — the connection dialog is where that gets fixed. */
export function parseSpec(row: DbConnectionRow): DbConnectionConfig | null {
  try {
    const parsed = JSON.parse(row.spec) as Partial<DbConnectionConfig>;
    return { ...defaultConnectionConfig(row.kind), ...parsed, id: row.id, kind: row.kind };
  } catch {
    return null;
  }
}

/** The label under a connection's name in the explorer: what it is, and where. */
export function describeConnection(row: DbConnectionRow): string {
  const config = parseSpec(row);
  const engine = engineInfo(row.kind);
  if (!config) return engine.label;
  if (config.url) {
    // A URI can carry a password; showing it in the sidebar would put a credential on screen.
    return `${engine.label} · ${redactUrl(config.url)}`;
  }
  const port = config.port || engine.defaultPort;
  const where = `${config.host}:${port}`;
  return config.database ? `${engine.label} · ${where}/${config.database}` : `${engine.label} · ${where}`;
}

/**
 * Whether a connection URI carries a password of its own.
 *
 * What it decides is whether the separate password box is worth showing: a URI with `user:pass@` in
 * it has already answered that question, and every engine here prefers the URI's own credential. A
 * URI with a user and no password has not, and then the box is the only path to the OS keychain —
 * which is the whole reason it exists, since the URI itself is stored in the app's database as
 * typed.
 *
 * The same shape `redactUrl` matches, deliberately: one reading of "where the credentials are in a
 * URI", so a URL that redacts as having a password is a URL that counts as having one.
 */
export function urlHasPassword(url: string): boolean {
  const match = url.match(/\/\/([^/@]*)@/);
  if (!match) return false;
  const at = match[1].indexOf(":");
  return at >= 0 && match[1].slice(at + 1).length > 0;
}

/** Strips the credentials out of a connection URI for display. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^/@]*)@/, (_match, credentials: string) => {
    const user = credentials.split(":")[0];
    return user ? `//${user}:••••@` : "//";
  });
}

/**
 * Files a finished console statement in the durable query history.
 *
 * `workspaceId` and `connectionName` are **passed in**, captured by the caller before the statement
 * was sent, and are not read back off the store here. This function only ever runs after the await
 * that took minutes, which is precisely when neither is still true: the workspace is whichever one
 * the user switched to, and `connections` was emptied by that switch, so the name resolved to `""`
 * on the row that most needed it.
 */
async function recordHistory(
  get: () => DbState,
  tab: DbConsoleTab,
  statement: string,
  result: DbExecuteResult,
  duration: number,
  workspaceId: string,
  connectionName: string,
) {
  const failed = result.results.find((entry) => entry.error);
  const rows = result.results.reduce(
    (total, entry) => total + (entry.rows_affected ?? entry.rows.length),
    0,
  );
  const entry: DbQueryHistoryEntry = {
    id: "",
    workspace_id: workspaceId,
    connection_id: tab.connectionId,
    connection_name: connectionName,
    statement,
    database_name: tab.database,
    duration_ms: duration,
    row_count: rows,
    error: failed?.error ?? "",
    ran_at: "",
  };
  // A history write that fails must not make a successful query look like it failed.
  const saved = await dbAddHistory(entry).catch(() => null);
  // The row is persisted under the workspace that ran it whatever happens; the *list* on screen
  // belongs to whichever workspace is loaded now, so it only receives the row when the two agree.
  // Otherwise a query started in one workspace prepends itself to another one's history panel and
  // then disappears the next time that panel is re-read from disk.
  if (saved && get().workspaceId === workspaceId) {
    useDbStore.setState({ history: [saved, ...get().history].slice(0, HISTORY_LIMIT) });
  }
}

function addTab(
  set: (partial: Partial<DbState> | ((state: DbState) => Partial<DbState>)) => void,
  get: () => DbState,
  tab: DbTab,
) {
  set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  persistTabs(get);
}

function findTab<T extends DbTab>(
  get: () => DbState,
  tabId: string,
  kind: T["kind"],
): T | null {
  const tab = get().tabs.find((entry) => entry.id === tabId);
  return tab && tab.kind === kind ? (tab as T) : null;
}

function patchTab<T extends DbTab>(
  set: (partial: (state: DbState) => Partial<DbState>) => void,
  tabId: string,
  kind: T["kind"],
  update: (tab: T) => T,
) {
  set((s) => ({
    tabs: s.tabs.map((tab) =>
      tab.id === tabId && tab.kind === kind ? update(tab as T) : tab,
    ),
  }));
}

/**
 * Patches a tab's `ui` — the how-it-is-being-looked-at half of the record.
 *
 * Deliberately routed through `patchTab` rather than through `updateConsole`/`updateData`: those
 * two schedule a persist and, for the console, can mark the tab dirty. Clicking "record layout"
 * is not an edit to anything, so it must cost neither a settings write nor an unsaved dot.
 */
function patchUi<T extends DbTab & { ui: object }>(
  set: (partial: (state: DbState) => Partial<DbState>) => void,
  tabId: string,
  kind: T["kind"],
  patch: Partial<T["ui"]>,
) {
  patchTab<T>(set, tabId, kind, (tab) => ({ ...tab, ui: { ...tab.ui, ...patch } }) as T);
}

function sameNode(a: DbNodeRef, b: DbNodeRef): boolean {
  return (
    a.kind === b.kind &&
    (a.database ?? "") === (b.database ?? "") &&
    (a.schema ?? "") === (b.schema ?? "") &&
    (a.name ?? "") === (b.name ?? "")
  );
}

function dropConnection(
  children: Record<string, DbNode[]>,
  connectionId: string,
): Record<string, DbNode[]> {
  const next: Record<string, DbNode[]> = {};
  for (const [key, value] of Object.entries(children)) {
    if (!key.startsWith(`${connectionId}|`)) next[key] = value;
  }
  return next;
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Writes the open tabs, debounced.
 *
 * Only what identifies a tab is stored — never its results. A grid holding fifty thousand cells
 * would be megabytes of settings row, and it is stale the moment the app reopens anyway.
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistTabs(get: () => DbState) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state = get();
    if (!state.workspaceId) return;
    const payload: PersistedTabs = {
      version: 1,
      tabs: state.tabs.map((tab) => ({
        kind: tab.kind,
        connectionId: tab.connectionId,
        consoleId: tab.kind === "console" ? tab.consoleId : undefined,
        node: tab.kind === "console" ? undefined : tab.node,
        name: tab.name,
        body: tab.kind === "console" ? tab.body : undefined,
        database: tab.kind === "console" ? tab.database : undefined,
        schema: tab.kind === "console" ? tab.schema : undefined,
      })),
      activeTabId: state.activeTabId,
    };
    void setSetting(openTabsKey(state.workspaceId), JSON.stringify(payload)).catch(() => {});
  }, 500);
}

function rehydrateTab(persisted: PersistedTab, tree: { consoles: DbConsole[] }): DbTab {
  const id = newId();
  if (persisted.kind === "console") {
    const saved = persisted.consoleId
      ? tree.consoles.find((c) => c.id === persisted.consoleId)
      : undefined;
    return {
      id,
      kind: "console",
      connectionId: persisted.connectionId,
      // A console deleted while the app was closed comes back as scratch, not as a tab pointing at
      // a row that no longer exists.
      consoleId: saved?.id ?? null,
      name: saved?.name ?? persisted.name,
      body: saved?.body ?? persisted.body ?? "",
      database: saved?.database_name ?? persisted.database ?? "",
      schema: saved?.schema_name ?? persisted.schema ?? "",
      maxRows: DEFAULT_MAX_ROWS,
      dirty: false,
      running: false,
      runId: null,
      result: null,
      activeResult: 0,
      plan: null,
      ai: null,
      ui: DEFAULT_CONSOLE_UI,
    };
  }
  const node = persisted.node ?? { kind: "table", database: null, schema: null, name: null };
  if (persisted.kind === "diagram") {
    return {
      id,
      kind: "diagram",
      connectionId: persisted.connectionId,
      node,
      name: persisted.name,
      loading: false,
      runId: null,
      // Left empty for the same reason a restored data tab is: reopening the app must not fire a
      // catalog sweep per tab at a database that may be behind a VPN. The panel asks when looked at.
      diagram: null,
      error: null,
      ui: DEFAULT_DIAGRAM_UI,
    };
  }
  if (persisted.kind === "schema") {
    return {
      id,
      kind: "schema",
      connectionId: persisted.connectionId,
      node,
      name: persisted.name,
      loading: false,
      runId: null,
      // Left empty for the same reason a restored diagram is: reopening the app must not fire a
      // catalog sweep per tab at a database that may be behind a VPN. The panel asks when looked at.
      objects: null,
      error: null,
      ui: DEFAULT_SCHEMA_UI,
    };
  }
  if (persisted.kind === "ddl") {
    return {
      id,
      kind: "ddl",
      connectionId: persisted.connectionId,
      node,
      name: persisted.name,
      text: "",
      loading: false,
    };
  }
  return {
    id,
    kind: "data",
    connectionId: persisted.connectionId,
    node,
    name: persisted.name,
    offset: 0,
    limit: DEFAULT_PAGE_SIZE,
    filter: "",
    filterDraft: "",
    options: EMPTY_QUERY_OPTIONS,
    optionsDraft: EMPTY_QUERY_OPTIONS,
    sort: [],
    loading: false,
    runId: null,
    countRunId: null,
    // Deliberately not loaded on restore: reopening the app must not fire a query per restored tab
    // at a database that may be behind a VPN. The grid asks when the tab is looked at.
    result: null,
    total: null,
    columns: [],
    foreignKeys: [],
    pending: {},
    deleted: [],
    inserted: [],
    replaced: {},
    insertedDocs: [],
    error: null,
    ui: DEFAULT_DATA_UI,
  };
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Every store action funnels its failure into one toast; nothing here is worth a modal. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    pushErrorToast(String(e));
    return null;
  }
}

function newId(): string {
  return `dbtab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function newRunId(): string {
  return `dbrun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Coming back from the tray is the one moment `connected` is guaranteed to be wrong.
 *
 * Hiding the window releases every idle session on the backend, and the webview keeps running
 * throughout — no remount, no reload, nothing that would otherwise re-ask. So the dots would still
 * be lit for sessions that no longer exist, and the row menus would offer Disconnect for nothing.
 *
 * This event rather than the DOM's `focus`: `focus` fires on every alt-tab, which is an IPC round
 * trip for a transition where nothing changed, and it is not guaranteed to fire on the show that
 * follows a hide — which is the only transition that matters here.
 */
void listen("app:foreground", () => {
  void useDbStore.getState().syncConnected();
});
