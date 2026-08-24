/**
 * The text somebody typed, kept until they are done with it.
 *
 * # What used to happen instead
 *
 * Three fields in this client hold work that is slow and annoying to retype on a phone keyboard:
 * a commit message, a chat message, and the answer to a chain's gate. All three were plain
 * component state, so all three were destroyed by things that are not "cancel":
 *
 * * switching tab to check something and coming back,
 * * a chain being re-read after an `ai:done` frame, which remounts the detail,
 * * `reloadIfStale` deciding the desktop has been rebuilt — which fires precisely when a phone
 *   wakes up, i.e. exactly when somebody has been typing and got interrupted,
 * * the error boundary's reload button.
 *
 * A commit message written one-handed and lost to a tab tap is the kind of thing that makes people
 * stop using a tool.
 *
 * # Why `localStorage` and not the zustand store
 *
 * The store does not survive a reload, and two of the four cases above *are* reloads. Written
 * through on every keystroke, which sounds expensive and is not: this is a handful of small string
 * writes on a device that is idle between them, and the alternative — debouncing — loses the last
 * word typed before the interruption, which is the word that matters.
 *
 * Keyed by what the draft belongs to, so two projects' commit messages, or two chains' answers, do
 * not overwrite each other.
 */

const PREFIX = "codeflow.remote.draft.";

export type DraftKind = "commit" | "chat" | "gate";

function key(kind: DraftKind, owner: string): string {
  return `${PREFIX}${kind}.${owner}`;
}

/** What was typed for this thing last time, or `""`. */
export function readDraft(kind: DraftKind, owner: string | null | undefined): string {
  if (!owner) return "";
  try {
    return localStorage.getItem(key(kind, owner)) ?? "";
  } catch {
    // Safari in private browsing. The draft then only lives as long as the component does, which is
    // the behaviour this file replaced — no worse, and no reason to fail louder.
    return "";
  }
}

/** Records what is in the field now. An empty value removes the entry rather than storing `""`. */
export function writeDraft(kind: DraftKind, owner: string | null | undefined, value: string): void {
  if (!owner) return;
  try {
    if (value.length === 0) localStorage.removeItem(key(kind, owner));
    else localStorage.setItem(key(kind, owner), value);
  } catch {
    /* nothing to do */
  }
}

/** Called on a *successful* submit, and only then. Cancelling keeps the draft on purpose. */
export function clearDraft(kind: DraftKind, owner: string | null | undefined): void {
  writeDraft(kind, owner, "");
}
