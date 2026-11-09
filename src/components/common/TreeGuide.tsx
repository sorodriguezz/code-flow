/**
 * The connector lines of a tree row — `├─` for a child with siblings below it, `└─` for the last
 * one — drawn absolutely inside a `relative` row, so the row's own layout is untouched.
 *
 * `x` is where this level's vertical line runs (usually under the parent's icon), `elbow` how far
 * the horizontal tick reaches toward the row's own icon. `ancestors` are the x positions of outer
 * levels whose line keeps going past this row (an ancestor with siblings still to come). `bleed`
 * extends the vertical lines upward over the gap between rows, so they read as one continuous line.
 */
export function TreeGuide({
  x,
  last,
  elbow = 8,
  ancestors = [],
  bleed = 0,
}: {
  x: number;
  last: boolean;
  elbow?: number;
  ancestors?: number[];
  bleed?: number;
}) {
  const line = "pointer-events-none absolute bg-[var(--cf-border-strong)]";
  return (
    <>
      {ancestors.map((ax) => (
        <span key={ax} aria-hidden className={`${line} bottom-0 w-px`} style={{ left: ax, top: -bleed }} />
      ))}
      <span aria-hidden className={`${line} w-px`} style={{ left: x, top: -bleed, ...(last ? { height: `calc(50% + ${bleed}px)` } : { bottom: 0 }) }} />
      <span aria-hidden className={`${line} top-1/2 h-px`} style={{ left: x, width: elbow }} />
    </>
  );
}
