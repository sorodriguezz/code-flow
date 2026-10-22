import { translate, useLanguageStore } from "../../state/languageStore";
import type { TranslationKey } from "../i18n/translations";

/**
 * The sentences Codi says, in whatever language the app is in right now.
 *
 * Through `translate` rather than a hook: an action runs outside React, once, and is answered in the
 * language of the moment it ran — which is the language the user is speaking to it in.
 */
export function say(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(key, params);
}

/**
 * A short list as it is said aloud: "a, b and c", «a, b y c» — and, past `max`, the first few and how
 * many more, because nobody wants eleven repository names read to them.
 */
export function spokenList(names: readonly string[], max = 4): string {
  const and = useLanguageStore.getState().language === "es" ? " y " : " and ";
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1]}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")}${and}${translate("codi.say.more", { n: rest })}`;
}

/** "a or b", «a o b» — what an ambiguous name is asked back with. */
export function spokenChoice(names: readonly string[], max = 4): string {
  const or = useLanguageStore.getState().language === "es" ? " o " : " or ";
  const shown = names.slice(0, max);
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")}${or}${shown[shown.length - 1]}`;
}
