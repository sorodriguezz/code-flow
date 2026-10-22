import { create } from "zustand";
import { onVoiceFit, voiceFit, voiceMeasure, type VoiceFit } from "../lib/tauri/voiceFitCommands";
import { pushErrorToast } from "./toastStore";

/**
 * What Settings › Voz y sonido shows beside every model that listens and every voice: this
 * machine, each one's speed here (estimated, or measured once downloaded), and the picks. Re-read
 * when a measurement lands (`voice:fit` — after every download and every «Medir»).
 */
interface VoiceFitStore {
  fit: VoiceFit | null;
  /** Ids being measured right now. */
  measuring: string[];
  load: () => Promise<void>;
  measure: (id: string) => Promise<void>;
}

let listening = false;

export const useVoiceFitStore = create<VoiceFitStore>((set, get) => ({
  fit: null,
  measuring: [],

  load: async () => {
    if (!listening) {
      listening = true;
      void onVoiceFit(() => void get().load());
    }
    try {
      set({ fit: await voiceFit() });
    } catch {
      // A dev build without the command: the rows still show their own sizes.
    }
  },

  measure: async (id) => {
    if (get().measuring.includes(id)) return;
    set((state) => ({ measuring: [...state.measuring, id] }));
    try {
      await voiceMeasure(id);
      await get().load();
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      set((state) => ({ measuring: state.measuring.filter((m) => m !== id) }));
    }
  },
}));
