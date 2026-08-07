import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gauge } from "lucide-react";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { useT } from "../../state/languageStore";
import {
  compactTokens,
  formatCost,
  totalTokens,
  useUsageStore,
  windowTotals,
} from "../../state/usageStore";
import type { UsageWindow } from "../../types/domain";

const PANEL_WIDTH = 300;

/**
 * What the engines have actually spent, next to the bell.
 *
 * **This is a meter, not a quota.** None of the CLIs this app dispatches to publishes "how much of
 * your plan is left" in a form a program can read, so what is drawn is what was measured: the
 * tokens each engine reported on each finished run, over the last seven days, with cost where the
 * CLI priced it. The bars are each engine's *share* of the window — a proportion of something real
 * — rather than a fraction of a limit nobody published.
 *
 * **One window, not two.** It used to draw the five-hour window above the weekly one, which grew a
 * row per engine per window and, at five engines, was taller than the pane it hung off. Seven days
 * is the one that answers the question a status bar is asked. Everything else — shorter windows, a
 * chart over time, the per-model split — lives in Settings → AI, which is a screen and can afford
 * to be one.
 *
 * An engine that reports nothing simply is not here. That is deliberate and is why the panel says
 * which engines it has heard from: a row reading zero would be a claim, and this has no way to make
 * it.
 */
export function UsageMeter() {
  const t = useT();
  const summary = useUsageStore((s) => s.summary);
  const loading = useUsageStore((s) => s.loading);
  const watch = useUsageStore((s) => s.watch);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; right: number; maxHeight: number } | null>(null);

  useEffect(() => watch(), [watch]);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Upward: this lives in a footer pinned to the bottom of the window, so there is never room
    // below it. Same reasoning — and the same numbers — as the notification panel beside it.
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      right: Math.max(8, window.innerWidth - rect.right),
      maxHeight: Math.max(200, rect.top - 24),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const week = windowTotals(summary.week);

  // Nothing has ever been recorded: no button at all. An empty meter in the status bar is a
  // permanent question about a feature that has not started yet.
  if (loading || week.runs === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        title={t("usage.title")}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
          open ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
        }`}
      >
        <Gauge size={12} className="shrink-0" />
        <span>{compactTokens(week.tokens)}</span>
        {/* Cost only when somebody priced it. A `$0.00` beside a real token count would read as
            "this was free" rather than as "nobody said". */}
        {week.costed > 0 && <span>· {formatCost(week.cost)}</span>}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ bottom: pos.bottom, right: pos.right, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
            className="cf-fade-in fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-3 py-2">
              <Gauge size={13} className="shrink-0 text-[var(--cf-accent)]" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{t("usage.title")}</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              <WindowBlock
                label={t("usage.week")}
                windows={summary.week}
                totals={week}
                emptyLabel={t("usage.quietWindow")}
              />
            </div>

            {/* One line, said outright, because the thing this most resembles is a quota gauge and
                it is not one. It used to carry the reasoning and a pointer to the statistics screen
                as well, which made a four-line footnote under a three-line panel. */}
            <p className="shrink-0 border-t border-[var(--cf-border)] px-3 py-2 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
              {t("usage.notAQuota")}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}

function WindowBlock({
  label,
  windows,
  totals,
  emptyLabel,
}: {
  label: string;
  windows: UsageWindow[];
  totals: { tokens: number; cost: number; costed: number; runs: number };
  emptyLabel: string;
}) {
  const t = useT();
  const ordered = [...windows].sort((a, b) => totalTokens(b) - totalTokens(a));

  return (
    <section>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {label}
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-[var(--cf-text)]">
          {compactTokens(totals.tokens)}
        </span>
        {totals.costed > 0 && (
          <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
            {formatCost(totals.cost)}
          </span>
        )}
      </div>

      {ordered.length === 0 ? (
        <p className="text-[11px] text-[var(--cf-text-muted)]">{emptyLabel}</p>
      ) : (
        <div className="space-y-1.5">
          {ordered.map((window) => {
            const tokens = totalTokens(window);
            // Share of the window, which is a proportion of something measured. Guarded against a
            // zero total, which a window of runs that reported only a cost really can produce.
            const share = totals.tokens > 0 ? (tokens / totals.tokens) * 100 : 0;
            const provider = AI_PROVIDERS.find((p) => p.id === window.provider);
            const Icon = provider?.icon;
            return (
              <div key={window.provider}>
                <div className="flex items-center gap-1.5">
                  {Icon && <Icon size={11} className="shrink-0 text-[var(--cf-text-muted)]" />}
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text)]">
                    {provider?.label ?? window.provider}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                    {compactTokens(tokens)}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                    {window.costed_runs > 0 ? formatCost(window.cost_usd) : t("usage.noCost")}
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]">
                  <div
                    className="h-full rounded-full bg-[var(--cf-accent)]"
                    style={{ width: `${Math.max(share, 2)}%` }}
                  />
                </div>
                <p className="mt-0.5 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
                  {t("usage.breakdown", {
                    runs: window.runs,
                    input: compactTokens(window.input_tokens),
                    output: compactTokens(window.output_tokens),
                    cached: compactTokens(window.cache_read_tokens + window.cache_write_tokens),
                  })}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
