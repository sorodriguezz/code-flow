import { create } from "zustand";

interface ConfirmRequest {
  message: string;
  danger: boolean;
  /** Overrides the generic "Confirm" button label when naming the action is clearer. */
  confirmLabel?: string;
  resolve: (value: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  ask: (message: string, danger?: boolean, confirmLabel?: string) => Promise<boolean>;
  respond: (value: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,

  ask: (message, danger = true, confirmLabel) =>
    new Promise<boolean>((resolve) => {
      set({ request: { message, danger, confirmLabel, resolve } });
    }),

  respond: (value) => {
    get().request?.resolve(value);
    set({ request: null });
  },
}));

/** Drop-in replacement for `window.confirm()` that pops the app's own styled modal instead
 * of the browser-native dialog — every discard/delete action in the app should route
 * through this rather than rolling its own confirm UI. */
export const confirmAction = (message: string, danger = true, confirmLabel?: string) =>
  useConfirmStore.getState().ask(message, danger, confirmLabel);
