import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { AI_PROVIDERS, DEFAULT_AI_PROVIDER } from "../lib/aiProviders";

const KEY = "ai_provider";

interface AiProviderState {
  providerId: string;
  init: () => Promise<void>;
  setProvider: (id: string) => Promise<void>;
}

export const useAiProviderStore = create<AiProviderState>((set) => ({
  providerId: DEFAULT_AI_PROVIDER,

  init: async () => {
    const raw = await getSetting(KEY).catch(() => null);
    const valid = raw && AI_PROVIDERS.some((p) => p.id === raw && p.available);
    set({ providerId: valid ? raw! : DEFAULT_AI_PROVIDER });
  },

  setProvider: async (id) => {
    const provider = AI_PROVIDERS.find((p) => p.id === id);
    if (!provider || !provider.available) return;
    set({ providerId: id });
    await setSetting(KEY, id);
  },
}));
