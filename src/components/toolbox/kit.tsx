/**
 * The parts every tool in «Herramientas» is built from, so fifty tools look and behave as one app:
 * a labelled pane with copy / paste / clear, an inline error line, option rows, key–value tables
 * and a hook that runs async transforms as you type without letting a slow answer overwrite a
 * newer one.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ClipboardPaste, Copy, Eraser, Forward } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { popoverClass } from "../common/recipes";
import { useDismiss } from "../ai/docParts";
import { useT } from "../../state/languageStore";
import { useToolboxStore } from "../../state/toolboxStore";
import { clipboardReadText } from "../../lib/tauri/commands";
import { writeClipboardText } from "../../lib/clipboard";
import { pushErrorToast } from "../../state/toastStore";
import { searchTools, TOOL_INPUT, toolById } from "../../lib/toolbox/catalog";
import { detectTools } from "../../lib/toolbox/detect";

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
        // Through `writeClipboardText`, which falls back to the native clipboard when WebKit refuses
        // the write — and says so when both fail, instead of a button that silently did nothing.
        onClick={() => {
          void writeClipboardText(text).then(
            () => {
              setDone(true);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setDone(false), 1200);
            },
            (e: unknown) => pushErrorToast(`${t("toolbox.copyFailed")}: ${String(e)}`),
          );
        }}
      >
        {done ? <Check size={13} className="text-[var(--cf-success)]" /> : <Copy size={13} />}
      </button>
    </Tooltip>
  );
}

/**
 * Read natively, not through `navigator.clipboard.readText()`: on macOS WebKit answers that read
 * with its own «Paste» bubble beside the pointer, a second tooltip over the button's, and pastes
 * only once that is clicked too (user report, 2026-11-23). The native read has no such step.
 */
function PasteButton({ onPaste }: { onPaste: (text: string) => void }) {
  const t = useT();
  return (
    <Tooltip label={t("toolbox.paste")}>
      <button
        type="button"
        aria-label={t("toolbox.paste")}
        className={iconButtonClass({ size: "xs" })}
        onClick={() => void clipboardReadText().then(onPaste).catch(() => {})}
      >
        <ClipboardPaste size={13} />
      </button>
    </Tooltip>
  );
}

/**
 * «Enviar a…»: an output becomes the input of another tool — Base64 decoded into the JSON formatter,
 * a URL into its parser — without a copy and a paste between them. The tools that recognise the
 * text come first; the rest are a type-to-filter list.
 */
function SendToButton({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const current = useToolboxStore((s) => s.activeId);
  const options = useMemo(() => {
    if (!open) return [];
    const suggested = detectTools(text).map((d) => d.tool);
    const all = searchTools(filter, (tool) => t(tool.titleKey)).filter((tool) => TOOL_INPUT[tool.id] && tool.id !== current);
    return [...all.filter((tool) => suggested.includes(tool.id)), ...all.filter((tool) => !suggested.includes(tool.id))].map((tool) => ({
      tool,
      suggested: suggested.includes(tool.id),
    }));
  }, [open, text, filter, current, t]);
  const send = (id: string) => {
    setOpen(false);
    // The target's direction is left as it was: sent text is as often to encode as to decode.
    useToolboxStore.getState().sendTo(id, text, detectTools(text).find((d) => d.tool === id)?.extra);
  };
  return (
    <div ref={ref} className="relative">
      <Tooltip label={t("toolbox.sendTo")}>
        <button
          type="button"
          disabled={!text}
          aria-label={t("toolbox.sendTo")}
          aria-haspopup="menu"
          aria-expanded={open}
          className={iconButtonClass({ size: "xs" })}
          onClick={() => {
            setFilter("");
            setOpen((v) => !v);
          }}
        >
          <Forward size={13} />
        </button>
      </Tooltip>
      {open && (
        <div role="menu" className={`absolute right-0 top-full z-40 mt-1 w-64 ${popoverClass}`}>
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && options[0]) send(options[0].tool.id);
            }}
            placeholder={t("toolbox.search")}
            spellCheck={false}
            className="mb-1 h-7 w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
          />
          <div className="max-h-64 overflow-y-auto">
            {options.map(({ tool, suggested }) => {
              const Icon = toolById(tool.id)?.icon ?? Forward;
              return (
                <button
                  key={tool.id}
                  type="button"
                  role="menuitem"
                  onClick={() => send(tool.id)}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
                >
                  <Icon size={13} className={`shrink-0 ${suggested ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"}`} />
                  <span className="min-w-0 flex-1 truncate">{t(tool.titleKey)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
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
        ) : (
          <SendToButton text={value} />
        )}
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
