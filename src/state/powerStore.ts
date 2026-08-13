import { create } from "zustand";
import { powerStatus } from "../lib/tauri/commands";
import type { PowerStatus } from "../types/domain";

/** How often the battery re-reads while the window is on screen.
 *
 * **Five seconds, and the level is not why.** A battery moves by well under a percent a minute, so
 * for the *number* a minute would do. What a minute does not do is answer the plug: connecting the
 * cable is a discrete thing the user just did with their hands, and a widget that takes up to a
 * minute to acknowledge it reads as broken — which is exactly how it was reported, by someone who
 * found that minimising the window fixed it (that fires `visibilitychange`, which refreshes at
 * once). There is no OS event behind this; it is a poll, so the poll has to be quick enough to pass
 * for one.
 *
 * It can afford to be, where the AI quota cannot: this is a native read with no subprocess and no
 * network — an IOKit query on macOS, `GetSystemPowerStatus` on Windows, a sysfs read on Linux. It
 * costs microseconds and nobody's rate limit. */
const POLL_MS = 5_000;

interface PowerState {
  /** `null` for a machine with no battery — a desktop — and until the first read lands. Both draw
   * nothing, which is the point: the two cases are indistinguishable to a reader and there is no
   * value in telling them apart on screen. */
  status: PowerStatus | null;
  refresh: () => Promise<void>;
  /** Starts polling and returns the stop. Reference-counted, since the status bar renders from two
   * branches and must not end up with two timers. */
  watch: () => () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let watchers = 0;

export const usePowerStore = create<PowerState>((set) => ({
  status: null,

  refresh: async () => {
    const status = await powerStatus().catch(() => null);
    set({ status });
  },

  watch: () => {
    watchers += 1;
    if (watchers === 1) {
      void usePowerStore.getState().refresh();
      timer = setInterval(() => {
        // A hidden window has nobody to show a battery to, and a laptop asleep in a bag is exactly
        // when a timer that keeps firing is worth the least.
        if (document.visibilityState !== "visible") return;
        void usePowerStore.getState().refresh();
      }, POLL_MS);
      document.addEventListener("visibilitychange", onVisibilityChange);
      // Focus as well as visibility, because they are not the same event and only one of them
      // fires when the user comes back from another application: on Windows in particular a window
      // can be behind another and still "visible", so alt-tabbing back would otherwise wait out the
      // poll. Coming back to the app is the moment a stale reading is most likely and most noticed.
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
  // Coming back is when the reading is most certainly stale: the machine may have been unplugged,
  // or asleep, since the last tick.
  if (document.visibilityState === "visible") onWake();
}

function onWake(): void {
  if (watchers > 0) void usePowerStore.getState().refresh();
}

/** How worried the icon should look. The thresholds are the battery's own, not the quota meter's —
 * these count *down* — but the colours are deliberately the same three, so one glance at the status
 * bar reads by colour without having to know which widget it came from. */
export function batterySeverity(percent: number, pluggedIn: boolean): "normal" | "low" | "critical" {
  // Plugged in, nothing is running out: a machine on the mains at 8% is filling, not emptying, and
  // painting it red would be an alarm about a situation that is already being handled.
  if (pluggedIn) return "normal";
  if (percent <= 10) return "critical";
  if (percent <= 20) return "low";
  return "normal";
}

/** `2 h 15 min`, `45 min`. The runway, for the tooltip — never the pill, which has room for one
 * number and it is the percentage. */
export function formatRunway(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}
