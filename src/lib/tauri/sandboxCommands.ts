import { invoke } from "@tauri-apps/api/core";
import type { DbColumn, DbStatementResult } from "../../types/database";

/**
 * IPC surface for the DBML scratch database — one throwaway SQLite file per diagram.
 *
 * Its own file for the same reason `diagramsCommands.ts` is: nothing here takes a repository path
 * or a workspace id. What every call takes is a `diagramId`, because that is what a sandbox *is* —
 * the file is named by it, the sweep is keyed on it, and deleting the diagram deletes the file.
 *
 * **The wire types are the Database workspace's own.** `DbColumn` and `DbStatementResult` are
 * reused verbatim rather than copied, so `null` and the empty string still do not collapse into
 * each other anywhere along the path, and the console's result strip renders a sandbox result with
 * the same component that renders a Postgres one.
 *
 * See `src-tauri/src/sandbox.rs` for what the other end refuses to do — which is, deliberately,
 * almost nothing. The console runs what you typed.
 */

/** What one diagram's sandbox is, as the panel reads it. */
export interface SandboxStatus {
  /** Whether the file exists at all. A diagram nobody has tested has no sandbox. */
  built: boolean;
  /** The fingerprint of the schema that produced these rows — see `fingerprint` in `dbml/sqlite.ts`. */
  fingerprint: string | null;
  /** That whole schema as JSON, not only its hash. This is what lets the drift bar say *what*
   *  changed rather than only *that* something did. */
  schema: string | null;
  /** `constraint name → { table, column, rule, detail }` as JSON. Written at build time because a
   *  constraint name cannot be taken apart afterwards — `_` is legal in identifiers. */
  constraints: string | null;
  bytes: number;
  /** Physical table name → row count. The rail's numbers and the canvas's `~N`, from one call, so
   *  the two can never disagree. */
  counts: Record<string, number>;
  /** What building it found. An unsatisfiable reference, mostly — reported against empty tables,
   *  which is the build button's whole justification. */
  warnings: string[];
}

/** One page of one table. */
export interface SandboxPage {
  columns: DbColumn[];
  rows: (string | null)[][];
  /** The `rowid` of each row, in order — the grid's row identity, and the only one that is correct
   *  for a text key, a composite key and a table with no key at all. */
  rowids: number[];
  total: number;
}

/**
 * Builds, or rebuilds, the scratch database. **Destructive**: whatever was there is replaced.
 *
 * The DDL is emitted here rather than in Rust because the parsed schema lives here — see
 * `lib/dbml/sqlite.ts`, which is also where every id and type normalisation happens.
 */
export const sandboxOpen = (
  diagramId: string,
  ddl: string,
  fingerprint: string,
  schemaJson: string,
  constraintsJson: string,
) =>
  invoke<SandboxStatus>("sandbox_open", {
    diagramId,
    ddl,
    fingerprint,
    schemaJson,
    constraintsJson,
  });

/** Reads the file without opening a held connection. Safe to call for a diagram with no sandbox. */
export const sandboxStatus = (diagramId: string) =>
  invoke<SandboxStatus>("sandbox_status", { diagramId });

export const sandboxCounts = (diagramId: string) =>
  invoke<Record<string, number>>("sandbox_counts", { diagramId });

export const sandboxPage = (diagramId: string, table: string, offset: number, limit: number) =>
  invoke<SandboxPage>("sandbox_page", { diagramId, table, offset, limit });

/** Runs whatever the user typed, one result per statement. No guards — that is the point. */
export const sandboxExecute = (diagramId: string, sql: string) =>
  invoke<DbStatementResult[]>("sandbox_execute", { diagramId, sql });

/**
 * Applies a changed model over the rows that are already there, keeping what still fits.
 *
 * A generic twelve-step rebuild rather than a catalogue of `ALTER` cases — see `sandbox.rs`. It
 * rejects rather than truncates: a column added `not null` with no default over existing rows comes
 * back as SQLite's own `NOT NULL constraint failed: pedidos.slug`, and nothing is applied.
 */
export const sandboxMigrate = (
  diagramId: string,
  ddl: string,
  fingerprint: string,
  schemaJson: string,
  constraintsJson: string,
) =>
  invoke<SandboxStatus>("sandbox_migrate", {
    diagramId,
    ddl,
    fingerprint,
    schemaJson,
    constraintsJson,
  });

/** The whole sandbox as a `.sql` script. Text, for `apiSaveFile`. */
export const sandboxExportSql = (diagramId: string) =>
  invoke<string>("sandbox_export_sql", { diagramId });

/** The database file itself, base64. For `apiSaveBinaryFile`. */
export const sandboxExportFile = (diagramId: string) =>
  invoke<string>("sandbox_export_file", { diagramId });

/** Interrupts a statement already running. Backed by SQLite's progress handler. */
export const sandboxCancel = (diagramId: string) =>
  invoke<void>("sandbox_cancel", { diagramId });

/** Deletes the file. The "don't leave rubbish" gesture; never touches the document. */
export const sandboxWipe = (diagramId: string) => invoke<void>("sandbox_wipe", { diagramId });

/** Drops the held connection without deleting anything. Called when the surface unmounts. */
export const sandboxClose = (diagramId: string) => invoke<void>("sandbox_close", { diagramId });

/** Deletes every sandbox whose diagram is gone. One call at launch. */
export const sandboxSweep = () => invoke<number>("sandbox_sweep");
