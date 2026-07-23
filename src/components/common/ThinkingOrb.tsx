/** A living, morphing gradient blob shown wherever Claude is actually working — the
 * `orbs.jakubantalik.com`-style "thinking" visual, reimplemented here in plain CSS
 * (see the `.cf-orb*` rules in index.css) rather than pulling in that library. */
export function ThinkingOrb({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`cf-orb cf-orb-${size}`} aria-hidden="true">
      <span className="cf-orb-glow" />
      <span className="cf-orb-core" />
    </span>
  );
}
