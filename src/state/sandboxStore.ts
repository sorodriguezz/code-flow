import { create } from "zustand";
import * as api from "../lib/tauri/sandboxCommands";
import type { SandboxPage, SandboxStatus } from "../lib/tauri/sandboxCommands";
import type { DbStatementResult } from "../types/database";
import type { CellFailure, ConstraintNote, SqliteWarning } from "../lib/dbml/sqlite";
import { readFailure, toSqliteDdl } from "../lib/dbml/sqlite";
import { deleteSql, insertSql, parentProbeSql, updateSql } from "../lib/dbml/rows";
import { fillPlan } from "../lib/dbml/fill";
import type { DbmlSchema } from "../lib/dbml/types";
import { pushErrorToast } from "./toastStore";

/**
 * The DBML scratch database, per diagram.
 *
 * **A store rather than component state**, for one reason that is worth stating plainly: Datos is a
 * *surface*, so switching to Diagrama unmounts it. If the selected table, the console buffer and
 * the current page lived in the panel, going to look at the drawing and coming back would throw
 * away a half-written query. The canvas keeps its pan and zoom across the same switch and losing
 * either would be the same bug.
 *
 * Keyed by diagram id and never cleared on switch: two diagrams open in two windows keep their own
 * console text, and coming back to one you tested last week finds it where you left it.
 *
 * **Everything about *rows* is asked for fresh.** The row cache is one page of one table and is
 * dropped on every write, including a console run — because your `UPDATE` could have touched
 * anything, and a grid showing what the table held before it is a grid that is lying.
 */

/** How many rows the grid holds at once. Large enough that scrolling is rare, small enough that a
 *  table someone filled from the console does not arrive as one megabyte of JSON. */
export const PAGE_SIZE = 200;

/** One diagram's slice. Absent until the surface is opened for it. */
export interface SandboxState {
  status: SandboxStatus | null;
  /** Warnings from the last build. Separate from `status.warnings` — those are the engine's, these
   *  are the emitter's, and the two are answering different questions. */
  buildWarnings: SqliteWarning[];
  /** Decoded from `status.constraints`. The map from a constraint name back to what it meant. */
  notes: Record<string, ConstraintNote>;
  /** Which table the grid is showing. A physical table name, so it matches `counts`. */
  table: string | null;
  page: SandboxPage | null;
  offset: number;
  /** The console buffer, kept across surface switches. */
  sql: string;
  results: DbStatementResult[] | null;
  running: boolean;
  loading: boolean;
  /** Set while a build is in flight, so the button can say so and cannot be pressed twice. */
  building: boolean;
  /** The drift bar's verdict, or `null` when the model and the data agree. */
  drift: Drift | null;
  /** Dismissed with "Ignorar" — held per diagram, cleared by the next build. */
  driftIgnored: boolean;
  /** What a failed migration said. Shown in place of the bar's buttons. */
  driftError: string | null;
}

/** One foreign key to check before an insert, so its failure can name a cell. */
export interface RowProbe {
  /** The child column being written — where the message lands. */
  column: string;
  /** The physical parent table, and the columns the reference points at. */
  parent: string;
  parentColumns: string[];
  /** What was typed into the child columns, in the same order. */
  values: (string | null)[];
}

/** What changed between the schema that built the sandbox and the one on screen now. */
export interface Drift {
  addedTables: string[];
  droppedTables: string[];
  addedColumns: { table: string; column: string; notNull: boolean; hasDefault: boolean }[];
  droppedColumns: { table: string; column: string }[];
  changedColumns: { table: string; column: string }[];
}

const EMPTY: SandboxState = {
  status: null,
  buildWarnings: [],
  notes: {},
  table: null,
  page: null,
  offset: 0,
  sql: "",
  results: null,
  running: false,
  loading: false,
  building: false,
  drift: null,
  driftIgnored: false,
  driftError: null,
};

