import { useRef, useState } from "react";
import { FileUp, Trash2 } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { VariableInput } from "./VariableInput";
import { apiPickFile } from "../../lib/tauri/apiCommands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { emptyKeyValue, type KeyValue } from "../../types/api";
import type { VariableContext } from "../../lib/api/variables";

/**
 * The editable table behind Params, Path Variables, Headers, form-data and urlencoded.
 *
 * Two behaviours are load-bearing and easy to get subtly wrong:
 *
 * - **The trailing blank row is not an "Add" button.** It is always there, and the first keystroke
 *   turns it into a real row *keeping its id*, so React re-uses the same DOM node and the caret
 *   stays in the field being typed into. Rendering the rows and the blank as two sibling slots
 *   instead of one keyed array is what breaks this: React then unmounts the blank and mounts a
 *   fresh row, and the character lands in a field that no longer has focus.
 * - **Rows are keyed by `KeyValue.id`, never by index.** Deleting row 2 of 5 by index is how these
 *   tables silently move the user's typing into the wrong row.
 */

/**
 * A cell's text field. The cell *is* the field, so it has no border or fill of its own: a 32px row
 * (a 20px line and 6px either side) with an accent hairline inside the cell while it has focus.
 * `VariableInput` applies this to its mirror as well as its input, which is harmless — the `focus:`
 * part can only ever match the input.
 */
const CELL =
  "w-full rounded-[4px] bg-transparent px-2.5 py-1.5 text-[12px] leading-5 outline-none transition-shadow duration-100 placeholder:text-[var(--cf-text-faint)] focus:shadow-[inset_0_0_0_1px_var(--cf-accent)]";
/** Keys and values are what goes on the wire, so they are set in the code face. */
const CODE_CELL = `${CELL} font-mono`;

