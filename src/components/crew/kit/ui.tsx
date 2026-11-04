/**
 * The Agents view's own controls. Small on purpose: tokens from `index.css`, motion through
 * framer-motion so `MotionLevel` can turn it off.
 */
import { Children, createContext, Fragment, isValidElement, useContext, useEffect, useId, useRef, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, Minus, Plus, X, type LucideIcon } from "lucide-react";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { ActivePill } from "../../common/ActivePill";
import { chipClass, fieldClass, segItemClass, segTrackClass, type ChipTone } from "../../common/recipes";
import { Select, type SelectOption } from "../../common/Select";

/** The Agents view's own box. A drawer opens inside it, so the app rail, the AI panels and the
 * rest of the window stay where they are — the same way every other app's side panel does. */
export const CrewHost = createContext<HTMLElement | null>(null);

export const SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;
export const SOFT = { type: "spring", stiffness: 260, damping: 30 } as const;

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info" | "violet";

// The app's chip (`chipClass`); violet is this view's extra tone, for reasoning effort.
const VIOLET = "bg-[color-mix(in_oklab,var(--cf-violet)_13%,transparent)] text-[var(--cf-violet)]";

function chip(tone: Tone, className = ""): string {
  return tone === "violet" ? chipClass("neutral", `${className} !shadow-none ${VIOLET}`) : chipClass(tone as ChipTone, className);
}

export function Chip({ tone = "neutral", icon: Icon, children, title, className = "" }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={chip(tone, className)}>
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

/** A chip that toggles: repositories, models, filters. Off it is a quiet outline; on, the accent. */
export function ToggleChip({ on, onClick, icon: Icon, children, title, dot }: { on: boolean; onClick: () => void; icon?: LucideIcon; children: ReactNode; title?: string; dot?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] font-medium transition-colors duration-100 ${
        on
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]"
          : "text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      }`}
    >
      {dot && <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: dot }} />}
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

/** Tabs with a pill that slides to the chosen one — the app's segmented recipe, with room for a
 * badge. */
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
    <div role="tablist" className={segTrackClass({ className: `min-w-0 overflow-x-auto [scrollbar-width:none] ${className}` })}>
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
            className={segItemClass(on, { size, className: "shrink-0" })}
          >
            {on && <ActivePill layoutId={`seg-${id}`} variant="raised" />}
            <span className="relative inline-flex items-center gap-1.5">
              {Icon && <Icon size={size === "sm" ? 12 : 13} className="shrink-0" />}
              {option.label}
              {option.badge != null && option.badge}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint, disabled, title }: { checked: boolean; onChange: (value: boolean) => void; label?: ReactNode; hint?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={title}
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
    <span className="inline-flex items-center overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--cf-border-strong)]" aria-label={label} title={label}>
      <button type="button" aria-label="−" title={`${label}: −1`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} className="grid h-[26px] w-[26px] place-items-center text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] disabled:opacity-40">
        <Minus className="h-3.5 w-3.5" />
      </button>
      <b className="min-w-[30px] text-center text-[12.5px] tabular-nums">{value}</b>
      <button type="button" aria-label="+" title={`${label}: +1`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} className="grid h-[26px] w-[26px] place-items-center text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] disabled:opacity-40">
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
      <button type="button" onClick={onToggle} aria-expanded={open} title={open ? "Plegar" : "Desplegar"} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12.5px] font-semibold">
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
          <button type="button" aria-label="Cerrar" title="Cerrar (Esc)" onClick={onClose} className={iconButtonClass({ size: "md" })}>
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
  const host = useContext(CrewHost);
  return createPortal(
    <div className={`${host ? "absolute" : "fixed"} inset-0 z-[65] overflow-hidden`}>
      <motion.div className="absolute inset-0 bg-[color-mix(in_oklab,#0a0b10_18%,transparent)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} />
      <motion.aside
        role="dialog"
        aria-label={label}
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={SOFT}
        style={{ width: `min(${width}px, 100%)` }}
        className="absolute inset-y-0 right-0 flex flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]"
      >
        {children}
      </motion.aside>
    </div>,
    host ?? document.body,
  );
}

/** The app's button recipe (`common/Button`), under the names this view already uses. */
export function Btn({
  kind = "secondary",
  small = false,
  icon: Icon,
  children,
  className = "",
  ...rest
}: { kind?: "primary" | "secondary" | "ghost" | "danger"; small?: boolean; icon?: LucideIcon; children?: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={buttonClass({ variant: kind === "danger" ? "danger-ghost" : kind, size: small ? "sm" : "md", className })}>
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

/** An icon-only button with the app's hover and its tooltip. */
export function IconBtn({ title, onClick, icon: Icon, danger, className = "" }: { title: string; onClick: () => void; icon: LucideIcon; danger?: boolean; className?: string }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={iconButtonClass({ size: "sm", className: `${danger ? "hover:text-[var(--cf-danger)]" : ""} ${className}` })}>
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/** The app's text field (`fieldClass`), full width; size a field from a wrapper, not here. */
export const field = fieldClass({ className: "w-full" });

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function optionsOf(children: ReactNode, out: SelectOption[] = []): SelectOption[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string; disabled?: boolean; children?: ReactNode }>;
    if (el.type === Fragment) optionsOf(el.props.children, out);
    else if (el.type === "option") out.push({ value: String(el.props.value ?? ""), label: textOf(el.props.children), disabled: el.props.disabled });
  });
  return out;
}

/**
 * The app's `Select`, written like a native one — `<option>` children — so the forms here read the
 * same as before. `className` sizes the wrapper (the trigger always fills it).
 */
export function SelectBox({ value, onChange, children, className = "w-full", compact = false, ariaLabel, title }: { value: string; onChange: (value: string) => void; children: ReactNode; className?: string; compact?: boolean; ariaLabel?: string; title?: string }) {
  return (
    <div className={`min-w-0 ${className}`} title={title}>
      <Select value={value} onChange={onChange} options={optionsOf(children)} size={compact ? "compact" : "field"} ariaLabel={ariaLabel} />
    </div>
  );
}
