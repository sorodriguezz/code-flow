import { useEffect, type RefObject } from "react";
import { isMac } from "./platform";

type FindKeystroke = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "defaultPrevented" | "target">;

/** Whether a keystroke is the find chord a view should answer: ⌘F on macOS, Ctrl+F elsewhere,
 *  nothing else held, not already handled, and not inside a code editor or a terminal — those have
 *  their own find. */
export function isViewFind(event: FindKeystroke, mac: boolean): boolean {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.shiftKey || event.altKey || event.defaultPrevented || event.key.toLowerCase() !== "f") return false;
  const target = event.target;
  return !(typeof Element !== "undefined" && target instanceof Element && target.closest(".monaco-editor, .xterm"));
}

/**
 * ⌘F / Ctrl+F focuses a view's own search box instead of the webview's find bar — which searches
 * the page's text and knows nothing of a drawing's tables (user report, 2026-10-05: Ctrl+F over the
 * DBML canvas opened the browser's find on Windows). Only while the box is on screen, so a view kept
 * mounted behind another never takes the chord.
 */
export function useFindShortcut(field: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const input = field.current;
      if (!input || input.offsetParent === null || !isViewFind(event, isMac())) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [field]);
}
