import { create } from "zustand";
import { getSetting, listAiModels, setSetting } from "../lib/tauri/commands";
import { PROVIDER_MODELS } from "../lib/aiProviders";

/** Model ids the user has typed into a "Custom" field for this provider. Kept as CSV in settings.
 * This is what keeps Claude Code and Codex current: neither CLI can enumerate its models, so
 * without it their dropdowns only ever hold whatever was hardcoded at release time. */
const rememberedKey = (providerId: string) => `${providerId}_known_models`;

/**
 * How old a cached list may be before a picker asks the provider again.
 *
 * Not a general TTL — [`ensure`] still defaults to "once per session", which is what the Settings
 * screens want: they list every provider at once, and refetching on each visit would be six process
 * spawns for a screen someone opened to tick a checkbox. This is the age the **pickers** pass,
 * where the fetch is one provider the user just navigated into and asked to see.
 *
 * Thirty seconds, because the case it exists for is a model that appeared or disappeared while the
 * app was open: `ollama pull` finishes, the user goes back to the picker, and the list has to be the
 * one on disk rather than the one from whenever the app booted. Short enough that "pull, then look"
 * always works; long enough that opening the same menu twice in a row costs one fetch.
 */
export const MODELS_MAX_AGE_MS = 30_000;

/** The provider part of a qualified id (`ollama/gemma:2b` → `ollama`), `""` for a bare one. */
function namespaceOf(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? "" : id.slice(0, slash);
}

/**
 * Remembered ids, minus the ones a live list has just disproved.
 *
 * Hand-typed ids are kept indefinitely by design: for Claude Code and Codex, which enumerate
 * nothing, they *are* the catalog. But a provider that does answer has the last word about itself,
 * and without this an id outlived its own model — `ollama/gemma4:e4b` was still being offered, and
 * still selected, long after it left `ollama list`. A turn aimed at a model that does not exist.
 *
 * **The rule is evidence, not absence.** An id is dropped only when the live list contains another
 * id from the same provider, which is what proves that provider was actually reached:
 *
 * - `live` empty → nothing is dropped. Ollama being down is not the user having no models, and
 *   that exact confusion is one `cline.rs` calls out in its own docs.
 * - `live` is all `ollama/…`, the remembered id is `anthropic/…` → kept. Nothing here asked
 *   Anthropic anything, so nothing here may answer for it.
 * - `live` is all `ollama/…`, the remembered id is an `ollama/…` that is not among them → dropped.
 */
export function pruneRemembered(live: string[], remembered: string[]): string[] {
  const answered = new Set(live.map(namespaceOf));
  const offered = new Set(live);
  return remembered.filter((id) => offered.has(id) || !answered.has(namespaceOf(id)));
}

/**
 * Cached "what models does this provider offer" lists — the live list from the provider, merged
 * with the ids the user has typed by hand. Asking a CLI costs a process spawn (`agy models`,
 * `opencode models`), so a provider is fetched once and shared by everything that needs it: the
 * Settings rows, the routing table and the chat's model chip.
 *
 * "Once" used to mean once per session, with no way back except a Refresh button in Settings.
 * That is how a picker came to offer models the user had deleted and hide the one they had just
 * pulled: the list was a photograph of whatever was installed when the app booted. Callers that
 * are a deliberate "show me the models" gesture now pass {@link MODELS_MAX_AGE_MS} and get an
 * answer that is at most half a minute old.
 */
interface AiModelsState {
  byProvider: Record<string, string[]>;
  /** When each provider's list was last fetched. Separate from `byProvider` because a cached list
   *  has to be judged *old*, not merely present — the absence of this is the whole bug above. */
  fetchedAt: Record<string, number>;
  loading: boolean;
  /** Fetches any of `providerIds` not already cached. Safe to call repeatedly.
   *
   *  `maxAgeMs` also refetches the ones whose cached list is older than that — omit it to keep the
   *  cached list however old it is, which is what a screen that lists every provider wants. */
  ensure: (providerIds: string[], maxAgeMs?: number) => Promise<void>;
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
  fetchedAt: {},
  loading: false,

  ensure: async (providerIds, maxAgeMs) => {
    const { byProvider, fetchedAt } = get();
    const now = Date.now();
    const missing = providerIds.filter((id) => {
      if (!(id in byProvider)) return true;
      if (maxAgeMs === undefined) return false;
      return now - (fetchedAt[id] ?? 0) >= maxAgeMs;
    });
    if (missing.length === 0) return;
    set({ loading: true });
    const entries = await Promise.all(
      missing.map(async (id) => {
        const [live, remembered] = await Promise.all([
          listAiModels(id).catch(() => [] as string[]),
          loadRemembered(id),
        ]);
        const kept = pruneRemembered(live, remembered);
        // Written back, not just filtered out of this render: the CSV is what the *next* session
        // reads, and a list only cleaned in memory grows its dead entries back the first time the
        // provider happens to be unreachable.
        if (kept.length !== remembered.length) {
          await setSetting(rememberedKey(id), kept.join(",")).catch(() => {});
        }
        return [id, merge(live, kept)] as const;
      }),
    );
    const stamped = Object.fromEntries(entries.map(([id]) => [id, Date.now()]));
    set((s) => ({
      byProvider: { ...s.byProvider, ...Object.fromEntries(entries) },
      fetchedAt: { ...s.fetchedAt, ...stamped },
      loading: false,
    }));
  },

  invalidate: (providerId) =>
    set((s) => {
      const { [providerId]: _dropped, ...rest } = s.byProvider;
      const { [providerId]: _stamp, ...stamps } = s.fetchedAt;
      return { byProvider: rest, fetchedAt: stamps };
    }),

  remember: async (providerId, modelId) => {
    const id = modelId.trim();
    if (!id) return;
    // A catalog id is already offered — remembering it would (for providers with no live list,
    // like Claude Code) make the remembered subset replace the whole catalog. Only remember
    // genuinely hand-typed ids.
    if ((PROVIDER_MODELS[providerId] ?? []).some((m) => m.id === id)) return;
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
