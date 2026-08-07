import type { Monaco } from "@monaco-editor/react";
import type { Chord } from "./keys";

/**
 * Translates one of this app's [`Chord`]s into the integer Monaco wants for a keybinding.
 *
 * The two notations describe the same thing and agree on almost nothing. A chord is a canonical
 * string built from `KeyboardEvent.code` — physical key position, so a binding recorded on a
 * Spanish layout fires on a US one — while Monaco takes a bitmask of its own `KeyMod`/`KeyCode`
 * enums. This is the only place the two meet, which is what lets the settings screen stay in the
 * app's notation and know nothing about the editor.
 *
 * `null` for anything Monaco has no code for. Refusing is the point: a chord that silently mapped
 * to the wrong key would be a rebinding that appears to work in settings and does something else in
 * the editor, which is worse than one the pane can say it cannot apply.
 */
export function chordToMonaco(chord: Chord, monaco: Monaco): number | null {
  const parts = chord.split("+");
  const base = parts.pop();
  if (!base) return null;

  let mask = 0;
  for (const part of parts) {
    switch (part) {
      // `CtrlCmd` is Monaco's own platform-primary modifier — ⌘ on macOS, Ctrl elsewhere — which
      // is exactly what `Mod` means here. `WinCtrl` is the literal Control key, which is what this
      // app calls `Ctrl` and only ever appears on macOS.
      case "Mod":
        mask |= monaco.KeyMod.CtrlCmd;
        break;
      case "Ctrl":
        mask |= monaco.KeyMod.WinCtrl;
        break;
      case "Alt":
        mask |= monaco.KeyMod.Alt;
        break;
      case "Shift":
        mask |= monaco.KeyMod.Shift;
        break;
      default:
        return null;
    }
  }

  // A symbol that a US keyboard makes with Shift is, to Monaco, the unshifted key plus Shift —
  // `}` is `⇧]`. The chord carries only the character, because on the layout the user actually has
  // it may take Option, or nothing, or a different key entirely; Monaco resolves the pair against
  // the live keyboard mapping, which is the whole reason to hand it the pair rather than a
  // keystroke. See `SHIFTED_SYMBOLS`.
  const shifted = SHIFTED_SYMBOLS[base];
  if (shifted) {
    const code = baseKeyCode(shifted, monaco);
    return code === null ? null : mask | monaco.KeyMod.Shift | code;
  }

  const code = baseKeyCode(base, monaco);
  return code === null ? null : mask | code;
}

/**
 * The symbols Monaco has no key code for, and the unshifted key each one sits on.
 *
 * Monaco's `KeyCode` names the *key*, not the character — there is a `BracketRight` and no `}`.
 * Without this table every one of these was refused, which on a Latin American keyboard rules out
 * most of the punctuation anyone would reach for: `{ } [ ] | @ #` are all behind Option there, and
 * `?` `:` `"` behind Shift on every layout.
 */
const SHIFTED_SYMBOLS: Record<string, string> = {
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "+": "=",
  _: "-",
  "~": "`",
};

/** The base key, which is where the two notations diverge most: letters and digits are named, the
 * punctuation Monaco knows is spelled out in words, and everything else is a named key. */
function baseKeyCode(base: string, monaco: Monaco): number | null {
  const K = monaco.KeyCode;

  if (/^[A-Za-z]$/.test(base)) {
    return K[`Key${base.toUpperCase()}` as keyof typeof K] as number;
  }
  if (/^[0-9]$/.test(base)) {
    return K[`Digit${base}` as keyof typeof K] as number;
  }
  if (/^F([1-9]|1[0-9])$/.test(base)) {
    return K[base as keyof typeof K] as number;
  }

  const named: Record<string, number> = {
    // The punctuation Monaco has a code for. Each entry is *the key that types this character on
    // the current layout* — Monaco resolves these through the OS keyboard mapping, which is the
    // same thing `baseKey` records, so the two agree on a Spanish keyboard as well as a US one.
    "-": K.Minus,
    "=": K.Equal,
    "[": K.BracketLeft,
    "]": K.BracketRight,
    "\\": K.Backslash,
    ";": K.Semicolon,
    "'": K.Quote,
    "`": K.Backquote,
    ",": K.Comma,
    ".": K.Period,
    "/": K.Slash,
    ArrowLeft: K.LeftArrow,
    ArrowRight: K.RightArrow,
    ArrowUp: K.UpArrow,
    ArrowDown: K.DownArrow,
    PageUp: K.PageUp,
    PageDown: K.PageDown,
    Home: K.Home,
    End: K.End,
    Insert: K.Insert,
    Delete: K.Delete,
    Backspace: K.Backspace,
    Enter: K.Enter,
    Escape: K.Escape,
    Tab: K.Tab,
    Space: K.Space,
  };
  return named[base] ?? null;
}
