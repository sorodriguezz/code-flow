import { create } from "zustand";
import { aiQuotaStatus, type QuotaTrigger } from "../lib/tauri/commands";
import { onTurnSettled } from "./agentEvents";
import type { ProviderQuota, QuotaLimit } from "../types/domain";

/** How often the quota re-reads while somebody is watching it.
 *
 * A minute, where the spend meter beside it polls every ten seconds, and the difference is what is
 * behind each: that one reads a local SQLite aggregate, this one calls two companies' APIs. The
 * backend caches for the same minute, so a second surface opening does not double the requests. */
const POLL_MS = 60_000;

interface QuotaState {
  providers: ProviderQuota[];
  /** True while a read is in flight, including a refresh over numbers that are already on screen —
   * the refresh button spins off this. What must *not* key off it is the panel body: a correct
   * panel blanked for a second to announce that it is being re-checked is worse than a stale one,
   * so `QuotaLimits` only shows a loading state when `fetched` is still false. */
  loading: boolean;
  /** Whether anything has ever been asked for in this session.
   *
   * This is the whole reason quota is pull and not push. On macOS, reading Claude Code's token
   * means reading *another application's* keychain item, which asks the user for permission the
   * first time. That prompt has to arrive attached to something they just did — opening the
   * panel — and never out of a clear sky at startup. So nothing here fires until a surface asks. */
  fetched: boolean;
  /** When the last read landed, as epoch ms — `0` before the first one. What the "updated N ago"
   * line counts from, and the only durable evidence a refresh happened at all: when every number
   * comes back identical, the timestamp moving is the answer. */
  lastReadAt: number;
  /** `trigger` says who asked. `"refresh"` skips the backend's per-provider cache — without that
   * the button re-reads a cache at most a minute old and hands back the same numbers, which looks
   * like a broken button and is in fact a working cache. `"poll"` additionally forbids starting a
   * provider's CLI, so the background timer never flashes a console window on Windows. */
  refresh: (trigger?: QuotaTrigger) => Promise<void>;
  /** Starts the poll and returns the stop. Reference-counted; only polls once something has
   * already been fetched, so mounting the status bar alone never reaches the network. */
  watch: () => () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let watchers = 0;
let inFlight: Promise<void> | null = null;

/** How long the spinner stays up at minimum.
 *
 * Not decoration. A forced read of four cached-nothing providers can come back in under fifty
 * milliseconds, and a spinner that appears and vanishes inside one frame is indistinguishable from
 * a button that did nothing — which is exactly what the user reported. Half a second is long enough
 * to register as "it went and asked" and short enough not to feel like waiting. */
const MIN_SPIN_MS = 500;

export const useQuotaStore = create<QuotaState>((set, get) => ({
  providers: [],
  loading: false,
  fetched: false,
  lastReadAt: 0,

  refresh: async (trigger: QuotaTrigger = "poll") => {
    // Coalesced: the panel and the settings screen can both be open, and both ask on mount. A
    // forced read is *not* folded into a poll already in flight — that would return the cached
    // answer the button exists to bypass — so it waits for the poll to finish and then goes.
    if (inFlight) {
      if (trigger !== "refresh") return inFlight;
      await inFlight.catch(() => {});
    }
    set({ loading: true });
    const startedAt = Date.now();
    const settle = async () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_SPIN_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS - elapsed));
      }
    };

