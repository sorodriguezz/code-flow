import { create } from "zustand";
import { checkAiProvider, type ProviderStatus } from "../lib/tauri/commands";
import { AI_PROVIDERS } from "../lib/aiProviders";

/**
 * Live "is this provider actually usable" state, shared by the providers list (status badge) and
 * the per-task routing table (which greys out what isn't installed). Kept in one store so both
 * read the same answer and a re-check updates them together.
 */
interface ProviderStatusState {
  byProvider: Record<string, ProviderStatus>;
  /** True while a full sweep is in flight — drives the list's initial skeleton. */
  checking: boolean;
  /** Re-checks every selectable provider. Safe to call repeatedly; it's a cheap PATH lookup plus
   * one local HTTP request for Ollama. */
  checkAll: () => Promise<void>;
  /** Re-checks a single provider — used after its binary/endpoint is edited. */
  check: (providerId: string) => Promise<void>;
}

export const useProviderStatusStore = create<ProviderStatusState>((set) => ({
  byProvider: {},
  checking: false,

  checkAll: async () => {
    set({ checking: true });
    const entries = await Promise.all(
      AI_PROVIDERS.filter((p) => p.available).map(
        async (p) => [p.id, await checkAiProvider(p.id).catch(() => null)] as const,
      ),
    );
    const byProvider: Record<string, ProviderStatus> = {};
    for (const [id, status] of entries) {
      if (status) byProvider[id] = status;
    }
    set({ byProvider, checking: false });
  },

  check: async (providerId) => {
    const status = await checkAiProvider(providerId).catch(() => null);
    if (!status) return;
    set((s) => ({ byProvider: { ...s.byProvider, [providerId]: status } }));
  },
}));

/** Whether `providerId` is known to be usable. Unknown (not yet checked) counts as available so
 * nothing is greyed out or blocked while the first check is still running. */
export const isProviderReady = (byProvider: Record<string, ProviderStatus>, providerId: string) =>
  byProvider[providerId]?.available !== false;
