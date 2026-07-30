import { invoke } from "@tauri-apps/api/core";
import type {
  DbConnectionConfig,
  DbConnectionRow,
  DbConsole,
  DbEditResult,
  DbForeignKey,
  DbExecContext,
  DbExecuteResult,
  DbNode,
  DbNodeRef,
  DbQueryHistoryEntry,
  DbRowEdit,
  DbSchemaGroup,
  DbServerInfo,
  DbStatementResult,
  DbTableDataRequest,
  DbWorkspaceTree,
} from "../../types/database";

/**
 * IPC surface for the database workspace.
 *
 * Kept out of `commands.ts` for the same reason `apiCommands.ts` is: nothing here touches git or
 * takes a repo path. What it does take is a `workspaceId` on the calls that read or create a
 * connection or a history entry — those belong to a workspace. Anything addressed by its own id
 * doesn't: the row already knows which workspace it is in.
 *
 * **There is no `dbGetPassword`, on purpose.** A stored password lives in the OS keychain and is
 * read only by the Rust side when it connects. The webview can ask *whether* one is saved
 * (`dbHasPassword`) and can replace it (`dbSetPassword`), and that is the whole surface — a getter
 * would be the one call that could leak a database credential into a JS heap or a devtools session.
 */

// ---------- stored connections ----------

export const dbLoadTree = (workspaceId: string) =>
  invoke<DbWorkspaceTree>("db_load_tree", { workspaceId });

export const dbCreateConnection = (
  workspaceId: string,
  name: string,
  kind: string,
  spec: string,
  color: string,
) => invoke<DbConnectionRow>("db_create_connection", { workspaceId, name, kind, spec, color });

/** Saving also drops any open session: a host or SSL change must not keep answering from the old
 * server. */
export const dbUpdateConnection = (connection: DbConnectionRow) =>
  invoke<void>("db_update_connection", { connection });

export const dbDeleteConnection = (id: string) => invoke<void>("db_delete_connection", { id });

export const dbDuplicateConnection = (id: string) =>
  invoke<DbConnectionRow>("db_duplicate_connection", { id });

export const dbReorderConnections = (ids: string[]) =>
  invoke<void>("db_reorder_connections", { ids });

// ---------- passwords ----------

/** An empty string clears the stored password. */
export const dbSetPassword = (connectionId: string, password: string) =>
  invoke<void>("db_set_password", { connectionId, password });

export const dbHasPassword = (connectionId: string) =>
  invoke<boolean>("db_has_password", { connectionId });

// ---------- consoles ----------

export const dbCreateConsole = (
  connectionId: string,
  name: string,
  body: string,
  databaseName: string,
  schemaName: string,
) => invoke<DbConsole>("db_create_console", { connectionId, name, body, databaseName, schemaName });

export const dbUpdateConsole = (console: DbConsole) => invoke<void>("db_update_console", { console });

export const dbDeleteConsole = (id: string) => invoke<void>("db_delete_console", { id });

// ---------- history ----------

export const dbListHistory = (workspaceId: string, limit: number) =>
  invoke<DbQueryHistoryEntry[]>("db_list_history", { workspaceId, limit });

export const dbAddHistory = (entry: DbQueryHistoryEntry) =>
  invoke<DbQueryHistoryEntry>("db_add_history", { entry });

export const dbDeleteHistory = (id: string) => invoke<void>("db_delete_history", { id });

export const dbClearHistory = (workspaceId: string) =>
  invoke<void>("db_clear_history", { workspaceId });

// ---------- live connections ----------

/**
 * Opens a session and reports what answered.
 *
 * Pass `config` to test a form the user hasn't saved: there is no row to read and possibly no
 * keychain entry yet, so the typed values come down with the call and nothing is persisted or
 * cached. Without it, the saved connection is opened and kept for later queries.
 */
export const dbConnect = (
  connectionId: string,
  config?: DbConnectionConfig,
  database?: string,
) => invoke<DbServerInfo>("db_connect", { connectionId, config: config ?? null, database: database ?? null });

export const dbDisconnect = (connectionId: string) =>
  invoke<void>("db_disconnect", { connectionId });

/** Which connections currently hold an open session. */
export const dbConnected = () => invoke<string[]>("db_connected");

export const dbChildren = (connectionId: string, node: DbNodeRef) =>
  invoke<DbNode[]>("db_children", { connectionId, node });

/**
 * Every schema the connection can reach, grouped by database.
 *
 * Unlike `dbChildren` this ignores the connection's own schema filter — it feeds the control that
 * *sets* that filter, which would otherwise only ever be able to show you what you had already
 * chosen. Reads the saved settings, so a connection edited but not applied is listed as it was last
 * saved.
 */
export const dbSchemaCatalog = (connectionId: string) =>
  invoke<DbSchemaGroup[]>("db_schema_catalog", { connectionId });

/** `runId` is what `dbCancel` stops; generate a fresh one per run. */
export const dbExecute = (
  connectionId: string,
  sql: string,
  ctx: DbExecContext,
  runId: string,
) => invoke<DbExecuteResult>("db_execute", { connectionId, sql, ctx, runId });

export const dbExplain = (connectionId: string, sql: string, ctx: DbExecContext, runId: string) =>
  invoke<string>("db_explain", { connectionId, sql, ctx, runId });

export const dbTableData = (connectionId: string, request: DbTableDataRequest, runId: string) =>
  invoke<DbStatementResult>("db_table_data", { connectionId, request, runId });

/** The expensive half of paging — a full scan on a large table — so it is asked for separately and
 * the rows can show before the total arrives. */
export const dbRowCount = (
  connectionId: string,
  node: DbNodeRef,
  filter: string,
  runId: string,
) => invoke<number>("db_row_count", { connectionId, node, filter, runId });

export const dbApplyEdits = (connectionId: string, node: DbNodeRef, edits: DbRowEdit[]) =>
  invoke<DbEditResult>("db_apply_edits", { connectionId, node, edits });

export const dbObjectDdl = (connectionId: string, node: DbNodeRef) =>
  invoke<string>("db_object_ddl", { connectionId, node });

export const dbForeignKeys = (connectionId: string, node: DbNodeRef) =>
  invoke<DbForeignKey[]>("db_foreign_keys", { connectionId, node });

export const dbCancel = (runId: string) => invoke<void>("db_cancel", { runId });
