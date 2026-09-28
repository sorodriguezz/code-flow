import { create } from "zustand";

/**
 * Which SSH host the trust dialog is asking about, if any.
 *
 * A store rather than a prop because the failures that open it happen far from any component — a
 * tree expansion, a console run, a connect from a menu — and the dialog outlives all of them.
 * `onTrusted` is what the opener wants done once the key is trusted: usually to retry.
 */
export interface HostKeyTarget {
  host: string;
  /** 0 lets `~/.ssh/config` decide, as it does for the tunnel. */
  port: number;
  user: string;
}

interface HostKeyState {
  target: HostKeyTarget | null;
  onTrusted: (() => void) | null;
  open: (target: HostKeyTarget, onTrusted?: () => void) => void;
  close: () => void;
}

export const useHostKeyStore = create<HostKeyState>((set) => ({
  target: null,
  onTrusted: null,
  open: (target, onTrusted) => set({ target, onTrusted: onTrusted ?? null }),
  close: () => set({ target: null, onTrusted: null }),
}));
