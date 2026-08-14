import { create } from "zustand";
import { systemLoad } from "../lib/tauri/commands";
import type { SystemLoad } from "../types/domain";

/**
 * How often the machine is re-read while the window is on screen.
 *
 * **Two and a half seconds, and CPU is why.** Memory and disk barely move; a CPU figure is a
 * *delta* between two refreshes, so the interval is not merely how often the number updates — it
 * is the window the number averages over. At ten seconds a build that takes eight would show up as
 * a gentle rise and be gone before it was read; at half a second the digits flicker and the reading
 * is noise. A few seconds is roughly what every system monitor settles on, for the same reason.
 *
 * It can afford to be that quick because the read is native — `host_statistics` and libproc on
 * macOS, the NT APIs on Windows, `/proc` on Linux — with no subprocess and no network. What it is
 * not is free: the backend walks the whole process table on each one, which is milliseconds. Hence
 * the visibility guard below, which is the difference between a laptop shut in a bag doing this
 * forever and doing it not at all.
 */
const POLL_MS = 2_500;

interface SystemLoadState {
  /** `null` until the first read lands. The status bar draws nothing for it rather than three
   * zeroes: "0% CPU" is a claim, and one that is never true. */
  load: SystemLoad | null;
  refresh: () => Promise<void>;
  /** Starts polling and returns the stop. Reference-counted, like `powerStore` beside it: the
   * status bar renders from two branches and must not end up with two timers. */
  watch: () => () => void;
  /**
   * Says that this app's own CPU/memory share is on screen, and refreshes at once so it is current
   * rather than up to one poll old. Returns the stop, like `watch`.
   *
   * Reference-counted for the same reason `watch` is. The backend only walks the process table —
   * by far the most expensive thing this poll does, and the only part that costs more than two
   * system calls — when somebody is holding one of these, which in practice is the fraction of a
   * session where the pointer is resting on the status bar pills.
   */
  watchDetail: () => () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let watchers = 0;
/** How many callers currently need the app's own share. See `watchDetail`. */
let detailWatchers = 0;

export const useSystemLoadStore = create<SystemLoadState>((set) => ({
  load: null,

  refresh: async () => {
    const load = await systemLoad(detailWatchers > 0).catch(() => null);
    // Never cleared back to `null` on a failed read. A widget that blinks out and back because one
    // refresh lost a race is worse than a widget showing a figure two seconds old.
    if (load) set({ load });
  },

  watchDetail: () => {
    detailWatchers += 1;
    if (detailWatchers === 1) void useSystemLoadStore.getState().refresh();
    return () => {
      detailWatchers -= 1;
    };
  },

  watch: () => {
    watchers += 1;
    if (watchers === 1) {
      void useSystemLoadStore.getState().refresh();
      timer = setInterval(() => {
        // A hidden window has nobody to show a meter to, and the process-table walk is the most
        // expensive poll in the app.
        if (document.visibilityState !== "visible") return;
        void useSystemLoadStore.getState().refresh();
      }, POLL_MS);
      document.addEventListener("visibilitychange", onVisibilityChange);
      // Focus as well as visibility, for the reason `powerStore` documents: on Windows a window can
      // be behind another and still "visible", so alt-tabbing back would otherwise wait out the
      // poll — and coming back is exactly when a stale reading is most noticed.
      window.addEventListener("focus", onWake);
    }
    return () => {
      watchers -= 1;
      if (watchers === 0 && timer) {
        clearInterval(timer);
        timer = null;
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("focus", onWake);
      }
    };
  },
}));

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") onWake();
}

function onWake(): void {
  if (watchers > 0) void useSystemLoadStore.getState().refresh();
}

/**
 * How worried a meter should look at this level.
 *
 * The same three tones the battery and the AI limits use, so one glance across the bar reads by
 * colour without having to know which widget said it. The thresholds count *up* rather than down,
 * and they are deliberately high: a machine at 70% CPU is a machine being used, and a bar that goes
 * amber whenever someone compiles something is a bar that has taught them to ignore it.
 */
export function loadSeverity(percent: number): "normal" | "high" | "critical" {
  if (percent >= 92) return "critical";
  if (percent >= 78) return "high";
  return "normal";
}

/**
 * `3.4 GB`, `812 MB`, `18.0 GB`.
 *
 * Binary units under decimal names, which is what every OS file manager shows and therefore what
 * the reader will compare this against. One decimal below 100 and none above, so the width of the
 * string barely moves while the number does — these sit in a panel of aligned rows.
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
