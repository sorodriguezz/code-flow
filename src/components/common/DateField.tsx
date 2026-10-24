/**
 * A date (or date and time) field with the app's own calendar, in place of `<input type="date">`.
 *
 * WebKit's native picker is a grey 2000s-era popup that ignores the theme and the app's language
 * (user, 2026-10-24: «parece web de los 90s»). The value keeps the native input's string shape —
 * `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ss` with `withTime` — so callers swap one for the other.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { useLanguageStore, useT } from "../../state/languageStore";
import { iconButtonClass } from "./Button";

const EDGE = 8;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hms = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** The value as a local Date, or null when it does not read as one. */
function parse(value: string): Date | null {
  const m = /^(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Six Monday-first weeks around `month`. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export function DateField({
  value,
  onChange,
  withTime = false,
  min,
  max,
  className = "",
  ariaLabel,
  size = "md",
  placeholder,
  clearable = false,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Hours, minutes and seconds too; the value is then `YYYY-MM-DDTHH:mm:ss`. */
  withTime?: boolean;
  /** `YYYY-MM-DD` bounds, inclusive. */
  min?: string;
  max?: string;
  className?: string;
  ariaLabel?: string;
  /** `sm` matches `fieldClass({ size: "sm" })`: 26px, 12px text. */
  size?: "sm" | "md";
  /** Shown while there is no date. */
  placeholder?: string;
  /** For optional dates: a «Quitar» in the panel sets the value to "". */
  clearable?: boolean;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const current = parse(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => current ?? new Date());
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const emit = (day: Date, time = current ?? new Date(0, 0, 1, 0, 0, 0)) => {
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.getHours(), time.getMinutes(), time.getSeconds());
    onChange(withTime ? `${ymd(d)}T${hms(d)}` : ymd(d));
  };

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = panelRef.current?.offsetWidth ?? 280;
    const height = panelRef.current?.offsetHeight ?? 340;
    const below = window.innerHeight - rect.bottom >= height + 12 || rect.top < height + 12;
    setPos({
      left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - EDGE - width)),
      top: below ? rect.bottom + 4 : undefined,
      bottom: below ? undefined : window.innerHeight - rect.top + 4,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    if (!open) setMonth(current ?? new Date());
    setOpen(!open);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const locale = language === "es" ? "es" : "en";
  const label = current
    ? current.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) + (withTime ? ` · ${hms(current)}` : "")
    : "";
  const monthName = month.toLocaleDateString(locale, { month: "long", year: "numeric" });
  // Only the first letter: CSS `capitalize` turned «octubre de 2026» into «Octubre De 2026».
  const title = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  const weekdays = monthGrid(new Date(2024, 0, 1)).slice(0, 7).map((d) => d.toLocaleDateString(locale, { weekday: "narrow" }));
  const today = ymd(new Date());
  const selected = current ? ymd(current) : "";
  const shift = (months: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + months, 1));

  const setTimePart = (part: 0 | 1 | 2, raw: string) => {
    const base = current ?? new Date();
    const parts = [base.getHours(), base.getMinutes(), base.getSeconds()];
    const n = Math.max(0, Math.min(part === 0 ? 23 : 59, Number(raw.replace(/\D/g, "")) || 0));
    parts[part] = n;
    emit(base, new Date(0, 0, 1, parts[0], parts[1], parts[2]));
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className={`inline-flex min-w-0 items-center gap-2 rounded-md border bg-[var(--cf-field)] text-left text-[var(--cf-text)] ${size === "sm" ? "h-[26px] px-2 text-[12px]" : "h-[30px] px-2.5 text-[13px]"} outline-none transition-[border-color,box-shadow] duration-100 ${
          open
            ? "border-[var(--cf-accent)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
            : "border-[var(--cf-field-border)] hover:border-[var(--cf-border-strong)] focus-visible:border-[var(--cf-accent)] focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
        } ${className}`}
      >
        <Calendar size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className={`truncate tabular-nums ${current ? "" : "text-[var(--cf-text-faint)]"}`}>{label || placeholder || "—"}</span>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={ariaLabel}
              onKeyDown={onKeyDown}
              style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom }}
              className="z-[9999] w-[264px] select-none rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-shadow)]"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="pl-1 text-[13px] font-semibold text-[var(--cf-text)]">{title}</span>
                <div className="flex items-center gap-0.5">
                  <button type="button" className={iconButtonClass({ size: "xs" })} aria-label={t("dateField.prevMonth")} onClick={() => shift(-1)}>
                    <ChevronLeft size={14} />
                  </button>
                  <button type="button" className={iconButtonClass({ size: "xs" })} aria-label={t("dateField.nextMonth")} onClick={() => shift(1)}>
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center">
                {weekdays.map((w, i) => (
                  <span key={i} className="pb-1 text-[10.5px] font-medium uppercase text-[var(--cf-text-faint)]">
                    {w}
                  </span>
                ))}
                {monthGrid(month).map((d) => {
                  const key = ymd(d);
                  const inMonth = d.getMonth() === month.getMonth();
                  const disabled = (min && key < min) || (max && key > max);
                  const isSelected = key === selected;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={!!disabled}
                      onClick={() => {
                        emit(d);
                        if (!withTime) {
                          setOpen(false);
                          triggerRef.current?.focus();
                        }
                      }}
                      className={`h-8 rounded-md text-[12.5px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                        isSelected
                          ? "bg-[var(--cf-accent)] font-semibold text-[var(--cf-on-accent,#fff)]"
                          : `${inMonth ? "text-[var(--cf-text)]" : "text-[var(--cf-text-faint)]"} hover:bg-[var(--cf-hover)] ${
                              key === today ? "font-semibold text-[var(--cf-accent)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--cf-accent)_45%,transparent)]" : ""
                            }`
                      }`}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--cf-border)] pt-2">
                {withTime ? (
                  <div className="flex items-center gap-0.5 font-mono text-[12.5px] text-[var(--cf-text-muted)]">
                    {([0, 1, 2] as const).map((part) => (
                      <span key={part} className="flex items-center">
                        {part ? ":" : null}
                        <input
                          aria-label={t(part === 0 ? "dateField.hours" : part === 1 ? "dateField.minutes" : "dateField.seconds")}
                          inputMode="numeric"
                          maxLength={2}
                          className="h-7 w-8 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] text-center text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
                          value={current ? pad([current.getHours(), current.getMinutes(), current.getSeconds()][part]) : "00"}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => setTimePart(part, e.target.value.slice(-2))}
                        />
                      </span>
                    ))}
                  </div>
                ) : clearable && current ? (
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                    onClick={() => {
                      onChange("");
                      setOpen(false);
                    }}
                  >
                    {t("dateField.clear")}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[12px] font-medium text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
                  onClick={() => {
                    const now = new Date();
                    setMonth(now);
                    emit(now, now);
                    if (!withTime) setOpen(false);
                  }}
                >
                  {t(withTime ? "dateField.now" : "dateField.today")}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
