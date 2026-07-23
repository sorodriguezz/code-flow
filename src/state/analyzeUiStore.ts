import { create } from "zustand";

interface AnalyzeUiState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

/** Purely a UI toggle for which "not chat" view the AI panel currently shows (change
 * analysis vs a selected PR vs the free-form chat) — the analysis job itself lives in
 * `jobsStore` and keeps running regardless of whether this is open. */
export const useAnalyzeUiStore = create<AnalyzeUiState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
