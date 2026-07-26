import { create } from "zustand";
import { listAiModels } from "../lib/tauri/commands";

/**
 * Cached "what models does this provider offer" lists. Asking a CLI costs a process spawn
 * (`agy models`, `opencode models`), so each provider is fetched at most once per session and
 * shared by everything that needs it — the chat's model chip and the Settings pickers.
 */
interface AiModelsState {
  byProvider: Record<string, string[]>;
  loading: boolean;
  /** Fetches any of `providerIds` not already cached. Safe to call repeatedly. */
  ensure: (providerIds: string[]) => Promise<void>;
}

export const useAiModelsStore = create<AiModelsState>((set, get) => ({
  byProvider: {},
  loading: false,

  ensure: async (providerIds) => {
    const missing = providerIds.filter((id) => !(id in get().byProvider));
    if (missing.length === 0) return;
    set({ loading: true });
    const entries = await Promise.all(
      missing.map(async (id) => [id, await listAiModels(id).catch(() => [] as string[])] as const),
    );
    set((s) => ({
      byProvider: { ...s.byProvider, ...Object.fromEntries(entries) },
      loading: false,
    }));
  },
}));
