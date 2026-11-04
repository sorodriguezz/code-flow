/**
 * The Agents view's own controls. Small on purpose: tokens from `index.css`, motion through
 * framer-motion so `MotionLevel` can turn it off.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, Minus, Plus, X, type LucideIcon } from "lucide-react";

export const SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;
export const SOFT = { type: "spring", stiffness: 260, damping: 30 } as const;

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info" | "violet";

const TONES: Record<Tone, string> = {
  neutral: "bg-[var(--cf-sunken)] text-[var(--cf-text-muted)] border-[var(--cf-border)]",
  accent: "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] border-[var(--cf-accent-line)]",
  ok: "bg-[color-mix(in_oklab,var(--cf-success)_12%,var(--cf-surface))] text-[var(--cf-success)] border-[color-mix(in_oklab,var(--cf-success)_30%,var(--cf-surface))]",
  warn: "bg-[color-mix(in_oklab,var(--cf-warning)_12%,var(--cf-surface))] text-[var(--cf-warning)] border-[color-mix(in_oklab,var(--cf-warning)_30%,var(--cf-surface))]",
  bad: "bg-[color-mix(in_oklab,var(--cf-danger)_10%,var(--cf-surface))] text-[var(--cf-danger)] border-[color-mix(in_oklab,var(--cf-danger)_30%,var(--cf-surface))]",
  info: "bg-[color-mix(in_oklab,var(--cf-blue)_11%,var(--cf-surface))] text-[var(--cf-blue)] border-[color-mix(in_oklab,var(--cf-blue)_28%,var(--cf-surface))]",
  violet: "bg-[color-mix(in_oklab,var(--cf-violet)_11%,var(--cf-surface))] text-[var(--cf-violet)] border-[color-mix(in_oklab,var(--cf-violet)_28%,var(--cf-surface))]",
};

export function Chip({ tone = "neutral", icon: Icon, children, title, className = "" }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11.5px] font-medium ${TONES[tone]} ${className}`}>
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

export function ToggleChip({ on, onClick, icon: Icon, children, title, dot }: { on: boolean; onClick: () => void; icon?: LucideIcon; children: ReactNode; title?: string; dot?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
        on ? TONES.accent : "border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)] hover:border-[var(--cf-border-strong)] hover:text-[var(--cf-text)]"
      }`}
    >
      {dot && <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: dot }} />}
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

/** Tabs with a pill that slides to the chosen one. */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  className = "",
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: LucideIcon; badge?: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const id = useId();
  return (
    <div role="tablist" className={`relative flex min-w-0 gap-0.5 overflow-x-auto rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-sunken)] p-[3px] [scrollbar-width:none] ${className}`}>
      {options.map((option) => {
        const on = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={on}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 font-medium transition-colors ${
              size === "sm" ? "h-[24px] text-[12px]" : "h-[28px] text-[12.5px]"
            } ${on ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"}`}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={SPRING}
                className="absolute inset-0 rounded-[7px] bg-[var(--cf-surface)] shadow-[0_0_0_1px_var(--cf-border),0_1px_2px_rgba(0,0,0,0.06)]"
              />
            )}
            {Icon && <Icon className={`relative h-3.5 w-3.5 ${on ? "text-[var(--cf-accent)]" : ""}`} />}
            <span className="relative">{option.label}</span>
            {option.badge != null && <span className="relative">{option.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (value: boolean) => void; label?: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 py-1.5 text-left disabled:opacity-50"
    >
      {(label || hint) && (
        <span className="min-w-0 flex-1">
          {label && <span className="block text-[12.5px] text-[var(--cf-text)]">{label}</span>}
          {hint && <span className="block text-[11.5px] text-[var(--cf-text-muted)]">{hint}</span>}
        </span>
      )}
      <span className={`relative h-5 w-[34px] shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--cf-accent)]" : "bg-[var(--cf-border-strong)]"}`}>
        <motion.span
          layout
          transition={SPRING}
          className="absolute top-[2px] h-4 w-4 rounded-full bg-white shadow"
          style={{ left: checked ? 16 : 2 }}
        />
      </span>
    </button>
  );
}

export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (value: number) => void; label: string }) {
  return (
    <span className="inline-flex items-center overflow-hidden rounded-[8px] border border-[var(--cf-border-strong)]" aria-label={label}>
      <button type="button" aria-label="−" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} className="grid h-[26px] w-[26px] place-items-center text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] disabled:opacity-40">
        <Minus className="h-3.5 w-3.5" />
      </button>
      <b className="min-w-[30px] text-center text-[12.5px] tabular-nums">{value}</b>
      <button type="button" aria-label="+" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} className="grid h-[26px] w-[26px] place-items-center text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] disabled:opacity-40">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

export function Meter({ label, value, max, format, warnAt = 0.8 }: { label: ReactNode; value: number; max: number; format: (n: number) => string; warnAt?: number }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const color = ratio >= 1 ? "var(--cf-danger)" : ratio >= warnAt ? "var(--cf-warning)" : "var(--cf-accent)";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between gap-2 text-[12px]">
        <span className="text-[var(--cf-text-muted)]">{label}</span>
        <b className="tabular-nums">
          {format(value)}
          {max > 0 ? ` / ${format(max)}` : ""}
        </b>
      </div>
      <div className="h-2 overflow-hidden rounded-full border border-[var(--cf-border)] bg-[var(--cf-sunken)]">
        <motion.div className="h-full rounded-full" style={{ background: color }} animate={{ width: `${Math.round(ratio * 100)}%` }} transition={SOFT} />
      </div>
    </div>
  );
}

