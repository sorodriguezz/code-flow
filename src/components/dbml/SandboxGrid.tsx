import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link2, Plus, Shuffle, Trash2 } from "lucide-react";
import { useT } from "../../state/languageStore";
import { ColumnResizer, MIN_COLUMN_WIDTH, measureText } from "../common/gridBits";
import { isUuidType, labelColumnFor, newUuid, shortKey } from "../../lib/dbml/rows";
import type { CellFailure } from "../../lib/dbml/sqlite";
import { isRowidAlias, refsFrom } from "../../lib/dbml/sqlite";
import type { SandboxPage } from "../../lib/tauri/sandboxCommands";
import { sandboxPage as fetchPage } from "../../lib/tauri/sandboxCommands";
import type { DbmlSchema, DbmlTable } from "../../lib/dbml/types";

/**
 * The writable grid — where you type rows in and the model bites back.
 *
 * # Why this is not `ResultGrid`
 *
 * It is the closest precedent and it cannot be used, and the reason is behavioural rather than
 * architectural. `ResultGrid` runs a `useEffect(…, [columns, rows])` that scrolls to the top and
 * closes the editor. Every confirmed row changes the identity of `rows` — there is one more of them
 * — so on this surface each confirmation would jump you back to the first row and shut the cell you
 * were typing in. That is incompatible with "write ten rows in a row", which is the whole gesture.
 *
 * Beyond that it requires an `engine: DbKind` (there is no engine here — it is a simulation), and
 * its cell expander writes into `useDbModalStore`, whose only renderer is `DatabaseView`. What is
 * genuinely shared is shared: `gridBits` gives the resizer and the text measurement.
 *
 * # The draft row
 *
 * There is always one, at the bottom, and it is the only place a row is born. It commits on the tab
 * out of its last editable cell or on ⌘↵, and on success a fresh draft opens with the focus back on
 * the first typed column — so ten rows is ten passes of the same reflex with no reach for the
 * mouse. A rejected draft **stays a draft**: it does not vanish, it goes red on the cell the engine
 * named, and the value you typed is still there to fix.
 *
 * # `auto` is a condition, not a column position
 *
 * A cell renders as `auto` only when the column can fill itself — `increment` on an integer key, or
 * a default. A `varchar` primary key (`sku`, `codigo`, a ULID) satisfies neither: it takes focus and
 * Tab does not skip it. Skipping it because it is the first column would walk the user straight past
 * the one cell that is required, into a `NOT NULL constraint failed` on a field the grid told them
 * to ignore.
 */

const ROW_H = 26;
const HEADER_H = 30;
const DEFAULT_WIDTH = 148;

export interface GridColumn {
  name: string;
  type: string;
  /** Fills itself: `increment` on an integer key, or a default. Tab skips it; it shows `auto`. */
  auto: boolean;
  pk: boolean;
  notNull: boolean;
  unique: boolean;
  /** The reference this column is one end of, if any — the picker is built from it. */
  ref: { parent: string; parentColumns: string[]; columns: string[] } | null;
  enumValues: string[] | null;
}

/**
 * The grid's columns, from the built schema rather than from the page.
 *
 * The page's `DbColumn` carries a name and a declared type and nothing else — it cannot say whether
 * a column is a key, whether it fills itself, or what it references. All of that is in the DBML, so
 * it is read from there and matched by name.
 */
export function columnsFor(schema: DbmlSchema, table: DbmlTable): GridColumn[] {
  const pkIndex = table.indexes.find((index) => index.pk && index.columns.length > 0);
  const keys = pkIndex ? pkIndex.columns : table.fields.filter((field) => field.pk).map((f) => f.name);

  // Which end of a reference holds the key is not the slot it landed in — see `orientRef`. Reading
  // `ref.from` directly here missed every inline `ref: >`, which is the form most people write.
  const outgoing = refsFrom(schema, table.id);

  return table.fields.map((field) => {
    const ref = outgoing.find((entry) => entry.child.fields.includes(field.name));
    const enumEntry = schema.enums.find(
      (entry) => entry.id === field.type.trim() || entry.name === field.type.trim(),
    );
    return {
      name: field.name,
      type: field.type,
      // `isRowidAlias` and not a test of our own: whether a key autonumbers is the emitter's
      // decision, and asking it here is what keeps the cell that says `auto` and the column SQLite
      // actually fills from being two different columns.
      auto: isRowidAlias(table, field) || field.default !== null,
      pk: keys.includes(field.name),
      notNull: field.notNull || keys.includes(field.name),
      unique: field.unique,
      ref: ref
        ? {
            parent: ref.parent.table,
            parentColumns: ref.parent.fields,
            columns: ref.child.fields,
          }
        : null,
      enumValues: enumEntry ? enumEntry.values.map((value) => value.name) : null,
    };
  });
}

