import { BrandGlyph } from "../ai/ProviderGlyph";
import { SCAFFOLD_LOGOS } from "../../lib/scaffold/logos";

/**
 * A template's or a tool's mark, from the initializer's own bundled set; the name's initial in a
 * rounded square when there is none (uv, Composer). The fallback is sized like the mark so a row of
 * them stays on one axis.
 */
export function TemplateLogo({ logo, name, size = 16 }: { logo?: string; name: string; size?: number }) {
  const mark = logo ? SCAFFOLD_LOGOS[logo] : undefined;
  return (
    <BrandGlyph
      id={logo ?? name}
      logo={mark}
      size={size}
      className="text-[var(--cf-text)]"
      fallback={
        <span
          aria-hidden
          style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.55)) }}
          className="flex shrink-0 items-center justify-center rounded-[4px] bg-[var(--cf-hover)] font-semibold uppercase leading-none text-[var(--cf-text-muted)]"
        >
          {name.charAt(0)}
        </span>
      }
    />
  );
}
