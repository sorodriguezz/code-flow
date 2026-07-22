import { create } from "zustand";

export interface Toast {
  id: string;
  message: string;
  type: "error" | "success" | "info";
}

interface ToastState {
  toasts: Toast[];
  pushToast: (message: string, type?: Toast["type"]) => void;
  dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  pushToast: (message, type = "error") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const pushErrorToast = (message: string) => useToastStore.getState().pushToast(message, "error");
