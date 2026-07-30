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

/** Base keys are derived from `KeyboardEvent.code` (physical position) rather than `.key`, so a
 * binding recorded on a Spanish layout still fires on a US one — and vice versa. */
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
  if (code) {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return `Numpad${code.slice(6)}`;
    if (/^F\d{1,2}$/.test(code)) return code;
    if (CODE_SYMBOLS[code]) return CODE_SYMBOLS[code];
    if (NAMED_CODES.has(code)) return code;
  }
  // Layouts and input methods that report no usable `code` (and the odd exotic key) still get a
  // workable binding from `key`.
  const key = e.key;
  if (!key || key.length === 0) return null;
  if (["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Dead"].includes(key)) return null;
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
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

  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (mac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
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
