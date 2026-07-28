import { create } from "zustand";

/**
 * Which of the API client's six modals is on screen.
 *
 * They're opened from four places that can't see each other — the view toolbar, the sidebar's
 * overflow menu, the collection tree's context menu, and the command palette, which lives outside
 * the API view entirely — and two of them (the runner and the export sheet) have to outlive the
 * menu that opened them. A store is the only shape that serves all four; threading openers down
 * as props would still leave the palette with nothing to call.
 *
 * `ApiView` is the sole renderer. Opening one from outside the view is therefore only meaningful
 * together with `setActiveView("api")`, which is what mounts it.
 */
export type ApiModal =
  | { kind: "environments" }
  | { kind: "import" }
  | { kind: "cookies" }
  | { kind: "settings" }
  | { kind: "export"; collectionId: string }
  | { kind: "runner"; collectionId: string; folderId: string | null };

interface ApiModalState {
  modal: ApiModal | null;
  openApiModal: (modal: ApiModal) => void;
  closeApiModal: () => void;
}

export const useApiModalStore = create<ApiModalState>((set) => ({
  modal: null,
  openApiModal: (modal) => set({ modal }),
  closeApiModal: () => set({ modal: null }),
}));
