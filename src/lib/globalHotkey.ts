/**
 * The quick-ask hotkey as the operating system sees it — an *accelerator* in the global-shortcut
 * plugin's vocabulary (`Alt+Space`, `Ctrl+Alt+Space`, `Cmd+Shift+K`), not an app chord.
 *
 * Its own module because the two vocabularies differ where it matters. App chords (`lib/keys.ts`)
 * are read by character, so `⌘/` means the key that types `/` on this layout, and they say `Mod`
 * for "⌘ here, Ctrl there". A global hotkey is registered with the system by physical key and names
 * its modifiers literally, so recording one goes by `KeyboardEvent.code` and writes what was held.
 */

/** What a recorder needs from a key event. */
export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Physical keys by `code`, named the way the plugin parses them. */
const NAMED: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
};

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

/**
 * The accelerator a key press records, or `null` for one that cannot be a global hotkey.
 *
 * It needs Ctrl, Alt or ⌘ — or a function key — because a hotkey on a bare key, or on Shift and a
 * letter, would take that key away from every application on the machine for as long as CodeFlow
 * runs. On macOS ⌘ is `Cmd`; elsewhere the Windows key is `Super`.
 */
export function acceleratorFromKey(event: KeyLike, mac: boolean): string | null {
  const key = keyName(event.code);
  if (!key) return null;
  const strong = event.ctrlKey || event.altKey || event.metaKey;
  if (!strong && !/^F\d+$/.test(key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push(mac ? "Cmd" : "Super");
  parts.push(key);
  return parts.join("+");
}

const MAC_SYMBOLS: Record<string, string> = {
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  cmd: "⌘",
  command: "⌘",
  super: "⌘",
  cmdorctrl: "⌘",
  commandorcontrol: "⌘",
};
const PC_NAMES: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  cmd: "Win",
  command: "Win",
  super: "Win",
  cmdorctrl: "Ctrl",
  commandorcontrol: "Ctrl",
};

/** The key caps an accelerator is drawn with — `⌥ Space` on a Mac, `Ctrl Alt Space` elsewhere. */
export function acceleratorKeycaps(accelerator: string, mac: boolean): string[] {
  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);
  return parts.map((part, i) => {
    if (i === parts.length - 1) return part.length === 1 ? part.toUpperCase() : part;
    const lower = part.toLowerCase();
    return (mac ? MAC_SYMBOLS[lower] : PC_NAMES[lower]) ?? part;
  });
}
