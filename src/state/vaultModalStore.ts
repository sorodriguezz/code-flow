import { create } from "zustand";

/**
 * The keyring's dialogs.
 *
 * The same three-line pattern `apiModalStore` and `dbModalStore` use: one modal at a time, and the
 * payload rides on the discriminated union rather than in a second field — so "which dialog" and
 * "about what" cannot disagree.
 */
export type VaultModal =
  | { kind: "import" }
  | { kind: "settings" };

interface VaultModalState {
  modal: VaultModal | null;
  openVaultModal: (modal: VaultModal) => void;
  closeVaultModal: () => void;
}

export const useVaultModalStore = create<VaultModalState>((set) => ({
  modal: null,
  openVaultModal: (modal) => set({ modal }),
  closeVaultModal: () => set({ modal: null }),
}));
