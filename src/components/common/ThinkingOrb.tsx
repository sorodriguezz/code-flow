/**
 * The "something is working" mark, shown wherever an engine is actually running — an agent turn,
 * a story generation, a review stage, a wiki write.
 *
 * A reactor: two counter-rotating arcs with three particles falling into a beating core. The
 * falling is the part that matters — an agent takes context in and burns it, and a ring turning
 * on its own is what every "loading" in every app looks like. Plain CSS (see the `.cf-orb*` rules
 * in index.css), transform-only, no canvas and no JS loop.
 *
 * `aria-hidden`: it says nothing a screen reader can use. Every caller sits next to text that
 * already names what is running, and a second announcement per row would be noise.
 */
export function ThinkingOrb({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`cf-orb cf-orb-${size}`} aria-hidden="true">
      <span className="cf-orb-ring" />
      <span className="cf-orb-ring cf-orb-ring-inner" />
      {/* One element per particle rather than a loop: three is the count the timings are tuned
          for (2.4s, 3.1s, 1.8s — no shared divisor, so they never fall in step), and a `map` over
          a range would hide that behind an index. */}
      <span className="cf-orb-feed" />
      <span className="cf-orb-feed cf-orb-feed-2" />
      <span className="cf-orb-feed cf-orb-feed-3" />
      <span className="cf-orb-core" />
    </span>
  );
}
