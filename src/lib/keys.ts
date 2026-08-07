import { isMac } from "./platform";

/**
 * A key combination, stored as a canonical string: modifiers in a fixed order (`Mod`, `Ctrl`,
 * `Alt`, `Shift`) followed by one base key — `"Mod+Shift+P"`, `"Alt+ArrowLeft"`, `"F5"`.
 *
 * `Mod` is the platform's primary modifier: ⌘ on macOS, Ctrl on Windows/Linux. One binding
 * therefore covers both platforms, which is why bindings are persisted in this form rather
 * than as raw key events. `Ctrl` means the *literal* Control key and only ever appears on
 * macOS, where ⌃ and ⌘ are different keys.
 */
export type Chord = string;

/**
 * How the base key of a chord is decided, which is two rules and not one.
 *
 * **Keys that carry a character — punctuation — are read as the character the user's layout
 * produces** (`KeyboardEvent.key`), not as the position they occupy (`.code`). That is the whole
 * point: on a Spanish keyboard the key beside Enter types `ç`, and the key that types `\` is
 * somewhere else entirely, so "the key at the backslash position" and "the backslash key" are two
 * different keys. Monaco resolves its own keybindings by character, so reading position here meant
 * the app and the editor bound different keys on every non-US layout and the shortcut silently did
 * nothing — see `chordToMonaco`.
 *
 * **Keys that carry no character — letters, digits, arrows, F-keys, the numpad — are read by
 * position** (`.code`). Two reasons. Every layout that reshuffles punctuation (Spanish, Latin
 * American, Portuguese, Italian, UK, German) is still QWERTY, so for letters position and character
 * are the same key and there is nothing to gain; and on macOS `.key` under Option is the *alternate*
 * glyph — `⌥N` reports `˜` — which would record a chord nobody can read back.
 *
 * `CODE_SYMBOLS` survives as the fallback for the layouts and input methods that report no usable
 * character at all.
 */
const CODE_SYMBOLS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const NAMED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Insert",
  "Delete",
  "Backspace",
  "Enter",
  "Escape",
  "Tab",
  "Space",
]);

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "ContextMenu",
]);

/** The base (non-modifier) key of an event, or null if the event is a modifier press on its own
 * — those arrive as their own keydown and must never be treated as a complete chord. */
function baseKey(e: KeyboardEvent): string | null {
  const code = e.code;
  if (code && MODIFIER_CODES.has(code)) return null;

  const key = e.key;
  const printable = !!key && key.length === 1;

  // **By character, first**, for anything that types a symbol. This has to come before the position
  // rules below and not after: on a Spanish layout `/` is ⇧7 and on Latin American `\` is ⌥7, so a
  // `Digit7` test would claim the key before the character it produced was ever looked at — which
  // is how `⌘⇧7` on those keyboards and `⌘/` on a US one ended up as two chords for one keystroke.
  //
  // Option is *not* special-cased here, though macOS does rewrite ⌥+letter into an alternate glyph.
  // Two things already cover it and a guard did more harm than good: on the Latin layouts those
  // glyphs are dead keys (`⌥N` → `˜`, `⌥E` → `´`), which report `key === "Dead"` and are refused
  // below; and the printable ones (`⌥A` → `å`) come out modifier-less once Option is folded into the
  // character, so `isBindable` turns them down. Guarding on `altKey` instead cost the whole Latin
  // American punctuation set — `\ | { } [ ] @ #` all live behind Option there — which is exactly
  // the keys anyone would want to bind.
  if (printable && !/[a-z0-9]/i.test(key) && key !== " ") return key;

  // **By position**, for letters, digits and the keys that carry no character for a layout to move.
  if (code) {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return `Numpad${code.slice(6)}`;
    if (/^F\d{1,2}$/.test(code)) return code;
    if (NAMED_CODES.has(code)) return code;
  }

  // Nothing above matched — some IMEs, remote sessions and exotic keys report no usable `code`.
  // A dead key (`´`, `` ` ``, `¨` on the Latin layouts) is half of a character and says only
  // "Dead", so it is refused rather than guessed at.
  if (key && !["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Dead"].includes(key)) {
    if (key === " ") return "Space";
    return key.length === 1 ? key.toUpperCase() : key;
  }
  return (code && CODE_SYMBOLS[code]) ?? null;
}

