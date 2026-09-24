import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Database,
  Download,
  Hammer,
  RotateCcw,
  Rows3,
  Terminal,
  Trash2,
} from "lucide-react";
import { useT } from "../../state/languageStore";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { driftIsEmpty, sandboxOf, useSandboxStore, type RowProbe } from "../../state/sandboxStore";
import { orderTables, refsFrom } from "../../lib/dbml/sqlite";
import type { DbmlSchema } from "../../lib/dbml/types";
import { apiSaveBinaryFile, apiSaveFile } from "../../lib/tauri/apiCommands";
import { useToastStore } from "../../state/toastStore";
import { FILL_ROWS } from "../../lib/dbml/fill";
import { SandboxAiFill } from "./SandboxAiFill";
import { SandboxConsole } from "./SandboxConsole";
import { SandboxGrid, columnsFor } from "./SandboxGrid";

/**
 * **Datos** — a real SQLite database behind the diagram you are drawing.
 *
 * The loop it exists for: draw two tables, press build, type rows in, and find out. A duplicate
 * email comes back as `UNIQUE constraint failed` because your model said it was unique; a reference
 * into a column that is not unique is a `foreign key mismatch` reported *before a single row
 * exists*; and adding `slug varchar [not null]` to a table that already has rows fails in a way
 * that names how many rows cannot satisfy it. That last one is the answer that generated data could
 * never give — generated rows satisfy a new constraint by construction.
 *
 * Nothing here analyses anything. There is no fan-out histogram, no orphan counter and no
 * cardinality verdict: with `PRAGMA foreign_keys = ON` an orphan cannot exist, so those counters
 * would all read zero. The only readings that survive are the row counts in the rail and whatever
 * you write in a `SELECT`.
 */

