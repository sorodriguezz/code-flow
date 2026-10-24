/**
 * The parts every tool in «Herramientas» is built from, so fifty tools look and behave as one app:
 * a labelled pane with copy / paste / clear, an inline error line, option rows, key–value tables
 * and a hook that runs async transforms as you type without letting a slow answer overwrite a
 * newer one.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ClipboardPaste, Copy, Eraser } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";

export const monoArea =
  "min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] [tab-size:2]";

/** A text pane's area: `monoArea` with a floor of about four lines instead of none. */
const TEXT_PANE_AREA = monoArea.replace("min-h-0", "min-h-[5.5rem]");

export const paneClass =
  "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]";

export const labelClass = "text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

/** Writes to the clipboard and says so on the button for a moment. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <Tooltip label={label ?? t("toolbox.copy")}>
      <button
        type="button"
        disabled={!text}
        aria-label={label ?? t("toolbox.copy")}
        className={iconButtonClass({ size: "xs" })}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setDone(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setDone(false), 1200);
          });
        }}
      >
        {done ? <Check size={13} className="text-[var(--cf-success)]" /> : <Copy size={13} />}
      </button>
    </Tooltip>
  );
}

function PasteButton({ onPaste }: { onPaste: (text: string) => void }) {
  const t = useT();
  return (
    <Tooltip label={t("toolbox.paste")}>
      <button
        type="button"
        aria-label={t("toolbox.paste")}
        className={iconButtonClass({ size: "xs" })}
        onClick={() => void navigator.clipboard.readText().then(onPaste).catch(() => {})}
      >
        <ClipboardPaste size={13} />
      </button>
    </Tooltip>
  );
}

function ClearButton({ onClear, disabled }: { onClear: () => void; disabled: boolean }) {
  const t = useT();
  return (
    <Tooltip label={t("toolbox.clear")}>
      <button type="button" disabled={disabled} aria-label={t("toolbox.clear")} className={iconButtonClass({ size: "xs" })} onClick={onClear}>
        <Eraser size={13} />
      </button>
    </Tooltip>
  );
}

/** A pane's head: its label on the left, its controls on the right. */
export function PaneHead({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] pl-3 pr-1.5">
      <span className={`${labelClass} min-w-0 flex-1 truncate`}>{label}</span>
      {children}
    </div>
  );
}

/**
 * A text pane. Editable (with paste and clear) when it has `onChange`; read-only (with copy) when
 * it does not. `error` replaces nothing — it sits under the text, so the last good output and the
 * reason the new one failed are both on screen.
 */
export function TextPane({
  label,
  value,
  onChange,
  placeholder,
  error,
  extra,
  className = "",
  wrap = true,
}: {
  label: ReactNode;
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  extra?: ReactNode;
  className?: string;
  wrap?: boolean;
}) {
  // `flex-1`: in a column of panes each takes its share of the height. Without it a pane sat at its
  // content's size and the textarea, free to shrink, folded to two lines (user, 2026-10-23: «esto
  // apenas se ve», the JWT builder's payload). A floor under the textarea keeps a few lines in view
  // when the window is short; a pane meant to stay small still caps itself with `max-h-*`.
  return (
    <div className={`${paneClass} flex-1 ${className}`}>
      <PaneHead label={label}>
        {extra}
        {onChange ? (
          <>
            <PasteButton onPaste={onChange} />
            <ClearButton onClear={() => onChange("")} disabled={!value} />
          </>
        ) : null}
        <CopyButton text={value} />
      </PaneHead>
      <textarea
        className={`${TEXT_PANE_AREA} ${wrap ? "" : "whitespace-pre"}`}
        value={value}
        readOnly={!onChange}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap={wrap ? "soft" : "off"}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      />
      <ErrorLine error={error} />
    </div>
  );
}

export function ErrorLine({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="shrink-0 border-t border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] px-3 py-1.5 text-[12px] text-[var(--cf-danger)]">
      {error}
    </div>
  );
}

/** A row of options above the panes. */
export function OptionsRow({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">{children}</div>;
}

export function Labeled({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="inline-flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
      <span className="shrink-0">{label}</span>
      {children}
    </label>
  );
}

/** Two panes side by side, stacked when the window is narrow. */
export function Split({ children, rows = false }: { children: ReactNode; rows?: boolean }) {
  return (
    <div className={`grid min-h-0 flex-1 gap-3 ${rows ? "grid-rows-2" : "grid-cols-1 grid-rows-2 xl:grid-cols-2 xl:grid-rows-1"}`}>{children}</div>
  );
}

/** Label / value rows, each value copyable — results that are a set of facts rather than a text. */
export function FactTable({ rows, className = "" }: { rows: [ReactNode, string | null | undefined][]; className?: string }) {
  return (
    <div className={`${paneClass} ${className}`}>
      <div className="min-h-0 overflow-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <tbody>
            {rows
              .filter(([, v]) => v !== null && v !== undefined)
              .map(([k, v], i) => (
                <tr key={i} className="group border-b border-[var(--cf-border)] last:border-b-0">
                  <td className="w-[1%] whitespace-nowrap px-3 py-1.5 align-top text-[var(--cf-text-muted)]">{k}</td>
                  <td className="select-text break-all px-1 py-1.5 font-mono text-[var(--cf-text)]">{v}</td>
                  <td className="w-[1%] px-1.5 py-1 align-top opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <CopyButton text={v ?? ""} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The value of an async computation of `input`, recomputed as it changes. A result that arrives
 * after a newer input has been typed is dropped, so a slow decompress never overwrites a fast one.
 */
export function useAsyncResult<T>(compute: () => Promise<T> | T, deps: unknown[], delay = 120): { value: T | null; error: string | null; busy: boolean } {
  const [state, setState] = useState<{ value: T | null; error: string | null; busy: boolean }>({ value: null, error: null, busy: false });
  const run = useRef(0);
  useEffect(() => {
    const id = ++run.current;
    setState((s) => ({ ...s, busy: true }));
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(compute)
        .then(
          (value) => id === run.current && setState({ value, error: null, busy: false }),
          (err: unknown) => id === run.current && setState({ value: null, error: err instanceof Error ? err.message : String(err), busy: false }),
        );
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** Sync variant: compute during render, catching the error for the inline line. */
export function attempt<T>(compute: () => T): { value: T | null; error: string | null } {
  try {
    return { value: compute(), error: null };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export const smallInput =
  "h-[26px] min-w-0 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";
