import { useMemo } from "react";
import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { loadLanguage, translations, type Language, type TranslationKey } from "../lib/i18n/translations";

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
    if (stored !== "en" && stored !== "es") return;
    // Before the flip, never after. Only English is compiled in (see `translations.ts`); flipping
    // first would let `useT`'s memoised closure be rebuilt against a dictionary that is still
    // empty, and every label in the app would render in English and then swap a tick later.
    await loadLanguage(stored);
    set({ language: stored });
  },

  setLanguage: async (language) => {
    await loadLanguage(language);
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

/**
 * The translator, stable for as long as the language is.
 *
 * The identity matters as much as the result: `useT` is called in ~200 components, and a fresh
 * closure per render silently defeats every `useMemo`/`useCallback`/`memo` that has `t` anywhere
 * in its dependency chain — which is most of them, since almost every label goes through it.
 * Three call sites had already hand-rolled a `tRef` to work around it (EditorView, EditorPane,
 * FileTree); those refs stay correct, they are just no longer load-bearing.
 *
 * Memoising is only safe because `render` reads nothing mutable beyond `language`: `translations`
 * is a frozen-by-convention module constant, so a cached closure can never hand back a stale
 * string. If `render` ever grows another reactive input (a per-workspace override, a pluraliser
 * that reads a locale), it has to join this dependency array or the UI will keep the old wording
 * after a switch.
 */
/**
 * The translator's type, for components that take `t` as a prop.
 *
 * Named rather than re-declared inline at each call site: a sub-component that types it as
 * `(key: TranslationKey) => string` compiles fine and then silently cannot pass interpolation
 * params, which is how a row ends up rendering "{n} edited" verbatim.
 */
export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function useT(): Translate {
  const language = useLanguageStore((s) => s.language);
  return useMemo(
    () => (key: TranslationKey, params?: Record<string, string | number>) => render(language, key, params),
    [language],
  );
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