function newRowId(): string {
  return `kv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** `key:value` per line, `//` prefix for a disabled row — the format Postman's bulk edit uses. */
function toBulkText(rows: KeyValue[]): string {
  return rows.map((row) => `${row.enabled ? "" : "//"}${row.key}:${row.value}`).join("\n");
}

/**
 * Parses the bulk text back into rows, reusing `base` positionally.
 *
 * The reuse is the whole point: descriptions, file parts and row ids have no representation in
 * `key:value` text, so a round trip through bulk edit would drop them if every line produced a
 * brand-new row. Matching by position is what Postman does and what keeps an edit to line 3 from
 * clearing line 3's description.
 */
function fromBulkText(text: string, base: KeyValue[]): KeyValue[] {
  const pool = [...base];
  const rows: KeyValue[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const disabled = line.startsWith("//");
    const body = disabled ? line.slice(2) : line;
    const colon = body.indexOf(":");
    const key = (colon < 0 ? body : body.slice(0, colon)).trim();
    const rawValue = colon < 0 ? "" : body.slice(colon + 1);
    // One optional space after the colon is formatting, not part of the value.
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    const previous = pool.shift();
    const seed = previous ?? emptyKeyValue(newRowId());
    rows.push({ ...seed, key, value, enabled: !disabled });
  }
  return rows;
}

export interface KeyValueTableProps {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  /** Adds the form-data "Text / File" type column and file picker. */
  fileRows?: boolean;
  /** Renders rows as read-only greyed "hidden" headers with an enable toggle. */
  readOnlyKeys?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Highlights {{vars}} that don't resolve in the current context. */
  variableContext?: VariableContext | null;
  /** Shows the Bulk Edit toggle. */
  allowBulkEdit?: boolean;
}

export function KeyValueTable({
  rows,
  onChange,
  fileRows = false,
  readOnlyKeys = false,
  keyPlaceholder,
  valuePlaceholder,
  variableContext = null,
  allowBulkEdit = false,
}: KeyValueTableProps) {
  const t = useT();
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  /** The rows as they stood when bulk edit opened — the pool `fromBulkText` reuses ids from. */
  const bulkBase = useRef<KeyValue[]>([]);
  const [draft, setDraft] = useState<KeyValue>(() => emptyKeyValue(newRowId()));

  const columns = readOnlyKeys
    ? "30px minmax(0,1fr) minmax(0,1.4fr) minmax(0,1fr)"
    : fileRows
      ? "30px minmax(0,1fr) 88px minmax(0,1.4fr) minmax(0,1fr) 30px"
      : "30px minmax(0,1fr) minmax(0,1.4fr) minmax(0,1fr) 30px";

  const patch = (row: KeyValue, isDraft: boolean, changes: Partial<KeyValue>) => {
    const next = { ...row, ...changes };
    if (isDraft) {
      onChange([...rows, next]);
      setDraft(emptyKeyValue(newRowId()));
      return;
    }
    onChange(rows.map((item) => (item.id === row.id ? next : item)));
  };

  const remove = (id: string) => onChange(rows.filter((item) => item.id !== id));

  const openBulk = () => {
    bulkBase.current = rows;
    setBulkText(toBulkText(rows));
    setBulk(true);
  };

  const pickFile = async (row: KeyValue, isDraft: boolean) => {
    try {
      const path = await apiPickFile([]);
      if (path) patch(row, isDraft, { src: path, type: "file" });
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  if (bulk) {
    return (
      <div className="flex min-h-0 flex-col gap-1.5">
        <div className="flex justify-end">
          <button type="button" onClick={() => setBulk(false)} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("api.keyValueEdit")}
          </button>
        </div>
        <textarea
          value={bulkText}
          spellCheck={false}
          // Parsed on every keystroke rather than only on toggle, so a Send while bulk edit is
          // still open uses what is on screen instead of the rows it was opened with.
          onChange={(e) => {
            setBulkText(e.target.value);
            onChange(fromBulkText(e.target.value, bulkBase.current));
          }}
          className="min-h-[160px] w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 font-mono text-[12px] leading-5 text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
        />
      </div>
    );
  }

  const displayed: { row: KeyValue; isDraft: boolean }[] = rows.map((row) => ({ row, isDraft: false }));
  if (!readOnlyKeys) displayed.push({ row: draft, isDraft: true });

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {allowBulkEdit && (
        <div className="flex justify-end">
          <button type="button" onClick={openBulk} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("api.bulkEdit")}
          </button>
        </div>
      )}

      <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--cf-border)]">
        <div
          style={{ gridTemplateColumns: columns }}
          className="grid h-[30px] items-center border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_60%,var(--cf-surface))] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]"
        >
          <span />
          <span className="truncate px-2.5">{t("api.key")}</span>
          {fileRows && !readOnlyKeys && <span className="truncate px-2.5">{t("api.env.type")}</span>}
          <span className="truncate px-2.5">{t("api.value")}</span>
          <span className="truncate px-2.5">{t("api.description")}</span>
          {!readOnlyKeys && <span />}
        </div>

        {displayed.map(({ row, isDraft }) => {
          const isFile = fileRows && row.type === "file";
          return (
            <div
              key={row.id}
              style={{ gridTemplateColumns: columns }}
              className="grid min-h-8 items-center border-b border-[var(--cf-border)] transition-colors duration-100 last:border-b-0 hover:bg-[var(--cf-hover)]"
            >
              <span className="flex justify-center">
                <Checkbox
                  checked={readOnlyKeys ? true : row.enabled && !isDraft}
                  // The blank row has nothing to enable yet, and the auto-generated headers are
                  // supplied by the transport — neither is the user's to toggle.
                  disabled={isDraft || readOnlyKeys}
                  onChange={(enabled) => patch(row, isDraft, { enabled })}
                />
              </span>

              {readOnlyKeys ? (
                <span className="truncate px-2.5 font-mono text-[12px] leading-5 text-[var(--cf-text-muted)]">
                  {row.key}
                </span>
              ) : (
                <VariableInput
                  value={row.key}
                  onChange={(key) => patch(row, isDraft, { key })}
                  variableContext={variableContext}
                  placeholder={keyPlaceholder ?? t("api.key")}
                  ariaLabel={t("api.key")}
                  fieldClassName={CODE_CELL}
                />
              )}

              {fileRows && !readOnlyKeys && (
                // Wrapped rather than given a margin: `Select`'s trigger is `w-full`, so a margin on
                // it pushed the trigger past the edge of its column.
                <span className="flex min-w-0 px-0.5">
                  <Select
                    size="sm"
                    value={row.type === "file" ? "file" : "text"}
                    onChange={(value) =>
                      patch(row, isDraft, { type: value === "file" ? "file" : "text" })
                    }
                    options={[
                      { value: "text", label: t("api.body.text") },
                      { value: "file", label: t("api.body.file") },
                    ]}
                    ariaLabel={t("api.env.type")}
                    className="border-transparent"
                  />
                </span>
              )}

              {readOnlyKeys ? (
                <span className="truncate px-2.5 font-mono text-[12px] leading-5 text-[var(--cf-text-muted)]">
                  {row.value}
                </span>
              ) : isFile ? (
                <button
                  type="button"
                  onClick={() => void pickFile(row, isDraft)}
                  title={row.src || t("api.body.chooseFile")}
                  className="mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-[var(--cf-text)] transition-colors duration-100 hover:bg-[var(--cf-hover)]"
                >
                  <FileUp size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span className={`truncate ${row.src ? "font-mono" : "text-[var(--cf-text-faint)]"}`}>
                    {row.src ? baseName(row.src) : t("api.body.chooseFile")}
                  </span>
                </button>
              ) : (
                <VariableInput
                  value={row.value}
                  onChange={(value) => patch(row, isDraft, { value })}
                  variableContext={variableContext}
                  placeholder={valuePlaceholder ?? t("api.value")}
                  ariaLabel={t("api.value")}
                  fieldClassName={CODE_CELL}
                />
              )}

              {readOnlyKeys ? (
                <span />
              ) : (
                <input
                  type="text"
                  value={row.description}
                  spellCheck={false}
                  placeholder={t("api.description")}
                  aria-label={t("api.description")}
                  onChange={(e) => patch(row, isDraft, { description: e.target.value })}
                  className={`${CELL} text-[var(--cf-text)]`}
                />
              )}

              {!readOnlyKeys && (
                <span className="flex justify-center">
                  {!isDraft && (
                    <Tooltip label={t("api.removeRow")}>
                      <button
                        type="button"
                        onClick={() => remove(row.id)}
                        aria-label={t("api.removeRow")}
                        className={iconButtonClass({ size: "xs" })}
                      >
                        <Trash2 size={13} />
                      </button>
                    </Tooltip>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
