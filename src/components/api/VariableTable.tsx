/**
 * The `ApiVariable[]` editor, shared by the environment sheet and a collection's Variables tab.
 *
 * Reveal state is deliberately internal and deliberately unkeyed to anything: a secret starts
 * masked every time this mounts, which is the whole point of marking it secret. A caller switching
 * the rows out from under it (the environment picker does) should pass a `key`, so the new list
 * arrives with its secrets hidden rather than inheriting the previous one's revealed set.
 *
 * Drawn as the app's key/value table: one hairline box, a sunken header row, and cells whose inputs
 * carry no border of their own — the row hairlines are the grid, and a cell only shows it is a field
 * once it has focus.
 */

import { useState } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import type { ApiVariable } from "../../types/api";

const GRID = "30px minmax(0,1fr) 104px minmax(0,1.3fr) minmax(0,1.3fr) minmax(0,1fr) 52px";

/** A cell's input: borderless on the row, the field fill and an inset accent ring once focused —
 *  inset because a halo would spill over the neighbouring cells and be clipped at the table edge. */
const CELL =
  "h-7 w-full min-w-0 rounded-md bg-transparent px-2.5 text-[var(--cf-text)] outline-none transition-[background-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:bg-[var(--cf-field)] focus:shadow-[inset_0_0_0_1px_var(--cf-accent)]";

function newVariableId(): string {
  return `var-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyVariable(): ApiVariable {
  return {
    id: newVariableId(),
    key: "",
    initialValue: "",
    currentValue: "",
    secret: false,
    enabled: true,
    description: "",
  };
}

export function VariableTable({
  rows,
  onChange,
  emptyLabel,
}: {
  rows: ApiVariable[];
  onChange: (next: ApiVariable[]) => void;
  /** Shown in place of the rows when there are none. */
  emptyLabel: string;
}) {
  const t = useT();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const updateRow = (id: string, patch: Partial<ApiVariable>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const toggleReveal = (id: string) =>
    setRevealed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <div className="min-w-0 overflow-hidden rounded-md border border-[var(--cf-border)]">
        <div
          className="grid h-[30px] items-center gap-1 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_60%,var(--cf-surface))] px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]"
          style={{ gridTemplateColumns: GRID }}
        >
          <span />
          <span className="truncate px-2.5">{t("api.env.variable")}</span>
          <span className="truncate px-2.5">{t("api.env.type")}</span>
          <span className="truncate px-2.5">{t("api.env.initialValue")}</span>
          <span className="truncate px-2.5">{t("api.env.currentValue")}</span>
          <span className="truncate px-2.5">{t("api.description")}</span>
          <span />
        </div>

        {rows.length === 0 && <p className="px-3 py-2.5 text-[12px] text-[var(--cf-text-muted)]">{emptyLabel}</p>}

        {rows.map((row) => {
          const masked = row.secret && !revealed.has(row.id);
          return (
            <div
              key={row.id}
              className="grid items-center gap-1 border-b border-[var(--cf-border)] px-1 py-0.5 last:border-b-0"
              style={{ gridTemplateColumns: GRID }}
            >
              <span className="flex justify-center">
                <Checkbox checked={row.enabled} onChange={(enabled) => updateRow(row.id, { enabled })} />
              </span>
              <input
                type="text"
                value={row.key}
                placeholder={t("api.key")}
                aria-label={t("api.env.variable")}
                onChange={(e) => updateRow(row.id, { key: e.target.value })}
                className={`${CELL} font-mono text-[12px]`}
              />
              <Select
                size="sm"
                value={row.secret ? "secret" : "default"}
                onChange={(type) => updateRow(row.id, { secret: type === "secret" })}
                options={[
                  { value: "default", label: t("api.env.default") },
                  { value: "secret", label: t("api.env.secret") },
                ]}
                ariaLabel={t("api.env.type")}
              />
              <input
                type={masked ? "password" : "text"}
                value={row.initialValue}
                placeholder={t("api.env.initialValue")}
                aria-label={t("api.env.initialValue")}
                onChange={(e) => updateRow(row.id, { initialValue: e.target.value })}
                className={`${CELL} font-mono text-[12px]`}
              />
              <input
                type={masked ? "password" : "text"}
                value={row.currentValue}
                placeholder={row.initialValue || t("api.env.currentValue")}
                aria-label={t("api.env.currentValue")}
                onChange={(e) => updateRow(row.id, { currentValue: e.target.value })}
                className={`${CELL} font-mono text-[12px]`}
              />
              <input
                type="text"
                value={row.description}
                placeholder={t("api.description")}
                aria-label={t("api.description")}
                onChange={(e) => updateRow(row.id, { description: e.target.value })}
                className={`${CELL} text-[12px]`}
              />
              <span className="flex items-center justify-end gap-0.5">
                {row.secret && (
                  // A toggle, so its name stays "show" and `aria-pressed` carries whether it is on;
                  // the tooltip is the one that says what the next click does.
                  <Tooltip label={masked ? t("api.env.reveal") : t("api.env.hide")}>
                    <button
                      type="button"
                      onClick={() => toggleReveal(row.id)}
                      aria-label={t("api.env.reveal")}
                      aria-pressed={!masked}
                      className={iconButtonClass({ size: "xs", active: !masked })}
                    >
                      {masked ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                  </Tooltip>
                )}
                <Tooltip label={t("api.removeRow")}>
                  <button
                    type="button"
                    onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                    aria-label={t("api.removeRow")}
                    className={iconButtonClass({ size: "xs" })}
                  >
                    <Trash2 size={13} />
                  </button>
                </Tooltip>
              </span>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => onChange([...rows, emptyVariable()])}
        className={buttonClass({ variant: "ghost", size: "sm", className: "mt-2" })}
      >
        <Plus size={13} />
        {t("api.env.addVariable")}
      </button>
    </div>
  );
}
