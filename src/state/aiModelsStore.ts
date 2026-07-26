import { create } from "zustand";
import { getSetting, listAiModels, setSetting } from "../lib/tauri/commands";

/** Model ids the user has typed into a "Custom" field for this provider. Kept as CSV in settings.
 * This is what keeps Claude Code and Codex current: neither CLI can enumerate its models, so
 * without it their dropdowns only ever hold whatever was hardcoded at release time. */
const rememberedKey = (providerId: string) => `${providerId}_known_models`;

/**
 * Cached "what models does this provider offer" lists — the live list from the provider, merged
 * with the ids the user has typed by hand. Asking a CLI costs a process spawn (`agy models`,
 * `opencode models`), so each provider is fetched at most once per session and shared by
 * everything that needs it: the Settings rows, the routing table and the chat's model chip.
 */
interface AiModelsState {
  byProvider: Record<string, string[]>;
  loading: boolean;
  /** Fetches any of `providerIds` not already cached. Safe to call repeatedly. */
  ensure: (providerIds: string[]) => Promise<void>;
  /** Drops a provider's cached list so the next `ensure` refetches — needed when its credentials
   * or endpoint change, since the models it can serve change with them. */
  invalidate: (providerId: string) => void;
  /** Records a hand-typed model id so it's offered as a normal option from now on. */
  remember: (providerId: string, modelId: string) => Promise<void>;
}

async function loadRemembered(providerId: string): Promise<string[]> {
  const raw = await getSetting(rememberedKey(providerId)).catch(() => null);
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Live list first (it's authoritative), then any remembered id it didn't already include. */
function merge(live: string[], remembered: string[]): string[] {
  return [...live, ...remembered.filter((id) => !live.includes(id))];
}

export const useAiModelsStore = create<AiModelsState>((set, get) => ({
  byProvider: {},
  loading: false,

  ensure: async (providerIds) => {
    const missing = providerIds.filter((id) => !(id in get().byProvider));
    if (missing.length === 0) return;
    set({ loading: true });
    const entries = await Promise.all(
      missing.map(async (id) => {
        const [live, remembered] = await Promise.all([
          listAiModels(id).catch(() => [] as string[]),
          loadRemembered(id),
        ]);
        return [id, merge(live, remembered)] as const;
      }),
    );
    set((s) => ({
      byProvider: { ...s.byProvider, ...Object.fromEntries(entries) },
      loading: false,
    }));
  },

  invalidate: (providerId) =>
    set((s) => {
      const { [providerId]: _dropped, ...rest } = s.byProvider;
      return { byProvider: rest };
    }),

  remember: async (providerId, modelId) => {
    const id = modelId.trim();
    if (!id) return;
    const remembered = await loadRemembered(providerId);
    if (remembered.includes(id)) return;
    const next = [...remembered, id];
    await setSetting(rememberedKey(providerId), next.join(","));
    // Fold it into the cache too, so it shows up without waiting for a refetch.
    set((s) => {
      const current = s.byProvider[providerId];
      if (!current || current.includes(id)) return s;
      return { byProvider: { ...s.byProvider, [providerId]: [...current, id] } };
    });
  },
}));
