import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import type { ThemePreference } from "../types/domain";

interface ThemeState {
  preference: ThemePreference;
  resolved: "light" | "dark";
  init: () => Promise<void>;
  setPreference: (pref: ThemePreference) => Promise<void>;
}

const SETTING_KEY = "theme_preference";

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function resolve(pref: ThemePreference): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

function applyToDocument(resolved: "light" | "dark") {
  document.documentElement.dataset.theme = resolved;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: "system",
  resolved: resolve("system"),

  init: async () => {
    const stored = (await getSetting(SETTING_KEY).catch(() => null)) as ThemePreference | null;
    const preference = stored ?? "system";
    const resolved = resolve(preference);
    applyToDocument(resolved);
    set({ preference, resolved });

    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (get().preference === "system") {
        const next = resolve("system");
        applyToDocument(next);
        set({ resolved: next });
      }
    });
  },

  setPreference: async (preference) => {
    const resolved = resolve(preference);
    applyToDocument(resolved);
    set({ preference, resolved });
    await setSetting(SETTING_KEY, preference);
  },
}));
