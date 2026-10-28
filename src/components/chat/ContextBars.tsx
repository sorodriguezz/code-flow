import type { ContextBreakdown } from "../../lib/contextBreakdown";

const SHADES = ["var(--cf-ai-a)", "var(--cf-accent)", "var(--cf-success)", "var(--cf-warning)", "var(--cf-ai-b, var(--cf-accent))"];

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** What `/context` said, as one stacked bar and a row per category — the free space drawn but not counted as used. */
export function ContextBars({ breakdown }: { breakdown: ContextBreakdown }) {
  const total = breakdown.categories.reduce((sum, c) => sum + c.tokens, 0) || 1;
  let shade = 0;
  const coloured = breakdown.categories.map((c) => ({ ...c, color: c.free ? "var(--cf-border)" : SHADES[shade++ % SHADES.length] }));
  return (
    <div className="mt-2 max-w-[520px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-sunken)] p-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-[var(--cf-border)]" role="img" aria-label={coloured.map((c) => `${c.name} ${tokens(c.tokens)}`).join(", ")}>
        {coloured.map((c) => (
          <div key={c.name} style={{ width: `${(c.tokens / total) * 100}%`, background: c.color }} />
        ))}
      </div>
      <ul className="mt-2 space-y-0.5">
        {coloured.map((c) => (
          <li key={c.name} className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color }} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="shrink-0 font-mono tabular-nums text-[var(--cf-text)]">{tokens(c.tokens)}</span>
            {c.percent !== null && <span className="w-12 shrink-0 text-right font-mono tabular-nums">{c.percent}%</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
