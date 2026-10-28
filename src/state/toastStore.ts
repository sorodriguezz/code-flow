import { create } from "zustand";

/** What pressing the card does, instead of closing it — "Undo". */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: "error" | "success" | "info";
  /** Makes the whole card a button. A toast with one is never merged with an identical twin: two
   * "deleted" cards are two things that can each be undone. */
  action?: ToastAction;
  /** How long the card stays, when it must outlast the default (an undo window). */
  lifetimeMs?: number;
}

interface ToastState {
  toasts: Toast[];
  pushToast: (message: string, type?: Toast["type"], options?: Pick<Toast, "action" | "lifetimeMs">) => void;
  dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  pushToast: (message, type = "error", options) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, type, ...options }] }));
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const pushErrorToast = (message: string) => useToastStore.getState().pushToast(message, "error");

/**
 * A good outcome, said where the user is rather than where it happened.
 *
 * For work that finishes somewhere the user is no longer looking — an inline AI rewrite that lands
 * in a buffer after they switched to the Pipelines tab. The notification centre records it either
 * way; a toast is what makes it *arrive*.
 */
export const pushSuccessToast = (message: string) =>
  useToastStore.getState().pushToast(message, "success");