interface SandboxStore {
  byDiagram: Record<string, SandboxState>;
  /** Reads the file's status and works out whether the model has moved since it was built. */
  refresh: (diagramId: string, schema: DbmlSchema) => Promise<void>;
  build: (diagramId: string, schema: DbmlSchema) => Promise<void>;
  wipe: (diagramId: string) => Promise<void>;
  select: (diagramId: string, table: string | null) => Promise<void>;
  loadPage: (diagramId: string, offset: number) => Promise<void>;
  reload: (diagramId: string) => Promise<void>;
  /** Writes one row. Answers with the cell to blame, or `null` when the engine took it. */
  insertRow: (
    diagramId: string,
    table: string,
    values: Record<string, string | null>,
    probes: RowProbe[],
  ) => Promise<CellFailure | null>;
  updateCell: (
    diagramId: string,
    table: string,
    rowid: number,
    column: string,
    value: string | null,
  ) => Promise<CellFailure | null>;
  deleteRows: (diagramId: string, table: string, rowids: number[]) => Promise<CellFailure | null>;
  setSql: (diagramId: string, sql: string) => void;
  run: (diagramId: string, sql: string) => Promise<void>;
  cancel: (diagramId: string) => void;
  /** Applies the changed model over the rows that are there. Sets `driftError` on refusal. */
  applyDrift: (diagramId: string, schema: DbmlSchema) => Promise<void>;
  ignoreDrift: (diagramId: string) => void;
  /** Twenty rows per table, parents first. Returns the tables it could not reach. */
  fill: (diagramId: string, schema: DbmlSchema) => Promise<string[]>;
  exportSql: (diagramId: string) => Promise<string>;
  exportFile: (diagramId: string) => Promise<string>;
  close: (diagramId: string) => void;
}

