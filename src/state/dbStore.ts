import { create } from "zustand";
import {
  dbAddHistory,
  dbApplyEdits,
  dbCancel,
  dbChildren,
  dbClearHistory,
  dbConnect,
  dbConnected,
  dbCreateConnection,
  dbCreateConsole,
  dbDeleteConnection,
  dbDeleteConsole,
  dbDeleteHistory,
  dbDisconnect,
  dbDuplicateConnection,
  dbExecute,
  dbExplain,
  dbListHistory,
  dbLoadTree,
  dbForeignKeys,
  dbObjectDdl,
  dbReorderConnections,
  dbRowCount,
  dbSetPassword,
  dbTableData,
  dbUpdateConnection,
  dbUpdateConsole,
} from "../lib/tauri/dbCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  DEFAULT_MAX_ROWS,
  DEFAULT_PAGE_SIZE,
  defaultConnectionConfig,
  engineInfo,
  type DbConnectionConfig,
  type DbForeignKey,
  type DbConnectionRow,
  type DbConsole,
  type DbExecuteResult,
  type DbKind,
  type DbNode,
  type DbNodeRef,
  type DbQueryHistoryEntry,
  type DbRowEdit,
  type DbServerInfo,
  type DbStatementResult,
} from "../types/database";

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

/** How many history rows to load. Well under the backend's hard cap — this is a list to scan, not
 * an archive to browse. */
const HISTORY_LIMIT = 300;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

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
  orderBy: string | null;
  descending: boolean;
  loading: boolean;
  runId: string | null;
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
  error: string | null;
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

export type DbTab = DbConsoleTab | DbDataTab | DbDdlTab;

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
  consoles: DbConsole[];
  history: DbQueryHistoryEntry[];
  /** Connection ids with a live session. */
  connected: string[];
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

  init: (workspaceId: string) => Promise<void>;
  setWorkspace: (workspaceId: string) => Promise<void>;
  setSection: (section: DbSidebarSection) => void;

  createConnection: (kind: DbKind, name: string) => Promise<DbConnectionRow | null>;
  saveConnection: (
    row: DbConnectionRow,
    config: DbConnectionConfig,
    password: string | null,
  ) => Promise<boolean>;
  deleteConnection: (id: string) => Promise<void>;
  /** Returns the copy, so a caller that has somewhere to put it — the dialog's list — can select it. */
  duplicateConnection: (id: string) => Promise<DbConnectionRow | null>;
  reorderConnections: (ids: string[]) => Promise<void>;
  connect: (id: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  testConnection: (config: DbConnectionConfig) => Promise<DbServerInfo>;

  toggleNode: (connectionId: string, node: DbNodeRef, key: string) => Promise<void>;
  refreshNode: (connectionId: string, node: DbNodeRef, key: string) => Promise<void>;

  openConsole: (connectionId: string, consoleId?: string) => void;
  newConsole: (connectionId: string, database?: string, schema?: string, body?: string) => void;
  updateConsole: (tabId: string, patch: Partial<DbConsoleTab>) => void;
  saveConsole: (tabId: string) => Promise<void>;
  deleteConsole: (consoleId: string) => Promise<void>;
  runConsole: (tabId: string, sql?: string) => Promise<void>;
  explainConsole: (tabId: string, sql?: string) => Promise<void>;
  cancelRun: (tabId: string) => Promise<void>;

  openData: (connectionId: string, node: DbNodeRef, name: string, filter?: string) => void;
  /** Opens the table a foreign-key column points at. `null` opens it whole. */
  followForeignKey: (tab: DbDataTab, key: DbForeignKey, value: string | null) => void;
  /** Rewrites which schemas a connection's tree lists. See the implementation for what the
   * updater is handed when nothing has been filtered yet. */
  setVisibleSchemas: (connectionId: string, update: (current: string[]) => string[]) => Promise<void>;
  updateData: (tabId: string, patch: Partial<DbDataTab>) => void;
  loadData: (tabId: string) => Promise<void>;
  setCell: (tabId: string, row: number, column: string, value: string | null) => void;
  toggleDeleteRow: (tabId: string, row: number) => void;
  addRow: (tabId: string) => void;
  setInsertedCell: (tabId: string, row: number, column: string, value: string | null) => void;
  removeInsertedRow: (tabId: string, row: number) => void;
  revertEdits: (tabId: string) => void;
  applyEdits: (tabId: string) => Promise<void>;

  openDdl: (connectionId: string, node: DbNodeRef, name: string) => Promise<void>;

  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;

  refreshHistory: () => Promise<void>;
  deleteHistory: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
}

/**
 * Guards against the four callers that can race a first load (the view mounting, StrictMode
 * mounting it twice, the workspace switch and a restored session), the same latch `apiStore` uses.
 */
let pendingLoad: { workspaceId: string; promise: Promise<void> } | null = null;

export function ensureDbStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return Promise.resolve();
  return useDbStore.getState().setWorkspace(workspaceId);
}

/** Identifies a node in the `children` cache. Includes the connection, so two connections'
 * identically-named schemas never share an entry. */
