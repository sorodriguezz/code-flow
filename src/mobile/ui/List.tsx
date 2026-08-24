import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { tapped } from "../haptics";

/**
 * The grouped list, which is most of this client.
 *
 * # Why these three components and not Tailwind at every call site
 *
 * Nine screens drew the same thing — a labelled group of rows in a rounded, bordered card — and
 * each spelled it out by hand. They disagreed: three radii, two border colours, two divider
 * treatments, four label sizes, and `mt-3` next to `mt-4` next to `mt-2` between them. Nothing was
 * *wrong* anywhere, and the whole thing read as unfinished, because a list on one screen did not
 * line up with a list on the next.
 *
 * `Section` owns the heading and the spacing above it. `Card` owns the shape. `Row` owns the height,
 * the press feedback and the chevron. A screen composes the three and gets the same list the other
 * eight have.
 */

/** A labelled block. The label is optional — some groups are obvious from the row above them. */
export function Section({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  /** A control that belongs to the whole group — "see all", a count, a toggle. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mt-5 first:mt-3 ${className}`}>
      {(title || action) && (
        <header className="flex items-end justify-between gap-2 px-1 pb-1.5">
          {title && (
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
              {title}
            </h2>
          )}
          {/* `ml-auto` when the group has no heading: `justify-between` with a single child leaves it
              at the start, so a filter chip or a "clear" button drifted to the left edge on exactly
              the two groups that have no title. */}
          {action && <span className={title ? "" : "ml-auto"}>{action}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * The rounded surface rows sit on.
 *
 * `overflow-hidden` is load-bearing: without it the first and last rows' press highlight paints
 * square corners over the card's rounded ones, which is the sort of one-pixel wrongness that makes
 * an interface feel cheap without anybody being able to say why.
 */
export function Card({
  children,
  className = "",
  raised,
  padded,
}: {
  children: ReactNode;
  className?: string;
  /** Lifts the card off the background with a shadow. For anything that is *in front* of the list
   *  rather than part of it — the gate box, the commit composer. */
  raised?: boolean;
  /** Adds the standard inner padding. Off by default, because a card full of `Row`s must not have
   *  any: the rows draw their own and their dividers have to reach the card's edges. */
  padded?: boolean;
}) {
  return (
    <div
      className={`overflow-hidden rounded-lg border border-[var(--cf-border)] ${
        raised ? "bg-[var(--cf-surface-raised)] shadow-raised" : "bg-[var(--cf-surface)] shadow-card"
      } ${padded ? "p-3" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/** The hairline between two rows of one card. Inset on the left so it starts under the text rather
 *  than under the icon, which is what stops a list of icons reading as a table. */
export function Divider({ inset }: { inset?: boolean }) {
  return (
    <div
      aria-hidden
      className={`h-px bg-[var(--cf-divider)] ${inset ? "ml-11" : ""}`}
    />
  );
}

/**
 * One row.
 *
 * Tappable when it is given an `onClick`, and a plain `<div>` when it is not — a non-interactive
 * row rendered as a `<button>` is announced as a button by every screen reader and is the single
 * most common accessibility mistake in a list-heavy UI.
 */
export function Row({
  title,
  subtitle,
  leading,
  trailing,
  onClick,
  disabled,
  chevron,
  danger,
  className = "",
  titleClassName = "",
  ariaLabel,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Draws the "this opens something" chevron. Implied by `onClick` unless explicitly `false`. */
  chevron?: boolean;
  danger?: boolean;
  className?: string;
  titleClassName?: string;
  ariaLabel?: string;
}) {
  const showChevron = chevron ?? Boolean(onClick);
  const body = (
    <>
      {leading && <span className="flex w-7 shrink-0 justify-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-md ${danger ? "text-[var(--cf-danger-text)]" : ""} ${titleClassName}`}
        >
          {title}
        </span>
        {subtitle && (
          <span className="mt-0.5 block truncate text-xs text-[var(--cf-text-muted)]">
            {subtitle}
          </span>
        )}
      </span>
      {trailing}
      {showChevron && (
        <ChevronRight size={15} className="shrink-0 text-[var(--cf-text-faint)]" aria-hidden />
      )}
    </>
  );

  const shape = `flex w-full items-center gap-2.5 px-3 py-2.5 text-left ${className}`;

  if (!onClick) return <div className={shape}>{body}</div>;

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() => {
        tapped();
        onClick();
      }}
      className={`cf-tap cf-press-row ${shape} disabled:opacity-50`}
    >
      {body}
    </button>
  );
}

/**
 * A path, truncated from the left so the filename survives.
 *
 * `direction: rtl` is what does it: the browser cuts the *start* of the string instead of the end,
 * so `src/components/settings/RemoteSettings.tsx` becomes `…/settings/RemoteSettings.tsx` rather
 * than `src/components/set…`. The `<bdi>` is not optional — without it the reversed base direction
 * moves punctuation to the wrong end, and a path ending in a bracket or a dot renders it at the
 * front.
 */
export function PathText({ path, className = "" }: { path: string; className?: string }) {
  return (
    <span className={`block truncate ${className}`} style={{ direction: "rtl" }} title={path}>
      <bdi>{path}</bdi>
    </span>
  );
}
