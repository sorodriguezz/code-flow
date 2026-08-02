import { create } from "zustand";

/**
 * Which of the API client's modals is on screen.
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
/**
 * The sub-tabs of the API client's settings — mirrors `TABS` in `ApiSettingsPanel`.
 *
 * The settings themselves are *not* one of these modals. They live in the app's own settings
 * window, under "Ajustes del cliente API", and every entry point here routes there
 * (`uiStore.openApiSettings`) rather than opening a second, smaller copy of the same panel.
 */
export type ApiSettingsTab =
  | "network"
  | "proxy"
  | "certificates"
  | "general"
  | "collab";

export type ApiModal =
  | { kind: "environments" }
  | { kind: "import" }
  | { kind: "cookies" }
  | { kind: "export"; collectionId: string }
  | { kind: "runner"; collectionId: string; folderId: string | null }
  /** Accept an invitation to a shared collection. Sharing one lives in the settings pane. */
  | { kind: "collab" }
  /** The records frozen by a three-way merge, and the choice for each. */
  | { kind: "conflicts" };

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
