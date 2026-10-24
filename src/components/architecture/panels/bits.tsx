/** Small pieces every lens panel uses: a section's heading, a component chip that lights the card up,
 *  a field that edits the document as you type. */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { fieldClass } from "../../common/recipes";
import { DateField } from "../../common/DateField";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import type { ResolvedComponents } from "../../../lib/architecture/types";

/** The head of what the inspector is editing: its icon, its name, what it is. */
export function EntityHead({ icon, title, subtitle }: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {icon ? <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)]">{icon}</span> : null}
      <div className="grid min-w-0 gap-0.5">
        <span className="truncate text-[13px] font-semibold text-[var(--cf-text)]">{title}</span>
        {subtitle ? <span className="flex min-w-0 flex-wrap items-center gap-1 text-[11.5px] text-[var(--cf-text-faint)]">{subtitle}</span> : null}
      </div>
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mt-1 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
      <span>{children}</span>
      {aside ? <span className="text-[11px] font-normal normal-case tracking-normal">{aside}</span> : null}
    </div>
  );
}

/** A component's name as a chip; clicking it selects (and shows) the card. `plain` drops the chip's
 *  outline, for a list where every row starts with one name. */
export function Ref({ id, comps, plain = false }: { id: string; comps: ResolvedComponents; plain?: boolean }) {
  const select = useArchitectureViewStore((s) => s.select);
  return (
    <button
      type="button"
      className={plain
        ? "min-w-0 truncate text-left text-[12px] text-[var(--cf-text)] hover:text-[var(--cf-accent)]"
        : "mx-[1px] my-[1px] inline-flex h-[19px] max-w-full items-center truncate rounded-[5px] border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 text-[11.5px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"}
      onClick={() => select({ kind: "card", id }, { reveal: true })}
    >
      {comps[id]?.name ?? id}
    </button>
  );
}

export function Refs({ ids, comps }: { ids: string[]; comps: ResolvedComponents }) {
  if (!ids.length) return null;
  return <div className="flex flex-wrap gap-1">{ids.filter((id) => comps[id]).map((id) => <Ref key={id} id={id} comps={comps} />)}</div>;
}

export const panelBodyClass = "grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3";

/** A text field that commits as you type, but only re-reads its value when the selection changes. */
export function Field({ label, value, onCommit, mono, multiline, type = "text", placeholder }: { label: string; value: string; onCommit: (v: string) => void; mono?: boolean; multiline?: boolean; type?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  const common = {
    value: draft,
    placeholder,
    onFocus: () => { editing.current = true; },
    onBlur: () => { editing.current = false; },
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(e.target.value); onCommit(e.target.value); },
  };
  return (
    <label className="grid gap-1 text-[11px] font-medium text-[var(--cf-text-muted)]">
      {label}
      {type === "date" ? (
        <DateField size="sm" clearable value={draft} onChange={(v) => { setDraft(v); onCommit(v); }} ariaLabel={label} placeholder={placeholder} className="w-full" />
      ) : multiline ? (
        <textarea {...common} rows={3} className="min-h-[54px] resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12.5px] leading-[1.4] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]" />
      ) : (
        <input {...common} type={type} className={fieldClass({ size: "sm", className: `w-full ${mono ? "font-mono text-[11.5px]" : ""}` })} />
      )}
    </label>
  );
}
