import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { AI_PROVIDERS, DEFAULT_AI_PROVIDER } from "../lib/aiProviders";

const KEY = "ai_provider";

/** Claude Code is the only provider that actually runs today, so its model setting is the one
 * worth tracking here. When a second provider becomes invokable this should follow the active
 * provider (`${providerId}_model`) instead of being pinned to Claude's key. */
const MODEL_KEY = "claude_model";

interface AiProviderState {
  providerId: string;
  /** Raw stored model id; empty means no `--model` is passed and the CLI picks its own. */
  model: string;
  init: () => Promise<void>;
  setProvider: (id: string) => Promise<void>;
  setModel: (model: string) => void;
}

export const useAiProviderStore = create<AiProviderState>((set) => ({
  providerId: DEFAULT_AI_PROVIDER,
  model: "",

  init: async () => {
    const [raw, model] = await Promise.all([
      getSetting(KEY).catch(() => null),
      getSetting(MODEL_KEY).catch(() => null),
    ]);
    const valid = raw && AI_PROVIDERS.some((p) => p.id === raw && p.available);
    set({ providerId: valid ? raw! : DEFAULT_AI_PROVIDER, model: model ?? "" });
  },

  // Settings persists `claude_model` itself when the user saves; this only mirrors the new
  // value in memory so the chat's model chip updates without waiting for a restart.
  setModel: (model) => set({ model }),

  setProvider: async (id) => {
    const provider = AI_PROVIDERS.find((p) => p.id === id);
    if (!provider || !provider.available) return;
    set({ providerId: id });
    await setSetting(KEY, id);
  },
}));
