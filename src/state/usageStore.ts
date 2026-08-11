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

/** Whether two reads say the same thing.
 *
 * The summary arrives deserialized from IPC, so every tick hands back a brand-new object graph
 * even when not a single number moved — and publishing it re-rendered the status bar every ten
 * seconds for nothing. This is the whole comparison: eight numbers per provider, over a handful of
 * providers, run once per poll. */
function sameWindows(a: UsageWindow[], b: UsageWindow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.provider !== y.provider ||
      x.runs !== y.runs ||
      x.input_tokens !== y.input_tokens ||
      x.output_tokens !== y.output_tokens ||
      x.cache_read_tokens !== y.cache_read_tokens ||
      x.cache_write_tokens !== y.cache_write_tokens ||
      x.cost_usd !== y.cost_usd ||
      x.costed_runs !== y.costed_runs
    ) {
      return false;
    }
  }
  return true;
}

function sameSummary(a: UsageSummary, b: UsageSummary): boolean {
  return a.since === b.since && sameWindows(a.session, b.session) && sameWindows(a.week, b.week);
}

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
    if (!summary) {
      if (get().loading) set({ loading: false });
      return;
    }
    // Same numbers, new object: publishing it would re-render the status bar for nothing. The
    // first read still lands, because `loading` changes with it.
    if (!get().loading && sameSummary(get().summary, summary)) return;
    set({ summary, loading: false });
  },

  watch: () => {
    watchers += 1;
    if (watchers === 1) {
      void get().refresh();
      // Gated on visibility rather than on the meter being mounted: `UsageMeter` renders from both
      // of the status bar's branches, so the reference count never reaches zero and this was the
      // one timer in the app that genuinely ran for ever. Each tick is an IPC hop plus a SQLite
      // aggregate behind the global mutex — worth nothing at all while the window is hidden.
      timer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        void get().refresh();
      }, POLL_MS);
      // …and the number has to be right the instant the window comes back, not up to ten seconds
      // later: a hidden window is exactly when an agent turn lands unwatched.
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      watchers -= 1;
      if (watchers === 0 && timer) {
        clearInterval(timer);
        timer = null;
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  },
}));

function onVisibilityChange(): void {
  if (document.visibilityState === "visible" && watchers > 0) {
    void useUsageStore.getState().refresh();
  }
}

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
