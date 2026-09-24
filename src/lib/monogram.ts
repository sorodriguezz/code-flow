import type { CSSProperties } from "react";

/**
 * Two letters that tell one repository from the next where there is no room for its name — the
 * folded projects rail, the chip on each project row, the scope at the head of the title row.
 *
 * They replaced a white folder glyph on a square of the project's colour, which made every folded
 * repository the same icon and left the colour to carry identity on its own. Two words give their
 * initials (`code-flow` → CF, `api gateway` → AG); one camel-cased word gives its humps
 * (`codeFlow` → CF); anything else its first two letters.
 */
export function monogram(name: string): string {
  const words = name.split(/[\s._\-/]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name;
  const hump = word.slice(1).search(/[A-Z0-9]/);
  if (hump >= 0) return (word[0] + word[hump + 1]).toUpperCase();
  return (word.slice(0, 2) || "?").toUpperCase();
}

/**
 * The monogram's tile in the project's own colour — a wash behind, the colour pulled toward the
 * theme's text for the letters, and a ring. Mixed rather than used raw because the colour comes
 * from the database: a pale yellow at full strength behind white letters vanished on light, and
 * behind the colour's own ink it stays legible on both.
 */
export function monogramStyle(color: string): CSSProperties {
  return {
    background: `color-mix(in oklab, ${color} 18%, transparent)`,
    color: `color-mix(in oklab, ${color} 58%, var(--cf-text))`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 38%, transparent)`,
  };
}

/**
 * The colour that marks a repository as the open one — its ring and its rail marker. The project's
 * own colour, pulled a fifth of the way toward the theme's text so a dark colour still stands out
 * on the dark frame and a pale one on the light frame.
 */
export function monogramMarkColor(color: string): string {
  return `color-mix(in oklab, ${color} 80%, var(--cf-text))`;
}

/**
 * The tile of the repository that is open: a stronger wash, the letters closer to full strength,
 * and a 2px ring in its mark colour standing 2px off the tile over the frame.
 *
 * The ring has to be part of this `boxShadow`. It used to be Tailwind's `ring-2 ring-offset-2` on
 * the chip — which is also a box-shadow, and so lost to the inline one `monogramStyle` sets: the
 * active chip had no ring at all and differed from the rest only by not being dimmed.
 */
export function monogramActiveStyle(color: string): CSSProperties {
  return {
    background: `color-mix(in oklab, ${color} 28%, transparent)`,
    color: `color-mix(in oklab, ${color} 70%, var(--cf-text))`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 50%, transparent), 0 0 0 2px var(--cf-bg), 0 0 0 4px ${monogramMarkColor(color)}`,
  };
}
