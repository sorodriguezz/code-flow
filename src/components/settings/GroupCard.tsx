import { useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

/** A titled card that visually groups a set of settings, with an icon chip + subtitle header —
 * the same card language used elsewhere in the app (connection cards, the AI panel headers).
 * When `collapsible`, the header toggles the body open/closed (a chevron marks the state). */
export function GroupCard({
  icon: Icon,
  title,
  subtitle,
  children,
  collapsible = false,
  defaultOpen = true,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = !collapsible || open;

  const header = (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight">{title}</p>
        {subtitle && <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{subtitle}</p>}
      </div>
      {collapsible && (
        <ChevronDown
          size={16}
          className={`mt-0.5 shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "" : "-rotate-90"}`}
        />
      )}
    </>
  );

  return (
    <div className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`flex w-full items-start gap-2.5 text-left ${expanded ? "mb-4" : ""}`}
        >
          {header}
        </button>
      ) : (
        <div className="mb-4 flex items-start gap-2.5">{header}</div>
      )}
      {expanded && children}
    </div>
  );
}