export function DbmlDataPanel({
  diagramId,
  schema,
  onFocusTable,
}: {
  diagramId: string;
  schema: DbmlSchema;
  /** Reveals a table on the diagram. The rail's double-click, so the two surfaces stay joined. */
  onFocusTable: (tableId: string) => void;
}) {
  const t = useT();
  const state = useSandboxStore(sandboxOf(diagramId));
  const store = useSandboxStore.getState;
  const [consoleOpen, setConsoleOpen] = useState(false);
  const consoleHeight = useLayoutStore((state) => state.sizes.dbmlConsoleHeight);
  const setSize = useLayoutStore((state) => state.setSize);
  const commitSize = useLayoutStore((state) => state.commitSize);

  const order = useMemo(() => orderTables(schema), [schema]);
  const tables = useMemo(
    () => order.order.map((id) => schema.tables.find((table) => table.id === id)).filter(Boolean),
    [order, schema],
  ) as DbmlSchema["tables"];

  // Status is read whenever the surface is shown or the model changes, so the drift bar is right
  // the moment you come back from editing rather than one interaction later.
  useEffect(() => {
    void store().refresh(diagramId, schema);
    // `schema` is a fresh object on every parse; the fingerprint inside `refresh` is what decides
    // whether anything actually changed, so re-running on identity is cheap and always correct.
  }, [diagramId, schema, store]);

  // The held connection is released when the surface goes away. The file stays.
  useEffect(() => () => store().close(diagramId), [diagramId, store]);

  const selected = tables.find((table) => table.id === state.table);
  const columns = useMemo(
    () => (selected ? columnsFor(schema, selected) : []),
    [schema, selected],
  );

  /** The references leaving the selected table, ready for the pre-insert probe. */
  const probesFor = (values: Record<string, string | null>): RowProbe[] => {
    if (!selected) return [];
    return refsFrom(schema, selected.id).map(({ child, parent }) => ({
      column: child.fields[0],
      parent: parent.table,
      parentColumns: parent.fields,
      values: child.fields.map((field) => values[field] ?? null),
    }));
  };

  const showDrift = state.drift !== null && !driftIsEmpty(state.drift) && !state.driftIgnored;

  if (schema.tables.length === 0) {
    return (
      <EmptyState
        icon={Database}
        title={t("dbml.sandbox.emptyModelTitle")}
        subtitle={t("dbml.sandbox.emptyModelSubtitle")}
      />
    );
  }

  if (!state.status?.built) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
        <Database size={26} className="text-[var(--cf-text-muted)] opacity-50" />
        <div className="max-w-md">
          <p className="text-[13px] font-medium text-[var(--cf-text)]">
            {t("dbml.sandbox.buildTitle")}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("dbml.sandbox.buildSubtitle", { count: String(schema.tables.length) })}
          </p>
        </div>
        <button
          type="button"
          disabled={state.building}
          onClick={() => void store().build(diagramId, schema)}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-accent)] transition-colors hover:bg-[var(--cf-accent)]/15 disabled:opacity-50"
        >
          <Hammer size={13} />
          {state.building ? t("dbml.sandbox.building") : t("dbml.sandbox.build")}
        </button>
        {order.cyclic.length > 0 && (
          <Notice tone="warning">
            {t("dbml.sandbox.cycle", { tables: order.cyclic.join(", ") })}
          </Notice>
        )}
        {state.buildWarnings.length > 0 && (
          <div className="flex max-w-lg flex-col gap-1">
            {state.buildWarnings.map((warning, index) => (
              <Notice key={index} tone="warning">
                {t(`dbml.sandbox.warn.${warning.code}` as "dbml.sandbox.warn.increment", {
                  table: warning.table,
                  column: warning.column ?? "",
                  detail: warning.detail,
                })}
              </Notice>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showDrift && state.drift && (
        <DriftBar
          drift={state.drift}
          rows={Object.values(state.status.counts).reduce((total, count) => total + count, 0)}
          busy={state.building}
          error={state.driftError}
          onApply={() => void store().applyDrift(diagramId, schema)}
          onRebuild={() => void store().build(diagramId, schema)}
          onIgnore={() => store().ignoreDrift(diagramId)}
        />
      )}

      {(state.status.warnings.length > 0 || state.buildWarnings.length > 0) && (
        <div className="flex shrink-0 flex-col gap-[2px] border-b border-[var(--cf-border)] px-2 py-1">
          {state.status.warnings.map((warning, index) => (
            <Notice key={`engine-${index}`} tone="warning">
              {warning}
            </Notice>
          ))}
          {state.buildWarnings.map((warning, index) => (
            <Notice key={`emit-${index}`} tone="warning">
              {t(`dbml.sandbox.warn.${warning.code}` as "dbml.sandbox.warn.increment", {
                table: warning.table,
                column: warning.column ?? "",
                detail: warning.detail,
              })}
            </Notice>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* The rail. Parents first, so you land on the table you can actually fill. */}
        <div className="flex w-[186px] shrink-0 flex-col gap-[2px] overflow-y-auto border-r border-[var(--cf-border)] p-1.5">
          <span className="px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("dbml.sandbox.tables")}
          </span>
          {tables.map((table) => {
            const cyclic = order.cyclic.includes(table.id);
            return (
              <button
                key={table.id}
                type="button"
                onClick={() => void store().select(diagramId, table.id)}
                onDoubleClick={() => onFocusTable(table.id)}
                title={cyclic ? t("dbml.sandbox.cycleShort") : undefined}
                className={`flex items-center gap-1.5 rounded-md px-2 py-[4px] text-left text-[12px] transition-colors ${
                  state.table === table.id
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                }`}
              >
                <span className="truncate">{table.id}</span>
                {cyclic && (
                  <AlertTriangle size={10} className="shrink-0 text-[var(--cf-warning)]" />
                )}
                <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums opacity-70">
                  {state.status?.counts[table.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {selected ? (
              <SandboxGrid
                diagramId={diagramId}
                table={selected.id}
                page={state.page}
                columns={columns}
                onInsert={(values) =>
                  store().insertRow(diagramId, selected.id, values, probesFor(values))
                }
                onUpdate={(rowid, column, value) =>
                  store().updateCell(diagramId, selected.id, rowid, column, value)
                }
                onDelete={(rowids) => store().deleteRows(diagramId, selected.id, rowids)}
                onJumpTo={(parent) => void store().select(diagramId, parent)}
              />
            ) : (
              <EmptyState
                icon={Database}
                title={t("dbml.sandbox.pickTable")}
                subtitle={t("dbml.sandbox.pickTableSubtitle")}
              />
            )}
          </div>

          {/* Dragged, not fixed. The handle is *above* the pane it sizes, so `invert` — pulling up
              has to make the console taller, which is the only direction anybody drags it. */}
          {consoleOpen && (
            <>
              <ResizeHandle
                axis="y"
                value={consoleHeight}
                min={160}
                max={720}
                invert
                onChange={(value) => setSize("dbmlConsoleHeight", value)}
                onCommit={(value) => commitSize("dbmlConsoleHeight", value)}
              />
              <div
                className="flex shrink-0 flex-col overflow-hidden"
                // The cap is a share of the pane and not a pixel count, because the pixel count
                // cannot know the window. A stored 700px console on a 13" screen would otherwise
                // push the toolbar off the bottom — including the button that closes it.
                style={{ height: consoleHeight, maxHeight: "70%" }}
              >
                <SandboxConsole
                  sql={state.sql}
                  onChange={(sql) => store().setSql(diagramId, sql)}
                  onRun={(sql) => void store().run(diagramId, sql)}
                  onCancel={() => store().cancel(diagramId)}
                  onClose={() => setConsoleOpen(false)}
                  running={state.running}
                  results={state.results}
                />
              </div>
            </>
          )}

          {/* The bar under the grid. Two halves with different jobs: on the left the two things you
              *do* here — open the console, fill the tables — and on the right what the database is
              plus the three ways to take it apart.

              It used to be one line of 11px ghosts: the SQL console, the whole reason this surface
              can answer a question you did not think of in advance, was a muted word between two
              dots, the same weight as the byte count beside it. On a 13" screen that is the button
              nobody finds. Everything here is at least 26px tall now, and the two verbs carry
              words, not only glyphs. */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[var(--cf-border)] px-2 py-1.5">
            <button
              type="button"
              onClick={() => setConsoleOpen((open) => !open)}
              title={t("dbml.sandbox.consoleToggle")}
              aria-pressed={consoleOpen}
              className={`inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors ${
                consoleOpen
                  ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              }`}
            >
              <Terminal size={12} />
              {t("dbml.sandbox.console")}
            </button>

            {/* Not a sparkle, and the tooltip says why. No model writes these rows: they come from
                the column types, they are the same on every run, and they satisfy every constraint
                by construction — which is exactly why they cannot answer the question this surface
                exists for. A wand here promised an intelligence that is not present. */}
            <button
              type="button"
              disabled={state.building}
              onClick={async () => {
                const skipped = await store().fill(diagramId, schema);
                const toast = useToastStore.getState().pushToast;
                if (skipped.length > 0) {
                  toast(t("dbml.sandbox.fillSkipped", { tables: skipped.join(", ") }), "info");
                } else {
                  toast(t("dbml.sandbox.filled", { count: String(FILL_ROWS) }), "success");
                }
              }}
              title={t("dbml.sandbox.fillHow", { count: String(FILL_ROWS) })}
              className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 text-[11px] font-medium text-[var(--cf-text)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-40"
            >
              <Rows3 size={12} />
              {t("dbml.sandbox.fillShort")}
              <span className="font-mono tabular-nums opacity-60">{FILL_ROWS}</span>
            </button>

            {/* And the other one. A sparkle here *is* honest — this one does ask a model — which is
                the whole reason the button next to it does not have one. The two sit together
                because they answer the same need at two different prices: types-only rows are
                instant, free and meaningless; written rows cost a call and mean something. */}
            <SandboxAiFill diagramId={diagramId} schema={schema} disabled={state.building} />

            <span className="flex-1" />

            <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              <span>{formatBytes(state.status.bytes)}</span>
              <span className="opacity-40">·</span>
              <span>
                {t("dbml.sandbox.totalRows", {
                  count: String(
                    Object.values(state.status.counts).reduce((total, count) => total + count, 0),
                  ),
                })}
              </span>
            </span>

            <div className="mx-1 h-[16px] w-px bg-[var(--cf-border)]" />

            <IconAction
              onClick={async () => {
                const toast = useToastStore.getState().pushToast;
                try {
                  // Two shapes, and the script is the one that travels: it is what you paste into a
                  // real database. The file is for opening in another SQLite tool.
                  const sql = await store().exportSql(diagramId);
                  const saved = await apiSaveFile(`${diagramId}.sql`, sql);
                  if (saved) toast(t("dbml.sandbox.exported"), "success");
                } catch (error) {
                  toast(String(error), "error");
                }
              }}
              title={t("dbml.sandbox.exportSql")}
            >
              <Download size={12} />
              <span className="font-mono text-[10.5px]">.sql</span>
            </IconAction>
            <IconAction
              onClick={async () => {
                const toast = useToastStore.getState().pushToast;
                try {
                  const base64 = await store().exportFile(diagramId);
                  const saved = await apiSaveBinaryFile(`${diagramId}.sqlite`, base64);
                  if (saved) toast(t("dbml.sandbox.exported"), "success");
                } catch (error) {
                  toast(String(error), "error");
                }
              }}
              title={t("dbml.sandbox.exportFile")}
            >
              <Download size={12} />
              <span className="font-mono text-[10.5px]">.db</span>
            </IconAction>
            <IconAction
              onClick={() => void store().build(diagramId, schema)}
              disabled={state.building}
              title={t("dbml.sandbox.rebuild")}
            >
              <RotateCcw size={12} />
            </IconAction>
            <IconAction
              danger
              onClick={async () => {
                const rows = Object.values(state.status?.counts ?? {}).reduce(
                  (total, count) => total + count,
                  0,
                );
                const ok = await confirmAction(
                  t("dbml.sandbox.wipeMessage", { count: String(rows) }),
                  true,
                  t("dbml.sandbox.wipeConfirm"),
                );
                if (ok) await store().wipe(diagramId);
              }}
              title={t("dbml.sandbox.wipe")}
            >
              <Trash2 size={12} />
            </IconAction>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One of the bar's square actions: export, rebuild, wipe.
 *
 * A component because there are four of them and the thing that has to stay constant is the *hit
 * target*. They were `py-[2px]` glyphs — eleven pixels of icon in a sixteen-pixel button, on a
 * surface whose users are often on a laptop trackpad.
 */
function IconAction({
  onClick,
  title,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`inline-flex h-[26px] min-w-[26px] items-center justify-center gap-1 rounded-md px-1.5 text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] disabled:opacity-40 ${
        danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-text)]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The bar that appears when the model moved under the data.
 *
 * Two ways out, not three: rebuild — which names how many rows it costs — or ignore. **A rename is
 * reported as a drop plus an add**, and the bar says so out loud, because telling the two apart
 * from two schemas is impossible and a heuristic that guesses wrong in silence is worse than one
 * that does not guess.
 */
function DriftBar({
  drift,
  rows,
  busy,
  error,
  onApply,
  onRebuild,
  onIgnore,
}: {
  drift: NonNullable<ReturnType<typeof useSandboxStore.getState>["byDiagram"][string]["drift"]>;
  rows: number;
  busy: boolean;
  /** What the engine said when Apply was refused. Shown here, not as a toast — see the store. */
  error: string | null;
  onApply: () => void;
  onRebuild: () => void;
  onIgnore: () => void;
}) {
  const t = useT();
  /**
   * What moved, as chips rather than as a mono run-on.
   *
   * `+ user + post − users − billing` in one grey line is four facts written as one string, on a
   * tinted background, in the colour the app uses for "less important than the rest of this". The
   * sign is the whole content — added, dropped, changed — so it carries the colour, and each change
   * is its own chip you can count.
   */
  const parts: { mark: string; label: string; tone: "add" | "drop" | "change" }[] = [];
  for (const table of drift.addedTables) parts.push({ mark: "+", label: table, tone: "add" });
  for (const table of drift.droppedTables) parts.push({ mark: "−", label: table, tone: "drop" });
  for (const entry of drift.addedColumns)
    parts.push({ mark: "+", label: `${entry.table}.${entry.column}`, tone: "add" });
  for (const entry of drift.droppedColumns)
    parts.push({ mark: "−", label: `${entry.table}.${entry.column}`, tone: "drop" });
  for (const entry of drift.changedColumns)
    parts.push({ mark: "±", label: `${entry.table}.${entry.column}`, tone: "change" });

  const TONES = {
    add: "text-[var(--cf-success)]",
    drop: "text-[var(--cf-danger)]",
    change: "text-[var(--cf-warning)]",
  } as const;

  /** A column added `not null` with no default is the one that cannot be applied over rows. */
  const blocking = drift.addedColumns.filter((entry) => entry.notNull && !entry.hasDefault);

  return (
    <div className="flex shrink-0 flex-wrap items-start gap-2 border-b border-[var(--cf-warning)]/40 bg-[var(--cf-warning)]/[0.10] px-2.5 py-2 text-[12px]">
      <AlertTriangle size={13} className="mt-[2px] shrink-0 text-[var(--cf-warning)]" />
      <div className="min-w-[260px] flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-[var(--cf-text)]">
            {t("dbml.sandbox.driftTitle")}
          </span>
          {parts.slice(0, 8).map((part, index) => (
            <span
              key={`${part.label}-${index}`}
              className="inline-flex items-center gap-1 rounded border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 py-[1px] font-mono text-[10.5px]"
            >
              <span className={TONES[part.tone]}>{part.mark}</span>
              <span className="text-[var(--cf-text)]">{part.label}</span>
            </span>
          ))}
          {parts.length > 8 && (
            <span className="font-mono text-[10.5px] text-[var(--cf-text-muted)]">
              +{parts.length - 8}
            </span>
          )}
        </div>
        {/* Written in the body colour, not the muted one. These two lines are the only explanation
            of what the buttons to the right will cost, and muted grey over an amber wash is the
            lowest-contrast pairing in the app — legible on the design's monitor and not on a
            laptop at an angle. */}
        {blocking.length > 0 && rows > 0 && (
          <p className="mt-1.5 max-w-[70ch] leading-snug text-[var(--cf-text)] opacity-85">
            {t("dbml.sandbox.driftBlocked", {
              count: String(rows),
              column: `${blocking[0].table}.${blocking[0].column}`,
            })}
          </p>
        )}
        {(drift.droppedColumns.length > 0 || drift.droppedTables.length > 0) && (
          <p className="mt-1.5 max-w-[70ch] leading-snug text-[var(--cf-text)] opacity-85">
            {t("dbml.sandbox.driftRename")}
          </p>
        )}
        {/* The refusal, verbatim and in place. `NOT NULL constraint failed: pedidos.slug` is the
            sentence the whole surface exists to produce — the change is harmless on an empty schema
            and impossible on the one you actually have. Nothing was applied. */}
        {error && (
          <div className="mt-2 rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/10 px-2 py-1.5 font-mono text-[11px] text-[var(--cf-danger)]">
            {error}
            <span className="ml-1.5 font-sans text-[var(--cf-text)] opacity-80">
              {t("dbml.sandbox.driftUntouched")}
            </span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onApply}
          disabled={busy}
          className="inline-flex h-[26px] items-center rounded-md border border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] px-2.5 text-[11px] font-medium text-[var(--cf-accent)] transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {t("dbml.sandbox.driftApply")}
        </button>
        <button
          type="button"
          onClick={onRebuild}
          disabled={busy}
          className="inline-flex h-[26px] items-center rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 text-[11px] font-medium text-[var(--cf-text)] transition-colors hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)] disabled:opacity-40"
        >
          {t("dbml.sandbox.driftRebuild", { count: String(rows) })}
        </button>
        <button
          type="button"
          onClick={onIgnore}
          className="inline-flex h-[26px] items-center rounded-md px-2.5 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          {t("dbml.sandbox.driftIgnore")}
        </button>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warning"; children: React.ReactNode }) {
  return (
    <div
      // Amber marks it; the sentence is written in the body colour. Amber text on an amber wash was
      // the least readable pairing on the surface, and these notices carry the engine's own words.
      className={`flex items-start gap-1.5 rounded-md px-2 py-[5px] text-[11px] leading-snug ${
        tone === "warning"
          ? "bg-[var(--cf-warning)]/10 text-[var(--cf-text)]"
          : "bg-[var(--cf-hover)] text-[var(--cf-text)]"
      }`}
    >
      <AlertTriangle size={11} className="mt-[2px] shrink-0 text-[var(--cf-warning)]" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
