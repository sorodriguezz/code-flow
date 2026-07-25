import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";

const KEY = "auto_fetch_interval_seconds";
const SECRET_SCAN_KEY = "secret_scan_enabled";
export const MIN_AUTO_FETCH_SECONDS = 10;

interface PreferencesState {
  /** 0 means auto-fetch is disabled. */
  autoFetchSeconds: number;
  /** Whether the pre-commit secret scanner runs before each commit. Defaults to on. */
  secretScanEnabled: boolean;
  init: () => Promise<void>;
  setAutoFetchSeconds: (seconds: number) => Promise<void>;
  setSecretScanEnabled: (enabled: boolean) => Promise<void>;
}

function clamp(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(MIN_AUTO_FETCH_SECONDS, Math.round(seconds));
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  autoFetchSeconds: 0,
  secretScanEnabled: true,

  init: async () => {
    const [raw, scanRaw] = await Promise.all([
      getSetting(KEY).catch(() => null),
      getSetting(SECRET_SCAN_KEY).catch(() => null),
    ]);
    set({
      autoFetchSeconds: raw ? clamp(Number(raw)) : 0,
      // Unset (first run) defaults to enabled — the gate is opt-out, not opt-in.
      secretScanEnabled: scanRaw === null ? true : scanRaw === "true",
    });
  },

  setAutoFetchSeconds: async (seconds) => {
    const value = clamp(seconds);
    set({ autoFetchSeconds: value });
    await setSetting(KEY, String(value));
  },

  setSecretScanEnabled: async (enabled) => {
    set({ secretScanEnabled: enabled });
    await setSetting(SECRET_SCAN_KEY, String(enabled));
  },
}));
