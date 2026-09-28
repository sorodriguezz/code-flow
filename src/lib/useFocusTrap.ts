/**
 * Keeps Tab inside a dialog, and puts focus back where it came from on the way out.
 *
 * The app ships around sixty modal components and had no focus management at all: Tab from inside
 * one walked straight into the application behind it — the sidebar, the commit list, the terminal —
 * while the backdrop still covered the screen, so the focus ring was on something the user could
 * neither see nor click. For an app whose users live on the keyboard that is a usability bug first
 * and an accessibility one second.
 *
 * Where it is applied: the shared shells (`ApiModal`, `ConfirmModal`, `PromptModal`), which cover
 * every dialog built on them, plus each shell-level dialog that draws its own frame — Settings, the
 * command palette, the shortcuts sheet, the branch switcher, the clone/import/PR/connect dialogs and
 * the rest a `grep -E "useFocusTrap|useDialog"` lists. It is **not** automatic: a dialog that draws
 * its own `fixed inset-0` backdrop has to call this (or `useDialog`), or Tab walks out of it again —
 * several dozen feature dialogs still do not, and each is its own fix.
 *
 * **The layer stack.** Every active trap is a layer, in the order it opened, and only the top one
 * acts. Two traps used to fight over one Tab — a confirmation opened from Settings is a second
 * dialog with Settings still open under it, and Settings' trap pulled the focus back into itself.
 * The same stack answers the two questions a dialog's neighbours have to ask: "is Escape mine?"
 * ([`isTopLayer`]) and "may this app shortcut run behind a dialog?" ([`shortcutBlockedByDialog`]).
 *
 * **What the trap deliberately does not do** is manage Escape. Every dialog already handles that,
 * several of them conditionally (a modal mid-import refuses to close), and a second opinion here
 * would either duplicate or fight those. It only says whose Escape it is — and [`useDialog`] below
 * is the opt-in for a dialog that wants the trap and a top-layer-only Escape in one call.
 */

import { useEffect, useRef, type RefObject } from "react";

/** Every container with an active trap, oldest first. The last one is the dialog on top. */
const layers: HTMLElement[] = [];

/** Puts a dialog on top of the stack; the returned function takes it off again (wherever it is by
 *  then — dialogs do not always close in the order they opened). */
export function pushLayer(element: HTMLElement): () => void {
  layers.push(element);
  return () => {
    const at = layers.lastIndexOf(element);
    if (at !== -1) layers.splice(at, 1);
  };
}

/** Whether `element` is the top-most open dialog — the one Escape and Tab belong to. */
export function isTopLayer(element: HTMLElement | null | undefined): boolean {
  return !!element && layers[layers.length - 1] === element;
}

/** The top-most open dialog, if any. */
export function topLayer(): HTMLElement | null {
  return layers[layers.length - 1] ?? null;
}

/**
 * Whether an app shortcut must stay inert because a dialog is open.
 *
 * A chord pressed with a dialog up used to act on the app *behind* it — ⌘1 switched the view under
 * the clone dialog, ⌘B folded a sidebar nobody could see. The one exception is the chord that
 * toggles the dialog on top, so ⌘, still closes Settings and ⌘⇧P the palette: a dialog names those
 * in `data-shortcut-owner` (space-separated command ids).
 */
export function shortcutBlockedByDialog(commandId: string): boolean {
  const top = topLayer();
  if (!top) return false;
  const owners = top.dataset.shortcutOwner?.split(/\s+/) ?? [];
  return !owners.includes(commandId);
}

/**
 * Everything the platform will focus with Tab.
 *
 * `[tabindex]:not([tabindex="-1"])` rather than `[tabindex]`: an element parked at -1 is one the
 * author made *programmatically* focusable on purpose and kept out of the tab order, and pulling it
 * back in here would undo that decision — the virtualised commit rows are exactly that.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // `offsetParent === null` catches `display: none` and detached subtrees; the rect check catches
    // an element that is present and laid out at zero size, which is how several of these dialogs
    // hide a panel they are animating in.
    //
    // And `tabIndex >= 0`: a button taken out of the tab order on purpose (the palette's rows, which
    // the arrows move through) is still matched by `button` above, and counting it as the last stop
    // let Tab out of the dialog past it.
    (element) =>
      element.tabIndex >= 0 && (element.offsetParent !== null || element.getClientRects().length > 0),
  );
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    // Where focus was before the dialog opened, so it can go back there rather than to the top of
    // the document — which is what makes closing a dialog with the keyboard leave you somewhere
    // you can carry on typing.
    const previous = document.activeElement as HTMLElement | null;
    const popLayer = pushLayer(container);

    // Focus the first thing in the dialog, unless something inside it already claimed focus —
    // several of these render an input with `autoFocus`, and stealing it back would put the caret
    // on the close button instead of in the field the user is meant to type in.
    //
    // `data-no-initial-focus` takes a control out of the running for this one move (Tab still
    // reaches it): the settings window's search box sits before its close button, and a field that
    // took focus on every opening would wear its focus ring every time.
    if (!container.contains(document.activeElement)) {
      const first = focusable(container).filter((element) => !element.hasAttribute("data-no-initial-focus"));
      // The container itself as a last resort, so a dialog with no controls at all (a spinner, a
      // read-only report) still takes focus off whatever is behind it.
      (first[0] ?? container).focus?.();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      // A dialog opened over this one owns the Tab — see the layer stack in the module note.
      if (!isTopLayer(container)) return;
      // Re-read on every Tab rather than caching the list: these dialogs grow and shrink as you
      // use them — a form reveals a field, a list gains a row — and a cached list would send Tab to
      // an element that has since been removed.
      const items = focusable(container);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;

      // Focus outside the dialog entirely — the browser put it there, or a portalled popover
      // closed and dropped it. Either way the next Tab belongs back inside.
      if (!current || !container.contains(current)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      popLayer();
      // Guarded: the element focus came from may have been unmounted while the dialog was open —
      // a row deleted by the very action the dialog confirmed — and `focus()` on a detached node
      // silently does nothing while `isConnected` says so honestly.
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, active]);
}

/**
 * A dialog's keyboard contract in one call: the trap above, plus Escape closing it — but only while
 * it is the top layer, so a confirmation opened from inside it takes the first Escape and the dialog
 * under it the second.
 *
 * Pass `null` for `onEscape` while the dialog must not close (a clone half-way through); the
 * handler reads the latest value at the moment of the key, so a dialog can switch it freely.
 * A key some control inside already handled — a dropdown closing itself — arrives
 * `defaultPrevented` and is left alone.
 */
export function useDialog(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onEscape: (() => void) | null,
): void {
  useFocusTrap(ref, open);
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (!isTopLayer(ref.current)) return;
      const close = latest.current;
      if (!close) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ref, open]);
}
