import { ChevronDown, ChevronRight, ExternalLink, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { pushErrorToast } from "../../state/toastStore";
import { openExternalUrl } from "../../lib/tauri/commands";

/**
 * The small vocabulary the API settings panes are built from.
 *
 * Lifted out of `ApiSettingsModal` when collaboration grew into a pane of its own: two files
 * hand-rolling the same status dot and the same explanatory line is exactly how "connected" ends up
 * meaning one thing in one tab and something slightly different in the next.
 */

/** One tab's worth of settings. The tab above already names it, so there is no heading here. */
export function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-[var(--cf-border)] px-3 py-2">{children}</div>;
}

/** A titled block inside a panel — the backup and collaboration tabs are each several of these.
 *
 * `collapsible` is opt-in so the settings panes, where every group is meant to be read at once, keep
 * behaving as they did. It earns its keep in a narrow rail holding several groups, where the one
 * being configured is worth more room than the ones already set. */
export function Group({
  title,
  children,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const frame = "mt-3 border-t border-[var(--cf-border)] pt-2.5 first:mt-0 first:border-0 first:pt-0";
  const heading = "truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]";

  if (!collapsible) {
    return (
      <section className={frame}>
        <h4 className={`mb-1.5 ${heading}`}>{title}</h4>
        {children}
      </section>
    );
  }

  return (
    <section className={frame}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={`flex w-full items-center gap-1.5 text-left hover:text-[var(--cf-text)] ${open ? "mb-1.5" : ""}`}
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        <span className={heading}>{title}</span>
      </button>
      {open && children}
    </section>
  );
}

export type Tone = "muted" | "warning" | "success" | "accent";

const TONE_TEXT: Record<Tone, string> = {
  muted: "text-[var(--cf-text-muted)]",
  warning: "text-[var(--cf-warning)]",
  success: "text-[var(--cf-success)]",
  accent: "text-[var(--cf-accent)]",
};

const TONE_DOT: Record<Tone, string> = {
  muted: "bg-[var(--cf-text-muted)]",
  warning: "bg-[var(--cf-warning)]",
  success: "bg-[var(--cf-success)]",
  accent: "bg-[var(--cf-accent)]",
};

/**
 * An explanatory line. `warning` is reserved for the two places where the honest answer is "this
 * can lose your work" — spending it on ordinary guidance is what makes real warnings invisible.
 */
export function Note({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <p className={`mb-1.5 flex items-start gap-1.5 text-[11px] leading-snug ${TONE_TEXT[tone]}`}>
      {tone === "warning" ? (
        <TriangleAlert size={11} className="mt-[2px] shrink-0" />
      ) : (
        <Info size={11} className="mt-[2px] shrink-0" />
      )}
      <span>{children}</span>
    </p>
  );
}

/** Connected / not connected, as a dot and a sentence rather than a paragraph to parse. */
export function Status({
  tone,
  pulse = false,
  children,
}: {
  tone: Tone;
  /** For a state that is in motion — a sync round in flight, a check being re-run. */
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[11px] ${TONE_TEXT[tone]}`}>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]} ${pulse ? "animate-pulse" : ""}`}
      />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A row of buttons, spaced and wrapping the same way everywhere. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}

/**
 * Where to get the credentials the field above is asking for.
 *
 * Both integrations are bring-your-own, which means the setup happens in someone else's console
 * before this panel is any use at all. A field labelled "Client ID" with no way to find out where a
 * client id comes from is where that setup stalls.
 */
export function HelpLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(url).catch((e: unknown) => pushErrorToast(String(e)))}
      title={url}
      className="inline-flex items-center gap-1 rounded text-[11px] text-[var(--cf-accent)] hover:underline"
    >
      {children}
      <ExternalLink size={10} className="shrink-0" />
    </button>
  );
}

/** A compact, non-interactive tag — "owner", "member", "2 conflicts". */
export function Tag({ tone = "muted", icon: Icon, children }: { tone?: Tone; icon?: LucideIcon; children: ReactNode }) {
  const background = {
    muted: "bg-black/[0.05] dark:bg-white/[0.07]",
    warning: "bg-[color-mix(in_oklab,var(--cf-warning)_16%,transparent)]",
    success: "bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)]",
    accent: "bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]",
  }[tone];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-[1px] text-[10px] font-medium ${background} ${TONE_TEXT[tone]}`}
    >
      {Icon && <Icon size={9} />}
      {children}
    </span>
  );
}

/** "hace 5 s" / "5s ago" — a timestamp nobody reads, as a distance anybody does. */
export function relativeTime(iso: string, labels: { now: string; minutes: string; hours: string; days: string }): string {
  if (iso === "") return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return labels.now;
  if (seconds < 3600) return labels.minutes.replace("{n}", String(Math.round(seconds / 60)));
  if (seconds < 86_400) return labels.hours.replace("{n}", String(Math.round(seconds / 3600)));
  return labels.days.replace("{n}", String(Math.round(seconds / 86_400)));
}
