/**
 * How token counts and money are written wherever the app reports AI spend.
 *
 * These lived in `usageStore` while the status bar drew a spend meter. That meter is now quota-only
 * and the store is gone, but the Settings → AI screen still reports the same two kinds of number —
 * so they live here, next to nothing in particular, rather than in a store that exists to hold them.
 */

/** `1.2M`, `128k`, `940`.
 *
 * Compact because these sit in table cells and stat tiles that a long digit string would push out of
 * shape, and because at six figures the exact count is never the point. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Money, at the precision the number deserves: cents matter at three dollars and not at three
 * hundred. */
export function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}
