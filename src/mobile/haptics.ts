/**
 * The small physical answer a phone gives when something happened.
 *
 * # Why a control panel needs this more than most apps
 *
 * Every button here fires a command at a machine in another room, over wifi, and the answer takes
 * anywhere from twenty milliseconds to several seconds. Until now the only acknowledgement a tap
 * got was the thing on screen eventually changing — which, for `stage_file` on a list that was
 * already scrolled past the row, is nothing at all. A person cannot tell "it did not register"
 * from "it is thinking", so they tap again, and staging toggles back off.
 *
 * A 10 ms buzz at the moment the request leaves is not decoration; it is the receipt.
 *
 * # What actually works
 *
 * `navigator.vibrate` on Android, and nothing on iOS — Safari has never shipped the Vibration API
 * and the switch-element trick that gets passed around only fires for a real `<input>` the user
 * touched, which is not a general-purpose API. So this is deliberately a best-effort layer: iOS
 * users get the visual feedback (`cf-press`, the toasts) and no buzz, and no code anywhere has to
 * branch on which phone it is.
 *
 * The patterns are short on purpose. A control panel that buzzes for a tenth of a second on every
 * tap is one somebody switches off at the OS level, taking the useful ones with it.
 */

/** Whether the API exists at all. Read once — it does not appear mid-session. */
const CAN_VIBRATE = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

function buzz(pattern: number | number[]) {
  if (!CAN_VIBRATE) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some browsers throw when the page has never been interacted with, or when the OS has
    // vibration off. Neither is worth a line of error handling anywhere else.
  }
}

/** A command was sent, a row was picked, a tab changed. The default for anything that acts. */
export const tapped = () => buzz(8);

/** Something landed: a commit, a push, an approved gate. */
export const succeeded = () => buzz([12, 40, 18]);

/** Something refused. Two beats, so it is distinguishable from a success without looking. */
export const failed = () => buzz([24, 60, 24]);

/** A screen was pushed or popped. Lighter than [`tapped`] — navigation is constant, and a buzz per
 *  screen change adds up to a phone that hums. */
export const navigated = () => buzz(5);
