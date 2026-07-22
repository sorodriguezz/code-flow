import { create } from "zustand";

interface FetchTimerState {
  /** Seconds until the next background auto-fetch; null when auto-fetch is disabled. */
  remainingSeconds: number | null;
  setRemaining: (seconds: number | null) => void;
}

export const useFetchTimerStore = create<FetchTimerState>((set) => ({
  remainingSeconds: null,
  setRemaining: (seconds) => set({ remainingSeconds: seconds }),
}));
