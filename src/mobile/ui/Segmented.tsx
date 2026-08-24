import { tapped } from "../haptics";

/**
 * A two- or three-way switch between views of the same thing.
 *
 * Drawn as a track with a sliding thumb rather than as two outlined buttons — which is what the
 * Agents tab had, and which reads as "two things you can press" instead of "one setting with two
 * positions". The thumb moves with a transform, so the transition costs nothing and the eye follows
 * which side is now selected.
 *
 * `role="tablist"` and not a radio group: these switch what is displayed below, which is what tabs
 * mean to a screen reader, and the panels are announced as belonging to them.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = "",
}: {
  value: T;
  options: { id: T; label: string; badge?: number }[];
  onChange: (id: T) => void;
  className?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );

  return (
    <div
      role="tablist"
      className={`relative flex rounded-lg bg-[var(--cf-sunken)] p-0.5 ${className}`}
    >
      {/* The thumb, absolutely positioned and moved by transform. One element rather than a
          background on the selected button, so the movement between them is continuous. */}
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-[var(--cf-surface)] shadow-card transition-transform duration-200 ease-[var(--ease-nav)]"
        style={{
          width: `calc((100% - 0.25rem) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
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
            className={`relative z-10 flex min-h-[2.25rem] flex-1 items-center justify-center gap-1.5 rounded-md text-base font-medium transition-colors ${
              active ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
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
