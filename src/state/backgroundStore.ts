import { create } from "zustand";
import { backgroundStatus, backgroundStop, onBackgroundChanged, type BackgroundStatus } from "../lib/tauri/backgroundCommands";
import { pushErrorToast } from "./toastStore";

/**
 * What runs in the background for CodeFlow — model servers, models held in memory, a vectorizing
 * pass, Codi's microphone — for the status bar's «motores» marker (`EnginesActivity`).
 *
 * **Pushed, not polled.** The backend emits `background:changed` whenever a server starts or stops
 * and on every vectorizing batch; this store re-reads then. A slow refresh (every 30 s, visible
 * windows only) catches a server that died without a word. The per-process figures and the walk for
 * servers nobody here started are asked for only while the panel is open (`watchDetail`), every 2 s.
 */
interface BackgroundState {
  status: BackgroundStatus | null;
  refresh: () => Promise<void>;
  watch: () => () => void;
  watchDetail: () => () => void;
  stop: (pid: number) => Promise<void>;
}

const SLOW_MS = 30_000;
const DETAIL_MS = 2_000;

let watchers = 0;
let detailWatchers = 0;
let slow: ReturnType<typeof setInterval> | null = null;
let fast: ReturnType<typeof setInterval> | null = null;
let unlisten: (() => void) | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

export const useBackgroundStore = create<BackgroundState>((set, get) => ({
  status: null,

  refresh: async () => {
    const status = await backgroundStatus(detailWatchers > 0).catch(() => null);
    if (status) set({ status });
  },

  watch: () => {
    watchers += 1;
    if (watchers === 1) {
      void get().refresh();
      // A burst of changes (a vectorizing pass reports every batch) is one read.
      void onBackgroundChanged(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          void get().refresh();
        }, 150);
      }).then((stop) => {
        if (watchers === 0) stop();
        else unlisten = stop;
      });
      slow = setInterval(() => {
        if (document.visibilityState === "visible") void get().refresh();
      }, SLOW_MS);
    }
    return () => {
      watchers -= 1;
      if (watchers > 0) return;
      unlisten?.();
      unlisten = null;
      if (slow) clearInterval(slow);
      slow = null;
    };
  },

  watchDetail: () => {
    detailWatchers += 1;
    if (detailWatchers === 1) {
      void get().refresh();
      fast = setInterval(() => void get().refresh(), DETAIL_MS);
    }
    return () => {
      detailWatchers -= 1;
      if (detailWatchers > 0) return;
      if (fast) clearInterval(fast);
      fast = null;
      // Back to the cheap reading, so the panel's figures do not linger as if current.
      void get().refresh();
    };
  },

  stop: async (pid) => {
    try {
      await backgroundStop(pid);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },
}));
