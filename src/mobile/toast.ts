/**
 * The one-line answer to "did that work?".
 *
 * # What this replaces
 *
 * `store.error` and a red 11-pixel line in the header. Two problems with that, and they are both
 * fatal on a phone: it was drawn *above* the scroll area, so an error raised by a button at the
 * bottom of a long Repo screen appeared somewhere the user was not looking; and it never cleared
 * itself, so the next screen inherited the last screen's failure.
 *
 * Worse was the silence on the other side. `commit`, `git_push`, `stage_all`, `checkout` — every
 * one of them succeeded without saying so. On the desktop the working tree redraws under your eyes
 * and that is answer enough; on a phone over wifi it is two seconds of nothing, and the honest
 * reading of two seconds of nothing is that the tap missed.
 *
 * So: a toast per outcome, over the tab bar where a thumb is already looking, gone on its own.
 *
 * # Why a module and not a store field
 *
 * Anything can raise one — a screen, the transport layer, the frame router — and none of them
 * should have to reach the zustand store to do it. It is its own tiny store for the same reason
 * `invalidate.ts` is its own event: the thing that raises it and the thing that draws it never
 * need to know about each other.
 */

import { create } from "zustand";
import { failed as buzzFailed, succeeded as buzzSucceeded } from "./haptics";

export type Tone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: Tone;
  text: string;
  /** A longer explanation, shown under the text in a smaller size. Used for the raw error a
   *  backend sent, which is worth keeping but is not the sentence. */
  detail?: string;
}

/** How long each tone stays up. An error gets longer because it is the one you may want to read
 *  twice, and because it usually carries a `detail` line under it. */
const LIFETIME: Record<Tone, number> = { success: 2200, info: 2800, error: 5000 };

/** At most this many at once. Beyond it the oldest goes: a stack taller than three covers the
 *  content it is reporting on. */
const MAX = 3;

interface ToastStore {
  toasts: Toast[];
  dismiss: (id: number) => void;
}

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

let nextId = 1;

function raise(tone: Tone, text: string, detail?: string) {
  const id = nextId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts, { id, tone, text, detail }].slice(-MAX) }));
  window.setTimeout(() => useToasts.getState().dismiss(id), LIFETIME[tone]);
}

export function toastSuccess(text: string) {
  buzzSucceeded();
  raise("success", text);
}

/**
 * A failure, with the machine's own words kept underneath.
 *
 * `detail` is deliberately separate from `text`: the sentence is written for the reader and the
 * detail is whatever git or the backend actually said, which is often the only thing that names the
 * file or the branch that is in the way.
 */
export function toastError(text: string, detail?: string) {
  buzzFailed();
  raise("error", text, detail);
}

export function toastInfo(text: string) {
  raise("info", text);
}
