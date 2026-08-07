import { create } from "zustand";
import { aiUsageSummary } from "../lib/tauri/commands";
import { onTurnSettled } from "./agentEvents";
import type { UsageSummary, UsageWindow } from "../types/domain";

/** How often the meter re-reads while the app is on screen.
 *
 * A poll and not a subscription, and the interval is the argument for it: the rows are written from
 * inside the run plumbing, which has no business knowing a window is open, and nothing here is
 * urgent enough to be worth an event per turn. Ten seconds is under the time it takes to notice. */
const POLL_MS = 10_000;

const EMPTY: UsageSummary = { session: [], week: [], since: "" };

interface UsageState {
  summary: UsageSummary;
  /** True until the first read lands, so the bar can stay out of the way rather than flash a zero. */
  loading: boolean;
  refresh: () => Promise<void>;
  /** Starts polling, and returns the stop. Reference-counted, so the meter mounting twice — the
   * status bar renders it in two branches — does not start two timers. */
  watch: () => () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let watchers = 0;

export const useUsageStore = create<UsageState>((set, get) => ({
  summary: EMPTY,
  loading: true,

  refresh: async () => {
    const summary = await aiUsageSummary().catch(() => null);
    // Kept as it was on failure rather than blanked: a meter that empties itself because one read
    // failed reads as "nothing has been spent", which is the one thing it must never say wrongly.
    if (summary) set({ summary, loading: false });
    else set({ loading: false });
  },

  watch: () => {
    watchers += 1;
    if (watchers === 1) {
      void get().refresh();
      timer = setInterval(() => void get().refresh(), POLL_MS);
    }
    return () => {
      watchers -= 1;
      if (watchers === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  },
}));

/** An agent turn that just landed is a moment the meter is certainly stale, so it does not wait out
 * the poll. Only agent turns raise this — a chat turn, a review or a generated commit message spend
 * tokens too and are caught by the poll a few seconds later, which is what the poll is for. */
onTurnSettled(() => {
  if (watchers > 0) void useUsageStore.getState().refresh();
});

/** Everything an engine put through, cache reads included — the honest "how much text moved". */
export function totalTokens(window: UsageWindow): number {
  return (
    window.input_tokens + window.output_tokens + window.cache_read_tokens + window.cache_write_tokens
  );
}

/** The window's totals across every engine, for the pill and for the share each provider's bar
 * draws. */
export function windowTotals(windows: UsageWindow[]): {
  tokens: number;
  cost: number;
  costed: number;
  runs: number;
} {
  return windows.reduce(
    (acc, w) => ({
      tokens: acc.tokens + totalTokens(w),
      cost: acc.cost + w.cost_usd,
      costed: acc.costed + w.costed_runs,
      runs: acc.runs + w.runs,
    }),
    { tokens: 0, cost: 0, costed: 0, runs: 0 },
  );
}

/** `1.2M`, `128k`, `940`. Compact because it sits in a 8px-tall bar next to a bell. */
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
