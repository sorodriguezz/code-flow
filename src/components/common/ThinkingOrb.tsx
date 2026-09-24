import type { ReactElement } from "react";
import type { ThinkingDesign } from "../../lib/thinkingDesigns";
import { useThinkingDesignStore } from "../../state/thinkingDesignStore";

/**
 * The "something is working" mark, shown wherever an engine is actually running — an agent turn,
 * a story generation, a review stage, a wiki write.
 *
 * It has eight looks now (`lib/thinkingDesigns`), chosen once in Settings and followed by every orb
 * in every window. The default is the one it always had, a reactor: two counter-rotating arcs with
 * three particles falling into a beating core. The falling is the part that matters — an agent
 * takes context in and burns it, and a ring turning on its own is what every "loading" in every
 * app looks like. Every design is plain CSS (the `.cf-orb*` rules in index.css), transform-only, no
 * canvas and no JS loop.
 *
 * `design` pins one look regardless of the setting — for the picker that previews all of them.
 *
 * `aria-hidden`: it says nothing a screen reader can use. Every caller sits next to text that
 * already names what is running, and a second announcement per row would be noise.
 */
export function ThinkingOrb({ size = "md", design }: { size?: "sm" | "md" | "lg"; design?: ThinkingDesign }) {
  const chosen = useThinkingDesignStore((s) => s.design);
  const look = design ?? chosen;
  return (
    <span className={`cf-orb cf-orb-${size} cf-orb--${look}`} aria-hidden="true">
      {PARTS[look]}
    </span>
  );
}

/**
 * The elements each design is drawn from, built once at module load — an orb re-rendering (its row
 * updating a timer, say) hands React the same elements and it skips them.
 *
 * Written out rather than generated from counts where the count is the design: three particles for
 * the reactor because its timings are tuned for three (2.4s, 3.1s, 1.8s — no shared divisor, so
 * they never fall in step), nine cells because the matrix is three by three.
 */
const PARTS: Record<ThinkingDesign, ReactElement> = {
  reactor: (
    <>
      <span className="cf-orb-ring" />
      <span className="cf-orb-ring cf-orb-ring-inner" />
      <span className="cf-orb-feed" />
      <span className="cf-orb-feed cf-orb-feed-2" />
      <span className="cf-orb-feed cf-orb-feed-3" />
      <span className="cf-orb-core" />
    </>
  ),
  spark: (
    <>
      <span className="cf-orb-star" />
      <span className="cf-orb-twinkle" />
      <span className="cf-orb-twinkle cf-orb-twinkle-2" />
    </>
  ),
  aurora: (
    <>
      <span className="cf-orb-aura" />
      <span className="cf-orb-aura cf-orb-aura-2" />
      <span className="cf-orb-glint" />
    </>
  ),
  orbit: (
    <>
      {[1, 2, 3].map((n) => (
        <span key={n} className={`cf-orb-plane cf-orb-plane-${n}`}>
          <span className="cf-orb-carrier">
            <span className="cf-orb-electron" />
          </span>
        </span>
      ))}
      <span className="cf-orb-nucleus" />
    </>
  ),
  pulse: (
    <>
      <span className="cf-orb-ripple" />
      <span className="cf-orb-ripple cf-orb-ripple-2" />
      <span className="cf-orb-heart" />
    </>
  ),
  // The three laid out in a row or a grid do it on an inner layer: the orb itself stays the
  // `inline-block` every design shares, so it sits on a line of text exactly where the reactor did.
  voice: (
    <span className="cf-orb-bars">
      <span className="cf-orb-bar" />
      <span className="cf-orb-bar" />
      <span className="cf-orb-bar" />
      <span className="cf-orb-bar" />
    </span>
  ),
  matrix: (
    <span className="cf-orb-grid">
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} className="cf-orb-cell" />
      ))}
    </span>
  ),
  helix: (
    <span className="cf-orb-strands">
      {[1, 2, 3, 4].map((n) => (
        <span key={n} className="cf-orb-strand">
          <span className="cf-orb-base" />
          <span className="cf-orb-base cf-orb-base-b" />
        </span>
      ))}
    </span>
  ),
};
