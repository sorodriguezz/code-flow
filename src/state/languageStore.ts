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

function render(
  language: Language,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const raw = translations[language][key] ?? translations.en[key] ?? key;
  if (!params) return raw;
  return Object.entries(params).reduce<string>(
    (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
    raw,
  );
}

export function useT() {
  const language = useLanguageStore((s) => s.language);
  return (key: TranslationKey, params?: Record<string, string | number>) => render(language, key, params);
}

/**
 * Translation for code that can't call a hook — pure modules that nonetheless emit text a user
 * reads, like the note the code generator prepends to a snippet it can't fully express.
 *
 * Reads the same store `useT` renders from, so it stays in sync; it just doesn't subscribe.
 * That's fine for one-shot generation, and wrong for anything rendered: a component using this
 * would keep the old language after a switch. Use `useT` in components.
 */
export function translate(key: TranslationKey, params?: Record<string, string | number>): string {
  return render(useLanguageStore.getState().language, key, params);
}
