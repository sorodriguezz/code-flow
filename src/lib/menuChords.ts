import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The four ⌘-chords the macOS menu takes before the page sees them, given back to the page.
 *
 * Under Tauri's multiwebview every window's webview is a child webview, and wry sends a child's
 * ⌘-key events to the menu instead of to the page (see the note in `appmenu.rs`). For Cut, Copy
 * and Paste that is harmless — AppKit's `copy:` fires the DOM clipboard events everything here
 * listens for. For these four it is not: ⌘Z and ⌘A did nothing in Monaco, ⌘⇧Z neither, and ⌘W
 * closed the window instead of the editor tab. So the menu's items for them are the app's own, and
 * `appmenu::forward_chord` calls `window.__codeflowMenuChord` in the focused webview, which ends
 * up here.
 *
 * What happens then is what would have happened had the key arrived:
 *
 * 1. **A registered handler**, for a surface that cannot be reached by a replayed key. Monaco is
 *    the one (`monacoSetup.ts`): it reads `keyCode`, which a constructed `KeyboardEvent` cannot
 *    carry, so the command is triggered on the focused editor directly.
 * 2. **The keystroke, replayed** on the focused element — `keydown` with ⌘ held, bubbling — so every
 *    listener that already answers the real one answers this too: a field with its own history
 *    (`useTextHistory`), the app's shortcuts (⌘W closes the editor tab), a canvas's undo.
 * 3. **The native action**, when nobody took it: `execCommand` in a plain field, closing the
 *    window for ⌘W — the predefined item's behaviour.
 */

export type MenuChord = "undo" | "redo" | "selectAll" | "closeWindow";

/** Takes `chord` aimed at `target` and says whether it did; `false` lets the next one try. */
export type MenuChordHandler = (chord: MenuChord, target: Element) => boolean;

const handlers: MenuChordHandler[] = [];

/** Puts `handler` ahead of the replayed keystroke. Returns its removal. */
export function addMenuChordHandler(handler: MenuChordHandler): () => void {
  handlers.push(handler);
  return () => {
    const at = handlers.indexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}

/** The keystroke each chord replays: ⌘ plus this key, by position like a real one. */
const KEYS: Record<MenuChord, { key: string; code: string; shift: boolean }> = {
  undo: { key: "z", code: "KeyZ", shift: false },
  redo: { key: "z", code: "KeyZ", shift: true },
  selectAll: { key: "a", code: "KeyA", shift: false },
  closeWindow: { key: "w", code: "KeyW", shift: false },
};

export function isMenuChord(value: unknown): value is MenuChord {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(KEYS, value);
}

/** The `keydown` a chord is replayed as: ⌘ and its key, bubbling and cancellable like a real one. */
export function replayedKeystroke(chord: MenuChord): KeyboardEventInit {
  const { key, code, shift } = KEYS[chord];
  return { key, code, metaKey: true, shiftKey: shift, bubbles: true, cancelable: true, composed: true };
}

export function runMenuChord(chord: MenuChord): void {
  const target = document.activeElement ?? document.body;
  for (const handler of handlers) {
    if (handler(chord, target)) return;
  }

  const event = new KeyboardEvent("keydown", replayedKeystroke(chord));
  target.dispatchEvent(event);
  if (event.defaultPrevented) return;

  if (chord === "closeWindow") {
    void getCurrentWindow()
      .close()
      .catch(() => {});
    return;
  }
  document.execCommand(chord);
}

declare global {
  interface Window {
    /** Called by `appmenu::forward_chord`. */
    __codeflowMenuChord?: (chord: string) => void;
  }
}

export function startMenuChords(): void {
  window.__codeflowMenuChord = (chord) => {
    if (isMenuChord(chord)) runMenuChord(chord);
  };
}
