/**
 * Swallows the webview's own context menu, so the only thing a right-click can open is one of the
 * app's.
 *
 * This window is not a browser tab, but the webview inside it still believes it is one: right-click
 * anywhere the app hasn't claimed and the platform offers *its* menu — Reload, Back, Forward, Save
 * as, Print, Inspect Element. Every one of those either does nothing meaningful here or is actively
 * destructive: "Reload" throws away unsaved editors and every open terminal session, and "Back" has
 * nowhere to go, because this window has no history, no address bar and no tab to close.
 *
 * One document-level listener rather than an `onContextMenu` on every component, for the same
 * reason as `externalLinks`: the surfaces that leak the native menu are precisely the ones no
 * component of ours wraps — a diff gutter, the padding around a panel, markdown rendered from a
 * model through `dangerouslySetInnerHTML`.
 *
 * The listener runs in the **bubble** phase and stands down the moment it sees `defaultPrevented`.
 * That single check is what keeps every real menu alive without listing them here: the app's own
 * `ContextMenu` triggers all call `preventDefault`, Monaco calls it before drawing its editor menu,
 * and noVNC calls it before forwarding the click to the remote desktop. Anything that reaches this
 * handler unclaimed is, by definition, a right-click the app had no answer for.
 */

/** `<input>` types you can actually put a caret in. The rest — checkbox, range, file, color — have
 *  nothing to cut, copy or paste, so the platform menu on them is the browser menu again. */
const TEXT_INPUTS = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Editors that paint their own surface and keep a hidden `<textarea>` underneath to catch the
 *  keyboard. The textarea is a text field by every test below, but nobody is typing *into* it, and
 *  the menu it would raise belongs to a control the user cannot see. Monaco only lands here when it
 *  was configured with `contextmenu: false` — with the menu on, it has already claimed the event —
 *  and xterm's paste never fires from a menu anyway, which is why the terminal wires clipboard
 *  keys by hand. */
const HIDDEN_INPUT_SURFACE = ".monaco-editor, .xterm";

function isTextField(node: Element): boolean {
  if (node instanceof HTMLTextAreaElement) return true;
  if (node instanceof HTMLInputElement) return TEXT_INPUTS.has(node.type);
  return node instanceof HTMLElement && node.isContentEditable;
}

export function startContextMenuGuard() {
  document.addEventListener("contextmenu", (event) => {
    // Someone upstream already answered this right-click with a menu of their own.
    if (event.defaultPrevented) return;

    const target = event.target;
    if (target instanceof Element && isTextField(target) && !target.closest(HIDDEN_INPUT_SURFACE)) {
      // A real text field, and the app has no editing menu of its own to put here. What the
      // platform offers on one of these is Cut/Copy/Paste — the OS editing menu, not the browser's
      // — and taking it away would leave right-click-paste working in every other app on the
      // machine but not in this one, on the 150-odd fields where a token or a URL gets pasted.
      return;
    }

    event.preventDefault();
  });
}
