import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { useSwapFade } from "../../lib/useSwapFade";

/**
 * A settings card that starts folded: its header says what it is and what is chosen in it, and the
 * explanation and the controls come out on a click. For a card whose contents are a list as long as
 * the page it sits on — «Conexión con el agente» and «Scripts de CodeFlow» pushed the engines under
 * them a screen down. Drawn like the engine rows below them, so the column reads as one list.
 */
export function SettingsFold({
  icon: Icon,
  title,
  summary,
  tone = "muted",
  defaultOpen = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  /** What is chosen inside, in a line — shown while folded, where the controls cannot say it. */
  summary?: string;
  tone?: "muted" | "warning";
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  useSwapFade(bodyRef, open);

  return (
    <section className={`rounded-lg border border-[var(--cf-border)] transition-colors duration-100 ${open ? "" : "hover:border-[var(--cf-border-strong)]"}`}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen((was) => !was)}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left"
        >
          <ChevronDown size={14} aria-hidden className={`shrink-0 text-[var(--cf-text-faint)] transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)] text-[var(--cf-accent)]">
            <Icon size={12} aria-hidden />
          </span>
          <span className="shrink-0 text-[13px] font-medium text-[var(--cf-text)]">{title}</span>
          {!open && summary && (
            <span className={`min-w-0 truncate text-[12px] ${tone === "warning" ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"}`}>{summary}</span>
          )}
        </button>
      </h3>
      <div ref={bodyRef} id={body}>
        {open && <div className="space-y-2 border-t border-[var(--cf-border)] p-3">{children}</div>}
      </div>
    </section>
  );
}
