/**
 * Keeps Tab inside a dialog, and puts focus back where it came from on the way out.
 *
 * The app ships around sixty modal components and had no focus management at all: Tab from inside
 * one walked straight into the application behind it — the sidebar, the commit list, the terminal —
 * while the backdrop still covered the screen, so the focus ring was on something the user could
 * neither see nor click. For an app whose users live on the keyboard that is a usability bug first
 * and an accessibility one second.
 *
 * Applied at the three shared shells (`ApiModal`, `ConfirmModal`, `PromptModal`) rather than at
 * each dialog, which is what covers nearly all of them from one place.
 *
 * **What it deliberately does not do** is manage Escape. Every dialog already handles that, several
 * of them conditionally (a modal mid-import refuses to close), and a second opinion here would
 * either duplicate or fight those.
 */

import { useEffect, type RefObject } from "react";

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
    (element) => element.offsetParent !== null || element.getClientRects().length > 0,
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

    // Focus the first thing in the dialog, unless something inside it already claimed focus —
    // several of these render an input with `autoFocus`, and stealing it back would put the caret
    // on the close button instead of in the field the user is meant to type in.
    if (!container.contains(document.activeElement)) {
      const first = focusable(container);
      // The container itself as a last resort, so a dialog with no controls at all (a spinner, a
      // read-only report) still takes focus off whatever is behind it.
      (first[0] ?? container).focus?.();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
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
      // Guarded: the element focus came from may have been unmounted while the dialog was open —
      // a row deleted by the very action the dialog confirmed — and `focus()` on a detached node
      // silently does nothing while `isConnected` says so honestly.
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, active]);
}
