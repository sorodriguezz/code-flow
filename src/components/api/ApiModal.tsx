import { useEffect, useRef, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { useT } from "../../state/languageStore";

/**
 * The chrome every API-client modal wears: backdrop, centred panel, titled header with a close
 * button, scrolling body and an optional footer bar.
 *
 * It's the same structure `CloneRepoModal`/`ShortcutsModal`/`SecretScanModal` hand-roll, lifted
 * into one place only because six of these ship at once — six copies of the same escape-key effect
 * is where a hand-rolled backdrop stops being house style and starts being a maintenance bill.
 *
 * `busy` locks the exits: a modal in the middle of an import or a collection run must not be
 * dismissed by a stray backdrop click, because the work would carry on with nothing to show it.
 *
 * `dismissOnBackdrop` locks the same exit for a different reason: a modal whose body is a form the
 * user has been typing into has nothing to recover from a mis-click, so the ones that hold unsaved
 * input turn it off and keep the close button, Cancel and Escape as the only ways out.
 */
export function ApiModal({
  icon: Icon,
  title,
  subtitle,
  width = "max-w-lg",
  height,
  busy = false,
  dismissOnBackdrop = true,
  onClose,
  toolbar,
  footer,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** Tailwind max-width class for the panel. */
  width?: string;
  /** Tailwind height class; the panel is capped at 80vh either way. */
  height?: string;
  busy?: boolean;
  /** Whether a click on the backdrop closes the modal. Off for forms holding unsaved input. */
  dismissOnBackdrop?: boolean;
  onClose: () => void;
  /** Rendered at the right of the header, before the close button. */
  toolbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  /** Whether the press that produced the current click started on the backdrop. */
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    if (busy) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (busy || !dismissOnBackdrop) return;
        // Both ends of the click have to be the backdrop itself. A press that starts inside the
        // panel — selecting the text of a field, dragging past the edge — releases outside it and
        // still delivers a click here, on the nearest common ancestor, and that is not "clicked
        // away". The same check is what keeps clicks inside the panel from closing it, so the panel
        // needs no `stopPropagation` of its own.
        if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)] ${width} ${height ?? ""}`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <Icon size={14} className="shrink-0 text-[var(--cf-accent)]" />
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold">{title}</h2>
            {subtitle && (
              <p className="truncate text-[11px] text-[var(--cf-text-muted)]">{subtitle}</p>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {toolbar}
            {!busy && (
              <button
                onClick={onClose}
                title={t("common.close")}
                aria-label={t("common.close")}
                className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

        {footer && (
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** The two button shapes these modals use, so a primary action looks the same in all six. */
export function PrimaryButton({
  onClick,
  disabled,
  danger = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40 ${
        danger ? "bg-[var(--cf-danger)]" : "bg-[var(--cf-accent)]"
      }`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}

/** Every text/number input in these modals; keeps the border + focus ring identical. */
export function Field({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  mono = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "number";
  disabled?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50 ${
        mono ? "font-mono" : ""
      } ${className}`}
    />
  );
}

/**
 * Label + control on one row, the density the settings panes use.
 *
 * `wide` roughly doubles the control column, for the fields whose value is a URL, a filesystem
 * path or a key: at the default width those show a dozen characters and a truncation, which is
 * exactly the wrong end of a value you are trying to check.
 */
export function Row({
  label,
  hint,
  wide = false,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-3 py-1">
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-[var(--cf-text)]">{label}</span>
        {hint && <span className="block text-[11px] text-[var(--cf-text-muted)]">{hint}</span>}
      </span>
      <span className={`flex shrink-0 justify-end ${wide ? "w-[360px] max-w-[62%]" : "w-[180px]"}`}>
        {children}
      </span>
    </label>
  );
}