/** Whether the chord's base is a symbol rather than a letter, a digit or a named key. */
function isSymbolKey(base: string): boolean {
  return base.length === 1 && !/[A-Z0-9]/.test(base);
}

/**
 * On Windows/Linux layouts that have an AltGr key (Spanish, German, Portuguese…), AltGr reports
 * itself as Ctrl+Alt. Typing `€` (AltGr+E) would otherwise fire any `Mod+Alt+E` binding. Events
 * that both carry the AltGraph modifier *and* produce a printable character are therefore text
 * input, not a shortcut. Real Ctrl+Alt combos don't set AltGraph, so they still work.
 */
function isAltGraphText(e: KeyboardEvent): boolean {
  try {
    return e.getModifierState("AltGraph") && e.key.length === 1;
  } catch {
    return false;
  }
}

/** The chord an event represents, or null if it isn't one (bare modifier, AltGr text input, or a
 * Windows-key combo, which the app deliberately leaves to the OS). */
export function eventToChord(e: KeyboardEvent): Chord | null {
  if (isAltGraphText(e)) return null;
  const mac = isMac();
  if (!mac && e.metaKey) return null;
  const key = baseKey(e);
  if (!key) return null;

  /**
   * On a symbol, the modifiers that *produced* the character are not modifiers at all.
   *
   * On a Spanish layout `/` is literally ⇧7 and `}` is ⌥⇧ of another key; on Latin American, half
   * the punctuation a developer reaches for — `\ | { } [ ] @ #` — is behind Option. Recording those
   * as `Mod+Shift+/` or `Mod+Alt+}` would describe a keystroke that needs Shift (or Option) twice,
   * and would never match the `Mod+/` the same intent produces on a US keyboard. Dropping them is
   * what makes one stored chord mean one keystroke everywhere.
   *
   * Only on macOS for Option: on Windows and Linux, Alt does not change the character, so `Alt+/`
   * there is a real and different chord. (AltGr, which does, is refused outright — see
   * `isAltGraphText`.)
   */
  const symbol = isSymbolKey(key);
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (mac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey && !(symbol && mac)) parts.push("Alt");
  if (e.shiftKey && !symbol) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Whether a chord uses the platform's primary modifier. Chords that don't (`Alt+ArrowLeft`,
 * `F5`) are suppressed while the user is typing — see `useGlobalShortcuts`. */
export function usesMod(chord: Chord): boolean {
  return chord.split("+").includes("Mod");
}

/** Whether the chord's base key is a function key — the one kind that produces no text, which is
 * what lets it be bound bare and fire even with the caret in a field. */
export function isFunctionKey(chord: Chord): boolean {
  const parts = chord.split("+");
  return /^F\d{1,2}$/.test(parts[parts.length - 1]);
}

/** A chord with no modifier at all would swallow ordinary typing, so the recorder rejects it.
 * Function keys are the exception: they produce no text. */
export function isBindable(chord: Chord): boolean {
  const parts = chord.split("+");
  const hasModifier = parts.length > 1 && parts.slice(0, -1).some((p) => p !== "Shift");
  return hasModifier || isFunctionKey(chord);
}

const MAC_MODIFIER_SYMBOLS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const PC_MODIFIER_LABELS: Record<string, string> = { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };

const MAC_KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
  Enter: "↩",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  Space: "Space",
};

const PC_KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
  Tab: "Tab",
  Space: "Space",
};

/** The chord split into keycap labels for display, in the local platform's notation. */
export function chordKeycaps(chord: Chord): string[] {
  const mac = isMac();
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => (mac ? MAC_MODIFIER_SYMBOLS[m] : PC_MODIFIER_LABELS[m]) ?? m);
  const label = (mac ? MAC_KEY_LABELS[key] : PC_KEY_LABELS[key]) ?? key;
  return [...modifiers, label];
}

/** Single-string form of `chordKeycaps`, for tooltips and `title` attributes. */
export function chordLabel(chord: Chord): string {
  return chordKeycaps(chord).join(isMac() ? "" : "+");
}

/** Whether the event landed in something the user is typing into — a form field, a
 * contenteditable, or Monaco. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return !!target.closest(".monaco-editor");
}
