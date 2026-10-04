import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { useT } from "../../state/languageStore";

/**
 * The pieces the node form's list editors share — a list of rows with a remove button each and an
 * "add" at the end, and the readers that turn a stored parameter into rows and text.
 */

export function Rows<T>({
  rows,
  onChange,
  blank,
  render,
  addLabel,
}: {
  rows: T[];
  onChange: (rows: T[]) => void;
  blank: () => T;
  render: (row: T, update: (next: T) => void) => ReactNode;
  addLabel: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, index) => (
        <div key={index} className="flex min-w-0 items-start gap-1.5">
          <div className="flex min-w-0 flex-1 gap-1.5">{render(row, (next) => onChange(rows.map((r, i) => (i === index ? next : r))))}</div>
          <button
            type="button"
            className={iconButtonClass({ size: "xs", className: "mt-[2px]" })}
            title={t("flows.param.removeRow")}
            aria-label={t("flows.param.removeRow")}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="inline-flex h-6 w-fit items-center gap-1 rounded-md px-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        onClick={() => onChange([...rows, blank()])}
      >
        <Plus size={12} />
        {addLabel}
      </button>
    </div>
  );
}

export type Row = Record<string, unknown>;
export const str = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value));
export const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Row[]) : []);

