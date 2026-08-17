import { useId, useMemo, type ReactNode } from "react";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { BRAND_LOGOS } from "../../lib/icons/brandLogos";

/**
 * A brand mark by id — an AI engine's or a platform's — with a caller-supplied fallback for the
 * ones no set ships.
 *
 * One component rather than a field on each registry, because the two answers are different *kinds*
 * of thing: a Lucide icon is a component you render, a logo is markup you inline, and no call site
 * should have to know which it got. Every registry keeps its Lucide icon as the fallback, so a
 * brand with no mark here draws what it always drew rather than an empty square.
 *
 * `fill="currentColor"` is what makes the monochrome marks work in both themes: OpenAI's flower,
 * xAI's slash and GitHub's Octocat carry no fill of their own, so without it they are black on a
 * dark background. The marks that *do* bring colour — Anthropic's orange, GitLab's fox, Jira's
 * gradient — set it on their own paths and override this.
 */
export function BrandGlyph({
  id,
  size = 14,
  className = "",
  fallback = null,
}: {
  id: string;
  size?: number;
  className?: string;
  /** Drawn when nothing here has a mark for `id`. */
  fallback?: ReactNode;
}) {
  const logo = BRAND_LOGOS[id];
  /**
   * A per-instance suffix for the ids inside the markup.
   *
   * Jira's mark and Gemini's spark are painted with `<linearGradient id="…">` referenced as
   * `url(#…)`, and those ids are document-global. Two Gemini glyphs on screen — the providers list
   * and the routing table under it, which is the ordinary case — put the same id in the DOM twice;
   * every reference then resolves to whichever came first, and when *that* one unmounts the
   * survivors are left pointing at a definition that is gone, so the mark paints as nothing.
   * Scoping the ids per instance costs one string pass on a static body and removes the whole
   * class of problem.
   */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const body = useMemo(() => (logo ? scopeIds(logo.body, uid) : ""), [logo, uid]);

  if (!logo) return <>{fallback}</>;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${logo.width} ${logo.height}`}
      fill="currentColor"
      className={`shrink-0 ${className}`}
      aria-hidden
      // The markup comes from a bundled icon set, never from anything the user typed — the same
      // argument `CatalogGlyph` makes. See `BrandLogo.body`.
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

/**
 * The mark for one AI provider, falling back to the Lucide icon `aiProviders.ts` gives it.
 *
 * The overwhelmingly common case, and its own component so the ~15 call sites do not each repeat
 * the fallback lookup.
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
  const Fallback = AI_PROVIDERS.find((provider) => provider.id === providerId)?.icon;
  return (
    <BrandGlyph
      id={providerId}
      size={size}
      className={className}
      fallback={Fallback ? <Fallback size={size} className={`shrink-0 ${className}`} /> : null}
    />
  );
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