export const useSandboxStore = create<SandboxStore>((set, get) => {
  /** Reads one diagram's slice, filling in the empty one rather than returning `undefined`. */
  const slice = (diagramId: string): SandboxState => get().byDiagram[diagramId] ?? EMPTY;

  const patch = (diagramId: string, next: Partial<SandboxState>) =>
    set((state) => ({
      byDiagram: {
        ...state.byDiagram,
        [diagramId]: { ...(state.byDiagram[diagramId] ?? EMPTY), ...next },
      },
    }));

  /**
   * Runs one statement and reads a failure back as a cell to blame.
   *
   * A thrown error and a `result.error` are the same event from the grid's point of view — the row
   * was not written — so they are flattened here rather than at each of the three call sites.
   */
  const write = async (diagramId: string, sql: string): Promise<CellFailure | null> => {
    try {
      const [result] = await api.sandboxExecute(diagramId, sql);
      if (!result) return null;
      if (result.error) return readFailure(result.error, slice(diagramId).notes);
      return null;
    } catch (error) {
      return readFailure(String(error), slice(diagramId).notes);
    }
  };

  /** The first table you can actually fill: the parents-first order, first entry that exists. */
  const firstTable = (status: SandboxStatus, order: string[]): string | null =>
    order.find((id) => id in status.counts) ?? Object.keys(status.counts)[0] ?? null;

  return {
    byDiagram: {},

    async refresh(diagramId, schema) {
      patch(diagramId, { loading: true });
      try {
        const status = await api.sandboxStatus(diagramId);
        const notes = parseNotes(status.constraints);
        const built = parseSchema(status.schema);
        const current = toSqliteDdl(schema);
        const drift =
          status.built && built && status.fingerprint !== current.fingerprint
            ? diffSchemas(built, schema)
            : null;
        const previous = slice(diagramId);
        patch(diagramId, {
          status,
          notes,
          loading: false,
          drift,
          // A new build clears the dismissal; a refresh that finds the *same* drift keeps it, or
          // pressing "Ignorar" would last exactly until the next keystroke re-parsed the document.
          driftIgnored: drift ? previous.driftIgnored : false,
          table: previous.table ?? (status.built ? firstTable(status, current.order) : null),
        });
        if (status.built && !previous.page) {
          const table = previous.table ?? firstTable(status, current.order);
          if (table) await get().select(diagramId, table);
        }
      } catch (error) {
        patch(diagramId, { loading: false });
        pushErrorToast(String(error));
      }
    },

    async build(diagramId, schema) {
      const emitted = toSqliteDdl(schema);
      if (!emitted.ddl.trim()) {
        patch(diagramId, { buildWarnings: emitted.warnings });
        return;
      }
      patch(diagramId, { building: true, driftError: null });
      try {
        const status = await api.sandboxOpen(
          diagramId,
          emitted.ddl,
          emitted.fingerprint,
          JSON.stringify(schema),
          JSON.stringify(emitted.constraints),
        );
        patch(diagramId, {
          status,
          notes: emitted.constraints,
          buildWarnings: emitted.warnings,
          building: false,
          drift: null,
          driftIgnored: false,
          table: firstTable(status, emitted.order),
          page: null,
          offset: 0,
          results: null,
        });
        const table = firstTable(status, emitted.order);
        if (table) await get().select(diagramId, table);
      } catch (error) {
        patch(diagramId, { building: false, buildWarnings: emitted.warnings });
        pushErrorToast(String(error));
      }
    },

    async wipe(diagramId) {
      try {
        await api.sandboxWipe(diagramId);
        patch(diagramId, {
          status: null,
          page: null,
          table: null,
          offset: 0,
          results: null,
          drift: null,
          driftIgnored: false,
          buildWarnings: [],
          notes: {},
        });
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    async select(diagramId, table) {
      patch(diagramId, { table, offset: 0, page: null });
      if (table) await get().loadPage(diagramId, 0);
    },

    async loadPage(diagramId, offset) {
      const { table } = slice(diagramId);
      if (!table) return;
      patch(diagramId, { loading: true });
      try {
        const page = await api.sandboxPage(diagramId, table, offset, PAGE_SIZE);
        patch(diagramId, { page, offset, loading: false });
      } catch (error) {
        patch(diagramId, { loading: false });
        pushErrorToast(String(error));
      }
    },

    /** Re-reads the current page and the counts. Called after every write, unconditionally. */
    async reload(diagramId) {
      const { offset, status } = slice(diagramId);
      try {
        const counts = await api.sandboxCounts(diagramId);
        if (status) patch(diagramId, { status: { ...status, counts } });
      } catch {
        // A counts failure is not worth a toast on top of whatever just failed.
      }
      await get().loadPage(diagramId, offset);
    },

    async insertRow(diagramId, table, values, probes) {
      // The probes run first and are pure diagnosis — the insert goes ahead either way. Their whole
      // job is to turn the engine's anonymous `FOREIGN KEY constraint failed` into a sentence that
      // names one cell; see `parentProbeSql`.
      for (const probe of probes) {
        if (probe.values.every((value) => value === null)) continue;
        try {
          const [result] = await api.sandboxExecute(
            diagramId,
            parentProbeSql(probe.parent, probe.parentColumns, probe.values),
          );
          if (result && !result.error && result.rows.length === 0) {
            await get().reload(diagramId);
            return {
              table,
              column: probe.column,
              code: "foreignKey",
              detail: probe.parent,
            };
          }
        } catch {
          // A probe that cannot run tells us nothing, and must not stop the insert. The engine is
          // still the authority; the message is just less specific.
        }
      }
      const failure = await write(diagramId, insertSql(table, values));
      await get().reload(diagramId);
      return failure;
    },

    async updateCell(diagramId, table, rowid, column, value) {
      const failure = await write(diagramId, updateSql(table, rowid, column, value));
      await get().reload(diagramId);
      return failure;
    },

    async deleteRows(diagramId, table, rowids) {
      if (rowids.length === 0) return null;
      const failure = await write(diagramId, deleteSql(table, rowids));
      await get().reload(diagramId);
      return failure;
    },

    setSql(diagramId, sql) {
      patch(diagramId, { sql });
    },

    async run(diagramId, sql) {
      if (!sql.trim()) return;
      patch(diagramId, { running: true });
      try {
        const results = await api.sandboxExecute(diagramId, sql);
        patch(diagramId, { results, running: false });
      } catch (error) {
        patch(diagramId, { running: false });
        pushErrorToast(String(error));
      }
      // Unconditionally, and after a failure too: a batch stops at its first error, so the
      // statements before it already ran. Refreshing only on success would leave the grid showing
      // rows that no longer exist.
      await get().reload(diagramId);
    },

    cancel(diagramId) {
      void api.sandboxCancel(diagramId).catch(() => undefined);
    },

    async applyDrift(diagramId, schema) {
      const emitted = toSqliteDdl(schema);
      patch(diagramId, { building: true, driftError: null });
      try {
        const status = await api.sandboxMigrate(
          diagramId,
          emitted.ddl,
          emitted.fingerprint,
          JSON.stringify(schema),
          JSON.stringify(emitted.constraints),
        );
        patch(diagramId, {
          status,
          notes: emitted.constraints,
          buildWarnings: emitted.warnings,
          building: false,
          drift: null,
          driftIgnored: false,
          driftError: null,
        });
        await get().reload(diagramId);
      } catch (error) {
        // Not a toast. The engine's refusal *is* the answer here — "these rows cannot satisfy that
        // column" — so it belongs in the drift bar, next to the buttons that offer the way out,
        // rather than in a notification that slides away.
        patch(diagramId, { building: false, driftError: String(error) });
      }
    },

    ignoreDrift(diagramId) {
      patch(diagramId, { driftIgnored: true });
    },

    async fill(diagramId, schema) {
      // Foreign keys are drawn from rows that already exist, so a fill on top of rows you typed by
      // hand points at yours. One page per parent column is enough — the plan writes twenty.
      const existing = new Map<string, string[]>();
      const { status } = slice(diagramId);
      for (const table of schema.tables) {
        if (!status?.counts[table.id]) continue;
        try {
          const page = await api.sandboxPage(diagramId, table.id, 0, 50);
          page.columns.forEach((column, index) => {
            existing.set(
              `${table.id}|${column.name}`,
              page.rows.map((row) => row[index]).filter((value): value is string => value !== null),
            );
          });
        } catch {
          // A table that cannot be read contributes no keys, which is the same as an empty one.
        }
      }
      const { statements, skipped } = fillPlan(schema, existing);
      if (statements.length > 0) {
        // One batch, so twenty rows across four tables is one round trip rather than eighty.
        await get().run(diagramId, statements.join("\n"));
      }
      return skipped;
    },

    exportSql: (diagramId) => api.sandboxExportSql(diagramId),
    exportFile: (diagramId) => api.sandboxExportFile(diagramId),

    close(diagramId) {
      void api.sandboxClose(diagramId).catch(() => undefined);
    },
  };
});

/** One diagram's slice, for a component that only cares about its own. */
export const sandboxOf = (diagramId: string) => (state: SandboxStore) =>
  state.byDiagram[diagramId] ?? EMPTY;

// ---------------------------------------------------------------------------
// Decoding what the file remembers
// ---------------------------------------------------------------------------

function parseNotes(json: string | null): Record<string, ConstraintNote> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, ConstraintNote>;
  } catch {
    return {};
  }
}

