import { create } from "zustand";

interface ConfirmRequest {
  message: string;
  danger: boolean;
  resolve: (value: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  ask: (message: string, danger?: boolean) => Promise<boolean>;
  respond: (value: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,

  ask: (message, danger = true) =>
    new Promise<boolean>((resolve) => {
      set({ request: { message, danger, resolve } });
    }),

  respond: (value) => {
    get().request?.resolve(value);
    set({ request: null });
  },
}));

/** Drop-in replacement for `window.confirm()` that pops the app's own styled modal instead
 * of the browser-native dialog — every discard/delete action in the app should route
 * through this rather than rolling its own confirm UI. */
export const confirmAction = (message: string, danger = true) => useConfirmStore.getState().ask(message, danger);
