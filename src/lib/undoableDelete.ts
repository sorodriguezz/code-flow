import { translate } from "../state/languageStore";
import { useToastStore } from "../state/toastStore";

/** How long a deletion can be taken back. */
export const UNDO_WINDOW_MS = 8_000;

/**
 * Deletes something the way a person expects after a mistake: it vanishes at once, a card says so with
 * an "Undo", and only when that window closes is it really gone.
 *
 * Instead of asking "are you sure?" *before* — a dialog people confirm by reflex — this lets them act
 * and takes the cost of being wrong down to one click. Nothing is deleted for real until the window
 * ends, so quitting inside it loses nothing: the thing is simply still there next time.
 *
 * - `hide` takes it out of what is on screen. It must not delete anything.
 * - `restore` puts it back exactly where it was.
 * - `commit` is the real deletion, run once the window closes untouched.
 */
export function deleteWithUndo(options: {
  message: string;
  hide: () => void;
  restore: () => void;
  commit: () => void | Promise<void>;
}): void {
  options.hide();
  let undone = false;
  const timer = setTimeout(() => {
    if (!undone) void Promise.resolve(options.commit()).catch(() => undefined);
  }, UNDO_WINDOW_MS);
  useToastStore.getState().pushToast(options.message, "info", {
    lifetimeMs: UNDO_WINDOW_MS,
    action: {
      label: translate("common.undo"),
      run: () => {
        undone = true;
        clearTimeout(timer);
        options.restore();
      },
    },
  });
}