export function SandboxGrid({
  diagramId,
  table,
  page,
  columns,
  onInsert,
  onUpdate,
  onDelete,
  onJumpTo,
}: {
  diagramId: string;
  table: string;
  page: SandboxPage | null;
  columns: GridColumn[];
  onInsert: (
    values: Record<string, string | null>,
  ) => Promise<CellFailure | null>;
  onUpdate: (rowid: number, column: string, value: string | null) => Promise<CellFailure | null>;
  onDelete: (rowids: number[]) => Promise<CellFailure | null>;
  /** "Crear una" from an empty picker: stacks this draft and goes to the parent table. */
  onJumpTo: (parent: string) => void;
}) {
  const t = useT();
  const [widths, setWidths] = useState<Record<string, number>>({});
  /** The draft row's cells. Always present — the ghost row at the bottom is not optional. */
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  /** Where an engine error landed, by column. Cleared on the next edit of that cell. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ rowid: number | null; column: string } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const draftRefs = useRef<Record<string, HTMLElement | null>>({});

  /** The columns you can actually type into, in order. The Tab route. */
  const typed = useMemo(() => columns.filter((column) => !column.auto), [columns]);

  const widthOf = (column: GridColumn) =>
    widths[column.name] ?? Math.max(MIN_COLUMN_WIDTH, Math.min(DEFAULT_WIDTH, column.name.length * 9 + 60));

  // A new table means a new draft and no stale errors. Keyed on the table rather than on the page,
  // so a reload after a write does not throw away what is half-typed in the draft.
  useEffect(() => {
    setDraft({});
    setErrors({});
    setSelected(new Set());
  }, [table]);

  const focusFirst = useCallback(() => {
    const first = typed[0];
    if (!first) return;
    // Two frames: the draft row is re-rendered by the state change above, and focusing a node the
    // browser has not laid out yet is a silent no-op — the same failure mode as focusing a row
    // outside a windowed grid's rendered range.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => draftRefs.current[first.name]?.focus()),
    );
  }, [typed]);

  const commitDraft = useCallback(async () => {
    if (busy) return;
    const values: Record<string, string | null> = {};
    for (const column of columns) {
      const value = draft[column.name];
      // An `auto` column left untouched is omitted entirely rather than sent as NULL, so the engine
      // applies its default or its rowid. Sending NULL would override a default with nothing.
      if (column.auto && (value === undefined || value === "")) continue;
      if (value === undefined) continue;
      values[column.name] = value === "" ? null : value;
    }
    setBusy(true);
    const failure = await onInsert(values);
    setBusy(false);
    if (failure) {
      setErrors(failure.column ? { [failure.column]: messageFor(t, failure) } : {});
      requestAnimationFrame(() => {
        if (failure.column) draftRefs.current[failure.column]?.focus();
      });
      return;
    }
    setDraft({});
    setErrors({});
    focusFirst();
  }, [busy, columns, draft, focusFirst, onInsert, t]);

  const setCell = (column: string, value: string | null) => {
    setDraft((current) => ({ ...current, [column]: value }));
    setErrors((current) => {
      if (!(column in current)) return current;
      const next = { ...current };
      delete next[column];
      return next;
    });
  };

  const rows = page?.rows ?? [];
  const rowids = page?.rowids ?? [];
  /** Column name → its index in the page, since the page's order is the table's, not the schema's. */
  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    (page?.columns ?? []).forEach((column, index) => map.set(column.name, index));
    return map;
  }, [page]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1">
        <button
          type="button"
          onClick={focusFirst}
          className="flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[11px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <Plus size={12} />
          {t("dbml.sandbox.newRow")}
        </button>
        <button
          type="button"
          disabled={selected.size === 0 || busy}
          onClick={async () => {
            setBusy(true);
            const failure = await onDelete([...selected]);
            setBusy(false);
            setSelected(new Set());
            if (failure) setErrors({ __row: messageFor(t, failure) });
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[11px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cf-text-muted)]"
        >
          <Trash2 size={12} />
          {t("dbml.sandbox.deleteRows", { count: String(selected.size) })}
        </button>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
          {t("dbml.sandbox.rowCount", { count: String(page?.total ?? 0) })}
        </span>
      </div>

      {errors.__row && (
        <div className="shrink-0 border-b border-[var(--cf-danger)]/30 bg-[var(--cf-danger)]/10 px-2 py-1 text-[11px] text-[var(--cf-danger)]">
          {errors.__row}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[11.5px]" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr style={{ height: HEADER_H }}>
              <th className="sticky left-0 top-0 z-20 w-8 border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)]" />
              {columns.map((column) => (
                <th
                  key={column.name}
                  style={{ width: widthOf(column) }}
                  className="sticky top-0 z-10 border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 text-left align-middle font-medium"
                >
                  <div className="flex items-center gap-1 overflow-hidden">
                    <span className="truncate text-[var(--cf-text)]">{column.name}</span>
                    {column.pk && <Badge tone="warning">PK</Badge>}
                    {column.ref && <Badge tone="accent">FK</Badge>}
                    {column.unique && !column.pk && <Badge tone="violet">U</Badge>}
                    <span className="ml-auto shrink-0 font-mono text-[9.5px] text-[var(--cf-text-muted)]">
                      {column.type}
                    </span>
                  </div>
                  <ColumnResizer
                    width={widthOf(column)}
                    onChange={(width) =>
                      setWidths((current) => ({ ...current, [column.name]: width }))
                    }
                    onAutoFit={() => {
                      const font = '11.5px ui-monospace, monospace';
                      const widest = rows.reduce((widest, row) => {
                        const value = row[indexOf.get(column.name) ?? -1];
                        return Math.max(widest, measureText(value ?? "NULL", font));
                      }, measureText(column.name, font));
                      setWidths((current) => ({
                        ...current,
                        [column.name]: Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest) + 34),
                      }));
                    }}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const rowid = rowids[index];
              const picked = selected.has(rowid);
              return (
                <tr
                  key={rowid}
                  style={{ height: ROW_H }}
                  className={picked ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"}
                >
                  <td
                    onClick={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(rowid)) next.delete(rowid);
                        else next.add(rowid);
                        return next;
                      })
                    }
                    className="sticky left-0 z-10 cursor-pointer border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)] text-center font-mono text-[10px] tabular-nums text-[var(--cf-text-muted)]"
                  >
                    {index + 1}
                  </td>
                  {columns.map((column) => {
                    const at = indexOf.get(column.name);
                    const value = at === undefined ? null : row[at];
                    const isEditing =
                      editing?.rowid === rowid && editing.column === column.name;
                    return (
                      <td
                        key={column.name}
                        style={{ width: widthOf(column) }}
                        onDoubleClick={() => setEditing({ rowid, column: column.name })}
                        className="overflow-hidden truncate border-b border-r border-[var(--cf-border)] px-2 align-middle"
                      >
                        {isEditing ? (
                          <CellInput
                            column={column}
                            diagramId={diagramId}
                            value={value}
                            onJumpTo={onJumpTo}
                            onCommit={async (next) => {
                              setEditing(null);
                              if (next === value) return;
                              const failure = await onUpdate(rowid, column.name, next);
                              if (failure) setErrors({ __row: messageFor(t, failure) });
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        ) : value === null ? (
                          <span className="font-mono text-[var(--cf-text-muted)] opacity-60">
                            NULL
                          </span>
                        ) : (
                          <span className="font-mono text-[var(--cf-text)]">{value}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* The ghost row. Always there, always last, and the only place a row is created. */}
            <tr style={{ height: ROW_H }} className="bg-[var(--cf-field)]/40">
              <td className="sticky left-0 z-10 border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)] text-center text-[var(--cf-accent)]">
                <Plus size={11} className="mx-auto" />
              </td>
              {columns.map((column, index) => {
                const isLastTyped =
                  typed.length > 0 && typed[typed.length - 1].name === column.name;
                if (column.auto) {
                  return (
                    <td
                      key={column.name}
                      style={{ width: widthOf(column) }}
                      className="border-b border-r border-[var(--cf-border)] px-2 align-middle font-mono italic text-[var(--cf-text-muted)] opacity-70"
                    >
                      {t("dbml.sandbox.auto")}
                    </td>
                  );
                }
                return (
                  <td
                    key={column.name}
                    style={{ width: widthOf(column) }}
                    className={`border-b border-r px-2 align-middle ${
                      errors[column.name]
                        ? "border-[var(--cf-danger)] bg-[var(--cf-danger)]/10"
                        : "border-[var(--cf-border)]"
                    }`}
                  >
                    <CellInput
                      column={column}
                      diagramId={diagramId}
                      value={draft[column.name] ?? null}
                      inline
                      register={(node) => {
                        draftRefs.current[column.name] = node;
                      }}
                      onJumpTo={onJumpTo}
                      onChange={(next) => setCell(column.name, next)}
                      onCommit={(next) => {
                        setCell(column.name, next);
                      }}
                      onTabOut={() => {
                        if (isLastTyped) void commitDraft();
                      }}
                      onSubmit={() => void commitDraft()}
                      onCancel={() => setCell(column.name, null)}
                      autoFocusIndex={index}
                    />
                    {errors[column.name] && (
                      <div className="pointer-events-none -mt-[1px] truncate text-[9.5px] leading-[12px] text-[var(--cf-danger)]">
                        {errors[column.name]}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "warning" | "accent" | "violet"; children: string }) {
  const colour =
    tone === "warning"
      ? "text-[var(--cf-warning)]"
      : tone === "accent"
        ? "text-[var(--cf-accent)]"
        : "text-[var(--cf-violet,var(--cf-accent))]";
  return (
    <span className={`shrink-0 font-mono text-[8.5px] font-semibold tracking-wide ${colour}`}>
      {children}
    </span>
  );
}

/**
 * One editable cell: an enum becomes a `<select>`, a foreign key becomes a picker over real parent
 * rows, and everything else is a text box.
 *
 * The foreign-key case is the one that answers a question the diagram cannot: *is this reference
 * annoying to satisfy?* A picker that lists nothing, with a "create one" button that takes you to
 * the parent table and brings you back, makes the cost of the reference something you feel rather
 * than something you reason about.
 */
function CellInput({
  column,
  diagramId,
  value,
  inline,
  register,
  onChange,
  onCommit,
  onCancel,
  onTabOut,
  onSubmit,
  onJumpTo,
  autoFocusIndex,
}: {
  column: GridColumn;
  diagramId: string;
  value: string | null;
  inline?: boolean;
  register?: (node: HTMLElement | null) => void;
  onChange?: (value: string | null) => void;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
  onTabOut?: () => void;
  onSubmit?: () => void;
  onJumpTo?: (parent: string) => void;
  autoFocusIndex?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit?.();
      return;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
      // The same chord `CellEditor` already uses for "this is NULL", so there is nothing new to
      // learn on a surface that is otherwise a different grid.
      event.preventDefault();
      onCommit(null);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onCommit((event.target as HTMLInputElement).value || null);
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      onCommit((event.target as HTMLInputElement).value || null);
      onTabOut?.();
    }
  };

  if (column.enumValues) {
    return (
      <select
        ref={register as React.Ref<HTMLSelectElement>}
        value={value ?? ""}
        autoFocus={!inline}
        onChange={(event) => {
          const next = event.target.value || null;
          onChange?.(next);
          onCommit(next);
        }}
        onKeyDown={keys}
        className="w-full bg-transparent font-mono text-[11.5px] text-[var(--cf-text)] outline-none"
      >
        <option value="">—</option>
        {column.enumValues.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>
    );
  }

  /**
   * A `uuid` column with nothing to fill it — no `increment`, no default, and not a foreign key
   * pointing at a row that already has one. That is the cell with no plausible thing to type in it,
   * so it gets the one button on this grid that invents a value.
   */
  const generateUuid = isUuidType(column.type) && !column.auto && !column.ref;

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        {column.ref && <Link2 size={10} className="shrink-0 text-[var(--cf-accent)]" />}
        <input
          ref={register as React.Ref<HTMLInputElement>}
          value={value ?? ""}
          autoFocus={!inline || autoFocusIndex === undefined ? !inline : undefined}
          placeholder={column.ref ? `↳ ${column.ref.parent}` : undefined}
          onChange={(event) => onChange?.(event.target.value || null)}
          onFocus={() => column.ref && setOpen(true)}
          onBlur={(event) => {
            // The picker's own buttons use `onMouseDown` with `preventDefault`, so a click on one
            // does not reach here first and close the list out from under the pointer.
            setTimeout(() => setOpen(false), 0);
            onCommit(event.target.value || null);
          }}
          onKeyDown={keys}
          className="w-full min-w-0 bg-transparent font-mono text-[11.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] placeholder:opacity-50"
        />
        {generateUuid && (
          // `onMouseDown` with `preventDefault`, like the foreign-key picker's rows: a plain click
          // would blur the input first, and the blur commits — so the generated value would be
          // written into a cell that had already closed on the empty one before it.
          <button
            type="button"
            title={t("dbml.sandbox.uuidNew")}
            aria-label={t("dbml.sandbox.uuidNew")}
            onMouseDown={(event) => {
              event.preventDefault();
              const generated = newUuid();
              onChange?.(generated);
              onCommit(generated);
            }}
            className="shrink-0 rounded p-[2px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-accent)]"
          >
            <Shuffle size={11} />
          </button>
        )}
      </div>
      {open && column.ref && (
        <ForeignKeyPicker
          diagramId={diagramId}
          reference={column.ref}
          onPick={(picked) => {
            setOpen(false);
            onChange?.(picked);
            onCommit(picked);
          }}
          onCreate={() => {
            setOpen(false);
            onJumpTo?.(column.ref!.parent);
          }}
          emptyLabel={t("dbml.sandbox.fkEmpty", { table: column.ref.parent })}
          createLabel={t("dbml.sandbox.fkCreate")}
        />
      )}
    </div>
  );
}

/** The parent's real rows: the key, and the first readable column beside it. */
function ForeignKeyPicker({
  diagramId,
  reference,
  onPick,
  onCreate,
  emptyLabel,
  createLabel,
}: {
  diagramId: string;
  reference: { parent: string; parentColumns: string[] };
  onPick: (value: string) => void;
  onCreate: () => void;
  emptyLabel: string;
  createLabel: string;
}) {
  const [page, setPage] = useState<SandboxPage | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchPage(diagramId, reference.parent, 0, 50)
      .then((result) => {
        if (alive) setPage(result);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [diagramId, reference.parent]);

  if (!page) return null;
  const keyIndex = page.columns.findIndex((column) => column.name === reference.parentColumns[0]);
  const labelName = labelColumnFor(page.columns, reference.parentColumns);
  const labelIndex = labelName
    ? page.columns.findIndex((column) => column.name === labelName)
    : -1;

  return (
    <div className="absolute left-0 top-full z-50 mt-1 max-h-52 w-56 overflow-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
      {page.rows.length === 0 ? (
        <div className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
          {emptyLabel}
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              onCreate();
            }}
            className="mt-1.5 block rounded-md border border-[var(--cf-accent)] px-1.5 py-[2px] text-[10.5px] text-[var(--cf-accent)] transition-colors hover:bg-[var(--cf-accent-soft)]"
          >
            {createLabel}
          </button>
        </div>
      ) : (
        page.rows.map((row, index) => {
          const key = keyIndex >= 0 ? (row[keyIndex] ?? "") : "";
          const label = labelIndex >= 0 ? row[labelIndex] : null;
          return (
            <button
              key={page.rowids[index]}
              type="button"
              title={key}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(key);
              }}
              className="flex w-full items-baseline gap-1.5 truncate rounded-md px-2 py-[3px] text-left text-[11px] transition-colors hover:bg-[var(--cf-hover)]"
            >
              <span className="font-mono text-[var(--cf-text)]">{shortKey(key)}</span>
              <span className="truncate text-[10.5px] text-[var(--cf-text-muted)]">
                · {label ?? "—"}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

/** The engine's verdict, in the user's language and pinned to the cell it is about. */
function messageFor(t: ReturnType<typeof useT>, failure: CellFailure): string {
  switch (failure.code) {
    case "notNull":
      return t("dbml.sandbox.cell.notNull");
    case "unique":
      return t("dbml.sandbox.cell.unique");
    case "type":
      return t("dbml.sandbox.cell.type", { type: failure.detail });
    case "enum":
      return t("dbml.sandbox.cell.enum", { values: failure.detail });
    case "length":
      return t("dbml.sandbox.cell.length", { max: failure.detail });
    case "foreignKey":
      return failure.detail
        ? t("dbml.sandbox.cell.foreignKeyNamed", { table: failure.detail })
        : t("dbml.sandbox.cell.foreignKey");
    default:
      return failure.detail || t("dbml.sandbox.cell.other");
  }
}