    inFlight = aiQuotaStatus(trigger)
      .then(async (providers) => {
        await settle();
        set({ providers, loading: false, fetched: true, lastReadAt: Date.now() });
      })
      .catch(async () => {
        // Kept as it was: the backend already falls back to its last good reading per provider, so
        // a rejection here is the IPC hop itself failing. Emptying the panel over that would say
        // "you have no limits", which is the one thing it must never say wrongly. `lastReadAt` is
        // deliberately *not* moved — nothing was read, and the line above it must not claim it was.
        await settle();
        set({ loading: false, fetched: true });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },

  watch: () => {
    watchers += 1;
    if (watchers === 1) {
      timer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        if (!get().fetched) return;
        void get().refresh();
      }, POLL_MS);
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
  const state = useQuotaStore.getState();
  if (document.visibilityState === "visible" && watchers > 0 && state.fetched) {
    void state.refresh();
  }
}

/** A finished agent turn is the one moment the remaining percentage certainly moved. Only refreshes
 * if something has already asked once — a turn must not be what triggers the first keychain
 * prompt. */
onTurnSettled(() => {
  const state = useQuotaStore.getState();
  if (watchers > 0 && state.fetched) void state.refresh();
});

/** Every limit across every provider that reported one, fullest first. */
export function allLimits(providers: ProviderQuota[]): { provider: string; limit: QuotaLimit }[] {
  return providers
    .flatMap((p) => p.limits.map((limit) => ({ provider: p.provider, limit })))
    .sort((a, b) => b.limit.used_percent - a.limit.used_percent);
}

/** One provider's limits with the *slices* dropped — every window that is not already part of
 * another window in the same list.
 *
 * A provider can report one window at two grains. Anthropic publishes the whole week **and** one
 * model's slice of that same week, and the slice is by definition a part of the total sitting next
 * to it. For the panel that is the point; for a single number it is double-counting, and it fails
 * in a specific way: the pill shows the fullest limit, so a model you never touch at 95% of its
 * slice outranks the 40% of the week that is the figure you would actually act on.
 *
 * **The test is "is there a total?", not "is this scoped?"** — those come apart at Gemini, whose
 * every bucket carries its group name as a scope ("Gemini Models", "Claude and GPT models") and
 * which publishes no unscoped weekly row at all. Those groups *are* the whole allowance rather than
 * slices of one, so dropping every scoped row would take Gemini out of the pill entirely. A scoped
 * row is therefore only dropped when the same provider also reports that same `kind` unscoped.
 *
 * Session windows are unaffected: a session is reported unscoped, so it is a total and stays. */
export function wholeWindows(quota: ProviderQuota): QuotaLimit[] {
  const totalled = new Set(quota.limits.filter((limit) => !limit.scope).map((limit) => limit.kind));
  return quota.limits.filter((limit) => !limit.scope || !totalled.has(limit.kind));
}

/** The limit closest to running out — what the status pill shows, because a single number in a
 * status bar can only honestly be the worst one.
 *
 * Which providers are in `providers` at all is decided in the backend: only the ones this install
 * routes work to are asked (see `ai_quota_status`). So the pill cannot be driven by a plan the user
 * does not use, and it stays in agreement with the panel — both draw from the same list, and a pill
 * that filtered providers on its own would eventually disagree with the rows underneath it. */
export function tightestLimit(
  providers: ProviderQuota[],
): { provider: string; limit: QuotaLimit } | null {
  return allLimits(providers.map((quota) => ({ ...quota, limits: wholeWindows(quota) })))[0] ?? null;
}

/** `95%`, `4%`, `0%`. Rounded **up** on purpose, mirroring how it used to round down when it
 * counted the other way: 0.4% consumed should not read as untouched, and the number that matters
 * is never overstated by the rounding of the one below it. */
export function formatUsed(percent: number): string {
  const clamped = Math.min(100, Math.max(0, percent));
  return `${Math.ceil(clamped)}%`;
}

/** `7d 1m`, `5h 1m`, `22h 27m`, `4m`. The provider's reset instant as a countdown, because "resets
 * at 17:00 UTC next Monday" is not a thing anybody reads off a status bar.
 *
 * `null` when there is no instant to count to, or when it has already passed — a window whose reset
 * is in the past has rolled over and the number beside it is about to be replaced anyway. */
export function formatResetIn(resetsAt: string, now: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  const seconds = Math.floor((at - now) / 1000);
  if (seconds <= 0) return null;

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  // Two units at most: the third never changes what the reader does about it.
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `justo ahora`, `hace 4 min`, `hace 2 h` — how old the numbers on screen are.
 *
 * The durable half of the refresh feedback. The spinner says a read is happening; this says one
 * happened, and it is the only thing that changes when every percentage comes back identical —
 * which, on a quiet account, is every single time. `null` before the first read. */
export function ageOf(lastReadAt: number, now: number = Date.now()): "now" | number | null {
  if (!lastReadAt) return null;
  const minutes = Math.floor((now - lastReadAt) / 60_000);
  return minutes < 1 ? "now" : minutes;
}

/** How worried the bar should look, given how much of the window is gone. Thresholds rather than a
 * gradient so the same percentage is always the same colour across the pill, the panel and the
 * settings screen. */
export function severityOf(usedPercent: number): "normal" | "low" | "critical" {
  if (usedPercent >= 90) return "critical";
  if (usedPercent >= 75) return "low";
  return "normal";
}
