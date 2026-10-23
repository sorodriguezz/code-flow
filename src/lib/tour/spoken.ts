import { isMac } from "../platform";
import type { Chord } from "../keys";
import type { TranslationKey } from "../i18n/translations";
import type { TourStep } from "./steps";

/**
 * A tour card as Codi says it aloud — the card's title and body with what is drawn on the card and
 * cannot be said turned into words: the copy's marks (`**`, `*`, backticks) dropped, a chord read
 * as its keys («Comando Mayúsculas L», not «⌘⇧L»), arrows and dashes made pauses.
 */

type Language = "es" | "en";

const MODIFIERS: Record<string, { mac: Record<Language, string>; pc: Record<Language, string> }> = {
  Mod: { mac: { es: "Comando", en: "Command" }, pc: { es: "Control", en: "Control" } },
  Ctrl: { mac: { es: "Control", en: "Control" }, pc: { es: "Control", en: "Control" } },
  Alt: { mac: { es: "Opción", en: "Option" }, pc: { es: "Alt", en: "Alt" } },
  Shift: { mac: { es: "Mayúsculas", en: "Shift" }, pc: { es: "Mayúsculas", en: "Shift" } },
};

const KEYS: Record<string, Record<Language, string>> = {
  ArrowLeft: { es: "flecha izquierda", en: "left arrow" },
  ArrowRight: { es: "flecha derecha", en: "right arrow" },
  ArrowUp: { es: "flecha arriba", en: "up arrow" },
  ArrowDown: { es: "flecha abajo", en: "down arrow" },
  Enter: { es: "Enter", en: "Enter" },
  Escape: { es: "Escape", en: "Escape" },
  Space: { es: "Espacio", en: "Space" },
  Backspace: { es: "Retroceso", en: "Backspace" },
  Delete: { es: "Suprimir", en: "Delete" },
  Tab: { es: "Tabulador", en: "Tab" },
  PageUp: { es: "Re Pág", en: "Page Up" },
  PageDown: { es: "Av Pág", en: "Page Down" },
};

/** A chord as it is said: its keys in words, in the running platform's names. */
export function spokenChord(chord: Chord, language: Language, mac = isMac()): string {
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => MODIFIERS[m]?.[mac ? "mac" : "pc"][language] ?? m);
  return [...modifiers, KEYS[key]?.[language] ?? key].join(" ");
}

/** The symbols the copy writes that a voice cannot read, in words. */
function symbols(language: Language, mac: boolean): [RegExp, string][] {
  const word = (m: string) => MODIFIERS[m][mac ? "mac" : "pc"][language];
  return [
    [/⌘/g, ` ${word("Mod")} `],
    [/⌥/g, ` ${word("Alt")} `],
    [/⇧/g, ` ${word("Shift")} `],
    [/⌃/g, ` ${word("Ctrl")} `],
    [/[↵⏎↩]/g, " Enter "],
    // «el ⋮ de cada fila»: the row's menu.
    [/[⋮⋯]/g, language === "es" ? "menú" : "menu"],
    // «Configuración → Pipelines», «Voz y sonido › Codi», an aside set off by dashes: pauses.
    [/\s*[→›]\s*/g, ", "],
    [/\s*[—–]\s*/g, ", "],
    // «Shift+Enter»: the keys, one after the other.
    [/(\w)\+(\w)/g, "$1 $2"],
    // An API client variable, `{{nombre}}`.
    [/\{\{\s*([^}]+?)\s*\}\}/g, language === "es" ? "$1 entre llaves dobles" : "$1 in double braces"],
  ];
}

/** `text` with the copy's marks dropped and its symbols in words. */
export function spokenText(text: string, language: Language, mac = isMac()): string {
  let out = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*\s][^*]*)\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  for (const [pattern, words] of symbols(language, mac)) out = out.replace(pattern, words);
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/([(¿¡])\s+/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/([(¿¡])\s*,\s*/g, "$1")
    .replace(/^,\s*/, "")
    .trim();
}

/** One step as Codi says it: the title, then the body, the chord it names in words. */
export function spokenStep(
  step: TourStep,
  translate: (key: TranslationKey, params?: Record<string, string | number>) => string,
  language: Language,
  mac = isMac(),
): string {
  const title = spokenText(translate(step.titleKey), language, mac);
  const body = spokenText(translate(step.bodyKey, step.chord ? { key: spokenChord(step.chord, language, mac) } : undefined), language, mac);
  const end = /[.!?…]$/.test(title) ? "" : ".";
  return `${title}${end} ${body}`.trim();
}
