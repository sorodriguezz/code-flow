import { useState, type CSSProperties, type Ref } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

/** One loop of the flow, in ms — `cf-ai-flow` in `index.css`. */
const FLOW_MS = 3000;

/** The glyphs that stand for AI in this app, each a mask copied from lucide (`.cf-ai-*`). */
export type AiGlyphName = "sparkles" | "wand" | "brain";

/**
 * An AI icon: the glyph cut out of the logo's stroke, with the stroke flowing through it — see
 * `.cf-ai-glyph` in `index.css` for why it is a mask and not an SVG with a gradient.
 *
 * Laid out like the lucide icon it replaces (a `size`-square block), so it swaps in anywhere one sat.
 * `still` stops the flow at rest, for a door that has already been opened. `onFill` is for a primary
 * button: the logo's indigo is the accent's own hue and would vanish into the fill, so the stroke is
 * mixed toward the button's ink (`.cf-ai-glyph-on-fill`).
 */
export function AiGlyph({
  name = "sparkles",
  size = 24,
  still = false,
  onFill = false,
  className = "",
  ref,
}: {
  name?: AiGlyphName;
  size?: number | string;
  still?: boolean;
  onFill?: boolean;
  className?: string;
  ref?: Ref<HTMLSpanElement>;
}) {
  // Every glyph on screen flows in step: each starts its loop as if it had been running since the
  // page loaded. Read once, so a re-render never shifts it mid-loop.
  const [phase] = useState(() => -(performance.now() % FLOW_MS));
  return (
    <span
      ref={ref}
      aria-hidden
      className={`cf-ai-glyph cf-ai-${name} ${still ? "" : "cf-ai-glyph-flowing"} ${onFill ? "cf-ai-glyph-on-fill" : ""} ${className}`}
      style={{ width: size, height: size, "--cf-ai-phase": `${phase.toFixed(0)}ms` } as CSSProperties}
    />
  );
}

/** The same glyph shaped like a lucide icon, for the places that take an icon *component* — a menu
 *  item's `icon`, a settings pane's. `color` and `strokeWidth` have nothing to paint here. */
function lucideShaped(name: AiGlyphName): LucideIcon {
  function Glyph({ size, className }: LucideProps) {
    return <AiGlyph name={name} size={size ?? 24} className={className} />;
  }
  Glyph.displayName = `AiGlyph(${name})`;
  return Glyph as unknown as LucideIcon;
}

export const AiSparkles = lucideShaped("sparkles");
export const AiWand = lucideShaped("wand");
export const AiBrain = lucideShaped("brain");
