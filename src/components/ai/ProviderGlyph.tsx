import { useId, useMemo } from "react";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { PROVIDER_LOGOS } from "../../lib/icons/providerLogos";

/**
 * The mark for one AI provider: its brand logo where there is one, its Lucide glyph where there
 * isn't.
 *
 * One component rather than a field on `AiProviderOption`, because the two answers are different
 * *kinds* of thing — a Lucide icon is a component you render, a logo is markup you inline — and the
 * call sites should not each have to know which they got. A provider with no logo (`opencode`,
 * `cline`: no installed set ships either mark) simply keeps the glyph it always had, so nothing
 * anywhere renders an empty square.
 *
 * `fill="currentColor"` is what makes the monochrome marks work in both themes: OpenAI's flower and
 * xAI's slash carry no fill of their own, so without it they are black on a dark background. The
 * marks that *do* bring colour — Anthropic's orange, Gemini's gradient — set it on their own paths
 * and override this.
 */
export function ProviderGlyph({
  providerId,
  size = 14,
  className = "",
}: {
  providerId: string;
  size?: number;
  /** Applies to the fallback glyph as well, so a caller can tint the one and leave the other. */
  className?: string;
}) {
  const logo = PROVIDER_LOGOS[providerId];
  /**
   * A per-instance suffix for the ids inside the markup.
   *
   * Gemini's spark is painted with `<radialGradient id="…">` referenced as `url(#…)`, and those ids
   * are document-global. Two Gemini glyphs on screen — the providers list and the routing table
   * under it, which is the ordinary case — put the same id in the DOM twice; every reference then
   * resolves to whichever came first, and when *that* one unmounts the survivors are left pointing
   * at a definition that is gone, so the spark paints as nothing. Scoping the ids per instance
   * costs one string pass on a static body and removes the whole class of problem.
   */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const body = useMemo(() => (logo ? scopeIds(logo.body, uid) : ""), [logo, uid]);

  if (logo) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${logo.width} ${logo.height}`}
        fill="currentColor"
        className={`shrink-0 ${className}`}
        aria-hidden
        // The markup comes from a bundled icon set, never from anything the user typed — the same
        // argument `CatalogGlyph` makes. See `ProviderLogo.body`.
        dangerouslySetInnerHTML={{ __html: body }}
      />
    );
  }

  const Fallback = AI_PROVIDERS.find((provider) => provider.id === providerId)?.icon;
  if (!Fallback) return null;
  return <Fallback size={size} className={`shrink-0 ${className}`} />;
}

/**
 * Makes every id a body defines unique to one instance, references included.
 *
 * Deliberately literal: it rewrites `id="x"` and `url(#x)` for the ids the body itself declares,
 * and touches nothing else. A regex over the whole markup would be shorter and would also rewrite
 * an `id` that appeared inside path data or a title.
 */
function scopeIds(body: string, suffix: string): string {
  const declared = [...body.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  return declared.reduce(
    (markup, id) =>
      markup.split(`id="${id}"`).join(`id="${id}-${suffix}"`).split(`url(#${id})`).join(`url(#${id}-${suffix})`),
    body,
  );
}
