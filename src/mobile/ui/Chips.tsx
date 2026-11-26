import { useEffect, useRef } from "react";
import { tapped } from "../haptics";

/**
 * A row of views to choose between, that scrolls sideways when it does not fit.
 *
 * # Why not `Segmented`
 *
 * `Segmented` divides the width evenly, which is right for two or three choices and stops working
 * at five: on a 360-pixel phone a fifth segment leaves each label under sixty pixels, and "Servicios"
 * with a badge beside it does not fit in sixty pixels. The Agents tab grew to six views when teams
 * and the summary joined it, so its control is this instead — each chip as wide as its own label,
 * the row scrolling under the thumb.
 *
 * The selected chip is scrolled into view when the selection changes from somewhere else (the
 * summary's "see all" rows jump to a view), because a selection that is off-screen reads as no
 * selection at all.
 */
export function Chips<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string; badge?: number }[];
  onChange: (id: T) => void;
  /** What the row chooses between, for a screen reader. */
  label: string;
}) {
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = row.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // `nearest` on both axes: `scrollIntoView` moves every scrollable ancestor it needs to, and
    // the default block alignment would drag the screen body with it.
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);

  return (
    <div ref={row} role="tablist" aria-label={label} className="cf-scroll-x flex gap-1.5 px-3 pb-2">
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (active) return;
              tapped();
              onChange(option.id);
            }}
            className={`cf-press flex min-h-[2.25rem] shrink-0 items-center gap-1.5 rounded-full border px-3 text-base font-medium transition-colors ${
              active
                ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent-text)]"
                : "border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)]"
            }`}
          >
            {option.label}
            {option.badge !== undefined && option.badge > 0 && (
              <span className="rounded-full bg-[var(--cf-accent-strong)] px-1.5 text-2xs font-semibold text-[var(--cf-accent-contrast)]">
                {option.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