export function nodeKey(connectionId: string, node: DbNodeRef): string {
  return [connectionId, node.kind, node.database ?? "", node.schema ?? "", node.name ?? ""].join("|");
}

export const useDbStore = create<DbState>((set, get) => ({
  workspaceId: null,
  loading: false,
  connections: [],
  consoles: [],
  history: [],
  connected: [],
  serverInfo: {},
  children: {},
  expanded: [],
  loadingNodes: [],
  nodeErrors: {},
  tabs: [],
  activeTabId: null,
  section: "explorer",

  init: async (workspaceId) => {
    set({ workspaceId, loading: true });
    try {
      const [tree, history, connected, rawTabs] = await Promise.all([
        dbLoadTree(workspaceId),
        dbListHistory(workspaceId, HISTORY_LIMIT),
        dbConnected().catch(() => [] as string[]),
        getSetting(openTabsKey(workspaceId)).catch(() => null),
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
    set({
      connections: [],
      consoles: [],
      history: [],
      children: {},
      expanded: [],
      nodeErrors: {},
      serverInfo: {},
      tabs: [],
      activeTabId: null,
    });
    const promise = get().init(workspaceId);
    pendingLoad = { workspaceId, promise };
    return promise;
  },

  setSection: (section) => set({ section }),

  // ------------------------------------------------------------- connections

  createConnection: async (kind, name) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    const config = defaultConnectionConfig(kind);
    return guarded(async () => {
      const row = await dbCreateConnection(
        workspaceId,
        name,
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
    const saved = await guarded(async () => {
      await dbUpdateConnection(next);
      if (password !== null) await dbSetPassword(row.id, password);
      return true;
    });
    if (!saved) return false;
    set((s) => ({
      connections: s.connections.map((c) => (c.id === next.id ? next : c)),
      // Saving closes the session on the backend, so the dot has to go with it.
      connected: s.connected.filter((id) => id !== next.id),
      // Anything cached about the old server is now about a server we may not be talking to.
      children: dropConnection(s.children, next.id),
      expanded: s.expanded.filter((key) => !key.startsWith(`${next.id}|`)),
    }));
    return true;
  },

  deleteConnection: async (id) => {
    await guarded(async () => {
      await dbDeleteConnection(id);
      set((s) => ({
        connections: s.connections.filter((c) => c.id !== id),
        consoles: s.consoles.filter((c) => c.connection_id !== id),
        connected: s.connected.filter((c) => c !== id),
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

  connect: async (id) => {
    const info = await guarded(() => dbConnect(id));
    if (!info) return false;
    set((s) => ({
      connected: s.connected.includes(id) ? s.connected : [...s.connected, id],
      serverInfo: { ...s.serverInfo, [id]: info },
    }));
    return true;
  },

  disconnect: async (id) => {
    await guarded(() => dbDisconnect(id));
    set((s) => ({
      connected: s.connected.filter((c) => c !== id),
      children: dropConnection(s.children, id),
      expanded: s.expanded.filter((key) => !key.startsWith(`${id}|`)),
    }));
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
      }
      patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({ ...current, dirty: false }));
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

    const runId = newRunId();
    patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
      ...current,
      running: true,
      runId,
      plan: null,
      result: null,
    }));

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
      }));
      await recordHistory(get, tab, statement, result, Date.now() - started);
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
      }));
    } finally {
      patchTab<DbConsoleTab>(set, tabId, "console", (current) => ({
        ...current,
        running: false,
        runId: null,
      }));
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
    }
  },

  cancelRun: async (tabId) => {
    const tab = get().tabs.find((entry) => entry.id === tabId);
    const runId =
      tab && (tab.kind === "console" || tab.kind === "data") ? tab.runId : null;
    if (!runId) return;
    await guarded(() => dbCancel(runId));
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
      orderBy: null,
      descending: false,
      loading: false,
      runId: null,
      result: null,
      total: null,
      columns: [],
      foreignKeys: [],
      pending: {},
      deleted: [],
      inserted: [],
      error: null,
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
   * Rewrites which schemas a connection's tree lists.
   *
   * The updater is handed the *effective* list, not the stored one: an empty setting means "all",
   * and "hide this one" has to start from the full set or it would turn into "show only the
   * others of which there are none". What the explorer has loaded is that full set — which is why
   * this is only offered from a tree that is already open.
   */
  setVisibleSchemas: async (connectionId, update) => {
    const state = get();
    const row = state.connections.find((c) => c.id === connectionId);
    const config = row ? parseSpec(row) : null;
    if (!row || !config) return;
    const current =
      config.visible_schemas.length > 0
        ? config.visible_schemas
        : loadedSchemas(state.children, connectionId);
    await state.saveConnection(row, { ...config, visible_schemas: update(current) }, null);
  },

  updateData: (tabId, patch) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({ ...tab, ...patch }));
  },

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
    }));
    try {
      const result = await dbTableData(
        tab.connectionId,
        {
          node: tab.node,
          offset: tab.offset,
          limit: tab.limit,
          order_by: tab.orderBy,
          descending: tab.descending,
          filter: tab.filter,
        },
        runId,
      );
      patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, result }));

      // The columns are what the primary key comes from, so the editor needs them before it can
      // build an `UPDATE`. Fetched once per tab, not per page.
      if (tab.columns.length === 0) {
        const columnNode: DbNodeRef = { ...tab.node, kind: "column_folder" };
        const columns = await dbChildren(tab.connectionId, columnNode).catch(() => [] as DbNode[]);
        patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, columns }));
      }
      // Deliberately after the rows: on a large table the count is a full scan while the page is an
      // index read, so the grid fills first and the total arrives when it arrives.
      void dbRowCount(tab.connectionId, tab.node, tab.filter, newRunId())
        .then((total) =>
          patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, total })),
        )
        .catch(() => {});
    } catch (e) {
      patchTab<DbDataTab>(set, tabId, "data", (current) => ({ ...current, error: String(e) }));
    } finally {
      patchTab<DbDataTab>(set, tabId, "data", (current) => ({
        ...current,
        loading: false,
        runId: null,
      }));
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

  revertEdits: (tabId) => {
    patchTab<DbDataTab>(set, tabId, "data", (tab) => ({
      ...tab,
      pending: {},
      deleted: [],
      inserted: [],
    }));
  },

  applyEdits: async (tabId) => {
    const tab = findTab<DbDataTab>(get, tabId, "data");
    if (!tab || !tab.result) return;
    const edits = buildEdits(tab);
    if (edits.length === 0) return;

    await guarded(async () => {
      const outcome = await dbApplyEdits(tab.connectionId, tab.node, edits);
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
    }
  },

  // -------------------------------------------------------------------- tabs

  closeTab: (tabId) => {
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
    if (history) set({ history });
  },

  deleteHistory: async (id) => {
    await guarded(() => dbDeleteHistory(id));
    set((s) => ({ history: s.history.filter((entry) => entry.id !== id) }));
  },

  clearHistory: async () => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    await guarded(() => dbClearHistory(workspaceId));
    set({ history: [] });
  },
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

  // Updates first, then deletes, then inserts. Deleting before updating would make an update to a
  // deleted row fail; inserting last means a new row can reuse a unique value a delete just freed.
  const touchedRows = new Set<number>();
  for (const key of Object.keys(tab.pending)) {
    const row = Number(key.split(":")[0]);
    if (!tab.deleted.includes(row)) touchedRows.add(row);
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

  return edits;
}

/** Whether a table's rows can be identified by a primary key. Drives the warning the UI shows
 * before applying edits without one. */
export function hasPrimaryKey(tab: DbDataTab): boolean {
  return tab.columns.some((column) => column.column?.primary_key);
}

export function pendingCount(tab: DbDataTab): number {
  const updatedRows = new Set(
    Object.keys(tab.pending)
      .map((key) => Number(key.split(":")[0]))
      .filter((row) => !tab.deleted.includes(row)),
  );
  return updatedRows.size + tab.deleted.length + tab.inserted.length;
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

/** Every schema the explorer has loaded under one connection, in the order it found them. */
function loadedSchemas(children: Record<string, DbNode[]>, connectionId: string): string[] {
  const names = new Set<string>();
  for (const [key, nodes] of Object.entries(children)) {
    if (!key.startsWith(`${connectionId}|`)) continue;
    for (const node of nodes) {
      if (node.kind === "schema") names.add(node.name);
    }
  }
  return [...names];
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

/** Strips the credentials out of a connection URI for display. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^/@]*)@/, (_match, credentials: string) => {
    const user = credentials.split(":")[0];
    return user ? `//${user}:••••@` : "//";
  });
}

async function recordHistory(
  get: () => DbState,
  tab: DbConsoleTab,
  statement: string,
  result: DbExecuteResult,
  duration: number,
) {
  const workspaceId = get().workspaceId;
  if (!workspaceId) return;
  const connection = get().connections.find((c) => c.id === tab.connectionId);
  const failed = result.results.find((entry) => entry.error);
  const rows = result.results.reduce(
    (total, entry) => total + (entry.rows_affected ?? entry.rows.length),
    0,
  );
  const entry: DbQueryHistoryEntry = {
    id: "",
    workspace_id: workspaceId,
    connection_id: tab.connectionId,
    connection_name: connection?.name ?? "",
    statement,
    database_name: tab.database,
    duration_ms: duration,
    row_count: rows,
    error: failed?.error ?? "",
    ran_at: "",
  };
  // A history write that fails must not make a successful query look like it failed.
  const saved = await dbAddHistory(entry).catch(() => null);
  if (saved) {
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
    };
  }
  const node = persisted.node ?? { kind: "table", database: null, schema: null, name: null };
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
    orderBy: null,
    descending: false,
    loading: false,
    runId: null,
    // Deliberately not loaded on restore: reopening the app must not fire a query per restored tab
    // at a database that may be behind a VPN. The grid asks when the tab is looked at.
    result: null,
    total: null,
    columns: [],
    foreignKeys: [],
    pending: {},
    deleted: [],
    inserted: [],
    error: null,
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
