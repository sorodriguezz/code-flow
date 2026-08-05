import { Apple, AppWindow, HardDrive, Server, type LucideIcon } from "lucide-react";
import type { RemoteOs } from "../../types/remote";

/**
 * The Remote workspace's shared visual vocabulary, the counterpart of `dbChrome`.
 *
 * Same job and same reasoning: an operating system gets *one* glyph and *one* colour, defined here,
 * so a host reads the same in the tree, in a tab and in the status bar. Three files each picking
 * their own is how those three drift apart.
 */

/** The panel fill, matching the database workspace's so the two views read as one app. */
export const CARD = "bg-[var(--cf-surface)]";

export function osIcon(os: RemoteOs): LucideIcon {
  switch (os) {
    case "macos":
      return Apple;
    case "windows":
      return AppWindow;
    case "other":
      return HardDrive;
    default:
      return Server;
  }
}

/**
 * A tint per operating system, kept deliberately quiet.
 *
 * The colour that carries meaning in this tree is the *host's own* — the one the user sets to mark
 * production — so the OS glyph must not compete with it. These are muted enough to read as a
 * category and not as a warning.
 */
export function osColor(os: RemoteOs): string {
  switch (os) {
    case "macos":
      return "#a1a1aa";
    case "windows":
      return "#3b82f6";
    case "other":
      return "#94a3b8";
    default:
      return "#f59e0b";
  }
}

export function OsGlyph({ os, size = 14 }: { os: RemoteOs; size?: number }) {
  const Icon = osIcon(os);
  return <Icon size={size} style={{ color: osColor(os) }} />;
}

/**
 * A host's state, as one dot.
 *
 * Three states rather than two, because "has a live session" and "has a live tunnel" are genuinely
 * different things to know about a machine and collapsing them would make a host with a forward up
 * look idle. Filled = a session is open; ringed = no session but something of this host's is
 * running; hollow = nothing.
 */
export function HostDot({
  session,
  active,
  color,
}: {
  session: boolean;
  active: boolean;
  color?: string;
}) {
  const tint = color?.trim() || "var(--cf-accent)";
  if (session) {
    return (
      <span
        aria-hidden
        className="h-[7px] w-[7px] shrink-0 rounded-full"
        style={{ background: tint }}
      />
    );
  }
  if (active) {
    return (
      <span
        aria-hidden
        className="h-[7px] w-[7px] shrink-0 rounded-full border"
        style={{ borderColor: tint }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="h-[7px] w-[7px] shrink-0 rounded-full border border-[var(--cf-text-muted)]/40"
    />
  );
}

/** The toolbar button shape the database explorer uses, so both sidebars' headers match. */
export function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
      }`}
    >
      <Icon size={13} />
    </button>
  );
}

/** A small labelled pill — the protocol on a screen tab, the direction on a forward row. */
export function Pill({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "accent" }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${
        tone === "accent"
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "bg-black/[0.05] text-[var(--cf-text-muted)] dark:bg-white/[0.07]"
      }`}
    >
      {children}
    </span>
  );
}
