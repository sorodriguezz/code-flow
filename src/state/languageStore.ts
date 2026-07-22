import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { translations, type Language, type TranslationKey } from "../lib/i18n/translations";

const KEY = "app_language";

interface LanguageState {
  language: Language;
  init: () => Promise<void>;
  setLanguage: (lang: Language) => Promise<void>;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: "en",

  init: async () => {
    const stored = await getSetting(KEY).catch(() => null);
    if (stored === "en" || stored === "es") set({ language: stored });
  },

  setLanguage: async (language) => {
    set({ language });
    await setSetting(KEY, language);
  },
}));

export function useT() {
  const language = useLanguageStore((s) => s.language);
  return (key: TranslationKey, params?: Record<string, string | number>) => {
    const raw = translations[language][key] ?? translations.en[key] ?? key;
    if (!params) return raw;
    return Object.entries(params).reduce<string>(
      (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
      raw,
    );
  };
}
