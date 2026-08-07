/**
 * The `ApiVariable[]` editor, shared by the environment sheet and a collection's Variables tab.
 *
 * Reveal state is deliberately internal and deliberately unkeyed to anything: a secret starts
 * masked every time this mounts, which is the whole point of marking it secret. A caller switching
 * the rows out from under it (the environment picker does) should pass a `key`, so the new list
 * arrives with its secrets hidden rather than inheriting the previous one's revealed set.
 */

import { useState } from "react";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field } from "./ApiModal";
import { useT } from "../../state/languageStore";
import type { ApiVariable } from "../../types/api";

const GRID = "24px minmax(0,1fr) 96px minmax(0,1.3fr) minmax(0,1.3fr) minmax(0,1fr) 46px";

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
      <div
        className="grid items-center gap-2 border-b border-[var(--cf-border)] pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]"
        style={{ gridTemplateColumns: GRID }}
      >
        <span />
        <span>{t("api.env.variable")}</span>
        <span>{t("api.env.type")}</span>
        <span>{t("api.env.initialValue")}</span>
        <span>{t("api.env.currentValue")}</span>
        <span>{t("api.description")}</span>
        <span />
      </div>

      {rows.length === 0 && <p className="py-4 text-[12px] text-[var(--cf-text-muted)]">{emptyLabel}</p>}

      {rows.map((row) => {
        const masked = row.secret && !revealed.has(row.id);
        return (
          <div
            key={row.id}
            className="grid items-center gap-2 border-b border-[var(--cf-border)] py-1"
            style={{ gridTemplateColumns: GRID }}
          >
            <Checkbox checked={row.enabled} onChange={(enabled) => updateRow(row.id, { enabled })} />
            <Field
              mono
              value={row.key}
              placeholder={t("api.key")}
              onChange={(key) => updateRow(row.id, { key })}
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
            <Field
              mono
              type={masked ? "password" : "text"}
              value={row.initialValue}
              placeholder={t("api.env.initialValue")}
              onChange={(initialValue) => updateRow(row.id, { initialValue })}
            />
            <Field
              mono
              type={masked ? "password" : "text"}
              value={row.currentValue}
              placeholder={row.initialValue || t("api.env.currentValue")}
              onChange={(currentValue) => updateRow(row.id, { currentValue })}
            />
            <Field
              value={row.description}
              placeholder={t("api.description")}
              onChange={(description) => updateRow(row.id, { description })}
            />
            <span className="flex items-center justify-end gap-0.5">
              {row.secret && (
                <button
                  onClick={() => toggleReveal(row.id)}
                  title={masked ? t("api.env.reveal") : t("api.env.hide")}
                  className="rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                >
                  {masked ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
              )}
              <button
                onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                title={t("api.removeRow")}
                className="rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <X size={12} />
              </button>
            </span>
          </div>
        );
      })}

      <button
        onClick={() => onChange([...rows, emptyVariable()])}
        className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
      >
        <Plus size={12} />
        {t("api.env.addVariable")}
      </button>
    </div>
  );
}