function parseSchema(json: string | null): DbmlSchema | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as DbmlSchema;
  } catch {
    return null;
  }
}

/**
 * What moved between the schema that built the sandbox and the one on screen.
 *
 * **A rename is reported as a drop plus an add, and the bar says so out loud.** Telling the two
 * apart from two schemas is impossible — the information simply is not there — and the only place a
 * rename journal could be written is the document, which reopens the whole sidecar argument that
 * `doc_versions` already settled. A heuristic that guesses wrong silently is worse than one that
 * does not guess, so it does not guess.
 */
export function diffSchemas(before: DbmlSchema, after: DbmlSchema): Drift {
  const beforeTables = new Map(before.tables.map((table) => [table.id, table]));
  const afterTables = new Map(after.tables.map((table) => [table.id, table]));

  const drift: Drift = {
    addedTables: [...afterTables.keys()].filter((id) => !beforeTables.has(id)),
    droppedTables: [...beforeTables.keys()].filter((id) => !afterTables.has(id)),
    addedColumns: [],
    droppedColumns: [],
    changedColumns: [],
  };

  for (const [id, table] of afterTables) {
    const old = beforeTables.get(id);
    if (!old) continue;
    const oldFields = new Map(old.fields.map((entry) => [entry.name, entry]));
    const newFields = new Map(table.fields.map((entry) => [entry.name, entry]));
    for (const [name, entry] of newFields) {
      const previous = oldFields.get(name);
      if (!previous) {
        drift.addedColumns.push({
          table: id,
          column: name,
          notNull: entry.notNull,
          hasDefault: entry.default !== null,
        });
        continue;
      }
      const moved =
        previous.type !== entry.type ||
        previous.notNull !== entry.notNull ||
        previous.unique !== entry.unique ||
        previous.pk !== entry.pk ||
        previous.default !== entry.default;
      if (moved) drift.changedColumns.push({ table: id, column: name });
    }
    for (const name of oldFields.keys()) {
      if (!newFields.has(name)) drift.droppedColumns.push({ table: id, column: name });
    }
  }
  return drift;
}

/** Whether a drift is worth a bar at all. An empty one is possible — a note changed, say. */
export function driftIsEmpty(drift: Drift): boolean {
  return (
    drift.addedTables.length === 0 &&
    drift.droppedTables.length === 0 &&
    drift.addedColumns.length === 0 &&
    drift.droppedColumns.length === 0 &&
    drift.changedColumns.length === 0
  );
}
