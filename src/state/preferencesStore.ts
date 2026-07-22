import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";

const KEY = "auto_fetch_interval_seconds";
export const MIN_AUTO_FETCH_SECONDS = 10;

interface PreferencesState {
  /** 0 means auto-fetch is disabled. */
  autoFetchSeconds: number;
  init: () => Promise<void>;
  setAutoFetchSeconds: (seconds: number) => Promise<void>;
}

function clamp(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(MIN_AUTO_FETCH_SECONDS, Math.round(seconds));
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  autoFetchSeconds: 0,

  init: async () => {
    const raw = await getSetting(KEY).catch(() => null);
    set({ autoFetchSeconds: raw ? clamp(Number(raw)) : 0 });
  },

  setAutoFetchSeconds: async (seconds) => {
    const value = clamp(seconds);
    set({ autoFetchSeconds: value });
    await setSetting(KEY, String(value));
  },
}));