export function Panel({ title, icon: Icon, open, onToggle, children }: { title: ReactNode; icon?: LucideIcon; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="rounded-[11px] border border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12.5px] font-semibold">
        {Icon && <Icon className="h-4 w-4 text-[var(--cf-accent)]" />}
        <span className="flex-1">{title}</span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING} className="text-[var(--cf-text-faint)]">
          <ChevronRight className="h-4 w-4" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SOFT} className="overflow-hidden">
            <div className="flex flex-col gap-2.5 border-t border-[var(--cf-border)] px-3 pt-2.5 pb-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{children}</span>;
}

export function Empty({ icon: Icon, title, hint, children }: { icon: LucideIcon; title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid h-full min-h-[200px] place-items-center p-6 text-center">
      <div className="flex max-w-[420px] flex-col items-center gap-2">
        <span className="mb-1 grid h-[72px] w-[72px] place-items-center rounded-[22px] border-2 border-dashed border-[var(--cf-border-strong)] text-[var(--cf-text-faint)]">
          <Icon className="h-8 w-8" />
        </span>
        <b className="text-[13.5px]">{title}</b>
        {hint && <p className="m-0 text-[12.5px] text-[var(--cf-text-muted)]">{hint}</p>}
        {children}
      </div>
    </div>
  );
}

function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

export function Modal({
  title,
  subtitle,
  leading,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEscape(onClose);
  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-4">
      <motion.div className="absolute inset-0 bg-[color-mix(in_oklab,#0a0b10_38%,transparent)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} />
      <motion.div
        role="dialog"
        aria-modal
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SPRING}
        className={`relative flex max-h-[calc(100vh-40px)] w-full flex-col overflow-hidden rounded-[16px] border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)] ${wide ? "max-w-[980px]" : "max-w-[760px]"}`}
      >
        <div className="flex items-center gap-3 border-b border-[var(--cf-border)] px-[18px] py-4">
          {leading}
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[16px] font-semibold">{title}</h2>
            {subtitle && <p className="m-0 mt-0.5 text-[12px] text-[var(--cf-text-muted)]">{subtitle}</p>}
          </div>
          <button type="button" aria-label="Cerrar" onClick={onClose} className="grid h-[30px] w-[30px] place-items-center rounded-[8px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-auto px-[18px] py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-[var(--cf-border)] bg-[var(--cf-sunken)] px-[18px] py-3">{footer}</div>}
      </motion.div>
    </div>,
    document.body,
  );
}

export function Drawer({ onClose, children, width = 460, label }: { onClose: () => void; children: ReactNode; width?: number; label: string }) {
  useEscape(onClose);
  return createPortal(
    <div className="fixed inset-0 z-[65]">
      <motion.div className="absolute inset-0 bg-[color-mix(in_oklab,#0a0b10_28%,transparent)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} />
      <motion.aside
        role="dialog"
        aria-label={label}
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={SOFT}
        style={{ width: `min(${width}px, 100vw)` }}
        className="absolute inset-y-0 right-0 flex flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]"
      >
        {children}
      </motion.aside>
    </div>,
    document.body,
  );
}

export const btn = {
  base: "inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] border px-3 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
  primary: "border-[var(--cf-accent)] bg-[var(--cf-accent)] text-[var(--cf-on-accent)] hover:brightness-110",
  secondary: "border-[var(--cf-border-strong)] bg-[var(--cf-surface)] text-[var(--cf-text)] hover:bg-[var(--cf-hover)]",
  ghost: "border-transparent bg-transparent text-[var(--cf-text)] hover:bg-[var(--cf-hover)]",
  danger: "border-[color-mix(in_oklab,var(--cf-danger)_35%,var(--cf-surface))] bg-[var(--cf-surface)] text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_8%,var(--cf-surface))]",
  sm: "h-[26px] px-2.5 text-[12px] rounded-[7px]",
};

export function Btn({
  kind = "secondary",
  small = false,
  icon: Icon,
  children,
  className = "",
  ...rest
}: { kind?: "primary" | "secondary" | "ghost" | "danger"; small?: boolean; icon?: LucideIcon; children?: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`${btn.base} ${btn[kind]} ${small ? btn.sm : ""} ${className}`}>
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export const field =
  "h-[32px] w-full min-w-0 rounded-[8px] border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 text-[12.5px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";
