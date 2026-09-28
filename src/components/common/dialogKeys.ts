/**
 * What Enter and Escape do in the confirmation dialog, decided without a DOM.
 *
 * The dialog used to answer Enter from a window listener, unconditionally: `Enter → respond(true)`.
 * That listener runs before the focused button's own activation, so Tab to "Cancel" and Enter
 * *confirmed* — on a dialog that asks before deleting a branch, discarding changes or resetting the
 * app's data. The rule now: a focused control answers for itself (the browser turns Enter on a
 * button into its click), and only a dialog with nothing interactive focused falls back to its
 * default answer. Which control starts focused is the other half, and lives in `ConfirmModal`: a
 * destructive question opens on Cancel, so a reflex Enter keeps what it was about to destroy.
 */

/** Where the focus is when a key reaches the dialog. */
export type FocusPlace =
  /** On a button, a field or a link inside the dialog — it handles its own Enter. */
  | "control"
  /** On the dialog itself, on its text, or on nothing at all. */
  | "inert"
  /** On something behind the dialog. The focus trap keeps this from happening; if it ever does,
   *  the key must not reach whatever that is. */
  | "outside";

export type ConfirmKeyAction =
  | { kind: "cancel" }
  | { kind: "confirm" }
  | { kind: "pick"; id: string }
  /** Leave the key alone: the focused control acts on it itself. */
  | { kind: "native" }
  /** Swallow the key: acting on it would act behind the dialog. */
  | { kind: "block" }
  /** Not a key this dialog answers. */
  | { kind: "ignore" };

export function confirmKeyAction(
  key: string,
  place: FocusPlace,
  choices?: readonly { id: string }[],
): ConfirmKeyAction {
  if (key === "Escape") return { kind: "cancel" };
  if (key !== "Enter") return { kind: "ignore" };
  if (place === "control") return { kind: "native" };
  if (place === "outside") return { kind: "block" };
  // Nothing interactive has the focus, so Enter means the dialog's default answer. With several
  // answers that is the first — the one that loses nothing, by the contract of `chooseAction`.
  if (choices && choices.length > 0) return { kind: "pick", id: choices[0].id };
  return { kind: "confirm" };
}

/** What can hold the focus and answer Enter by itself. */
const INTERACTIVE = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The two DOM questions `focusPlace` asks, so tests can answer them without a document. */
export interface FocusTarget {
  matches: (selector: string) => boolean;
}
export interface FocusContainer {
  contains: (node: never) => boolean;
}

/**
 * Classifies the focused element against the dialog's panel.
 *
 * `body` (or no element) counts as inert: nothing is focused, so there is no control to answer.
 * The panel itself carries `tabIndex={-1}`, which the selector deliberately does not match — a
 * click on the dialog's text focuses the panel, and that is the "nothing interactive" case.
 */
export function focusPlace(
  panel: FocusContainer | null,
  active: (FocusTarget & { tagName?: string }) | null,
): FocusPlace {
  if (!active || active.tagName === "BODY") return "inert";
  if (!panel || !panel.contains(active as never)) return "outside";
  return active.matches(INTERACTIVE) ? "control" : "inert";
}
