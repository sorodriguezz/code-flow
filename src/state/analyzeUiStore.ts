import { create } from "zustand";

interface AnalyzeUiState {
  open: boolean;
  /** The specific analysis run currently shown, pinned by job id when opened from the Activity
   * list. `null` means "show the project's most recent analysis" (a fresh open or a new run).
   * Without this, every analyze activity resolved to the newest run and aliased onto one result. */
  selectedJobId: string | null;
  /** Open showing the latest analysis / a brand-new run (no specific past run pinned). */
  show: () => void;
  /** Open a specific past analysis by its job id (from the Activity list). */
  showJob: (jobId: string) => void;
  hide: () => void;
}

/** Purely a UI toggle for which "not chat" view the AI panel currently shows (change
 * analysis vs a selected PR vs the free-form chat) plus which analysis run is pinned — the
 * analysis jobs themselves live in `jobsStore` and keep running regardless of this. */
export const useAnalyzeUiStore = create<AnalyzeUiState>((set) => ({
  open: false,
  selectedJobId: null,
  show: () => set({ open: true, selectedJobId: null }),
  showJob: (jobId) => set({ open: true, selectedJobId: jobId }),
  hide: () => set({ open: false, selectedJobId: null }),
}));
