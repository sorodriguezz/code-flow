import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { AI_PROVIDERS, DEFAULT_AI_PROVIDER } from "../lib/aiProviders";

const KEY = "ai_provider";

/** Each provider keeps its own model setting (`${providerId}_model`) — a Claude model id means
 * nothing to Gemini and vice versa — so the tracked model follows the active provider. */
const modelKey = (providerId: string) => `${providerId}_model`;

interface AiProviderState {
  providerId: string;
  /** Raw stored model id for the active provider; empty means no `--model` is passed and the
   * CLI picks its own. */
  model: string;
  init: () => Promise<void>;
  setProvider: (id: string) => Promise<void>;
  setModel: (model: string) => void;
}

export const useAiProviderStore = create<AiProviderState>((set) => ({
  providerId: DEFAULT_AI_PROVIDER,
  model: "",

  init: async () => {
    const raw = await getSetting(KEY).catch(() => null);
    const valid = raw && AI_PROVIDERS.some((p) => p.id === raw && p.available);
    const providerId = valid ? raw! : DEFAULT_AI_PROVIDER;
    const model = await getSetting(modelKey(providerId)).catch(() => null);
    set({ providerId, model: model ?? "" });
  },

  // Settings persists `${providerId}_model` itself when the user saves; this only mirrors the new
  // value in memory so the chat's model chip updates without waiting for a restart.
  setModel: (model) => set({ model }),

  setProvider: async (id) => {
    const provider = AI_PROVIDERS.find((p) => p.id === id);
    if (!provider || !provider.available) return;
    // Load the newly-active provider's own model so the chip reflects it immediately.
    const model = await getSetting(modelKey(id)).catch(() => null);
    set({ providerId: id, model: model ?? "" });
    await setSetting(KEY, id);
  },
}));
