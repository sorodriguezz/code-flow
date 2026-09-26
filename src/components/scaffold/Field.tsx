import type { ReactNode } from "react";

/**
 * One row of the initializer's form: the label in a fixed column, the control beside it, and what is
 * wrong with it underneath. Fixed rather than auto-sized so the controls of every template start on
 * the same line, which is what makes switching templates read as the same form with different rows.
 */
export function Field({
  label,
  children,
  hint,
  error,
  align = "center",
}: {
  label: ReactNode;
  children: ReactNode;
  /** A quiet line under the control — the full path a name resolves to. */
  hint?: ReactNode;
  error?: string | null;
  /** `start` for a control taller than one line (the dependency picker). */
  align?: "center" | "start";
}) {
  return (
    <div className={`grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 ${align === "start" ? "items-start" : "items-center"}`}>
      <span className={`truncate text-[12px] text-[var(--cf-text-muted)] ${align === "start" ? "pt-1" : ""}`}>{label}</span>
      <div className="min-w-0">{children}</div>
      {(error || hint) && (
        <>
          <span />
          <p
            className={`mt-1 min-w-0 truncate text-[11px] ${error ? "text-[var(--cf-danger)]" : "font-mono text-[var(--cf-text-faint)]"}`}
            title={typeof hint === "string" ? hint : undefined}
          >
            {error || hint}
          </p>
        </>
      )}
    </div>
  );
}
