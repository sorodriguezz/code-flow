import { create } from "zustand";
import { getSetting, getSettings, setSetting } from "../lib/tauri/commands";
import { AI_PROVIDERS, DEFAULT_AI_PROVIDER } from "../lib/aiProviders";
import { AI_TASKS } from "../lib/aiTasks";

const KEY = "ai_provider";

/** Each provider keeps its own model setting (`${providerId}_model`) — a Claude model id means
 * nothing to Gemini and vice versa — so the tracked model follows the active provider. */
const modelKey = (providerId: string) => `${providerId}_model`;

/** Per-task routing overrides. Blank/unset means the task inherits the global provider — the same
 * fallback chain as `provider_for()` on the Rust side. */
const taskProviderKey = (task: string) => `ai_provider_${task}`;
const taskModelKey = (providerId: string, task: string) => `${providerId}_${task}_model`;

const read = (key: string) => getSetting(key).catch(() => null);

/** A block of settings in one round-trip. Absent key = never set, exactly as `read` answers `null`
 * — callers put the two on the same footing with `?? null` (or lean on `?.` treating `undefined`
 * like `null`), so a model deliberately saved as `""` stays distinct from one that was never saved.
 *
 * The failure path is one `.catch` for the batch where there used to be one per key. That is the
 * same degradation as before and not a coarser one: a `get_setting` only rejects when the database
 * itself is unreachable, which was failing every key in the wave anyway. Routing then comes up on
 * the global provider with no model pinned, which is what 44 individual failures produced too. */
const readMany = (keys: string[]) =>
  getSettings(keys).catch(() => ({}) as Record<string, string>);

/** Every task's routing-override key. Statically known — no value has to be read first — which is
 * why these can share a call with whatever else the caller already needs. */
const taskProviderKeys = () => AI_TASKS.map(({ key }) => taskProviderKey(key));

interface AiProviderState {
  /** Global default provider — used by any task without its own routing override. */
  providerId: string;
  /** Raw stored model id for the default provider; empty means no `--model` is passed and the
   * CLI picks its own. */
  model: string;
  /** Raw per-task provider overrides, keyed by task. Absent/blank = inherit `providerId`. */
  taskProviders: Record<string, string>;
  /** Effective model id per task (its own override, else its provider's base model). Empty means
   * the provider picks. Recomputed by `refresh`. */
  taskModels: Record<string, string>;
  init: () => Promise<void>;
  /** Re-reads the routing table — call after Settings writes a provider/model so the chat chip and
   * the agentic feature gates reflect the change without a restart. */
  refresh: () => Promise<void>;
  setProvider: (id: string) => Promise<void>;
  setModel: (model: string) => void;
  setTaskProvider: (task: string, providerId: string) => Promise<void>;
  /** Pins a task to an explicit provider *and* model in one step — what the chat's model chip
   * writes, so picking there is equivalent to setting that task's row in Settings. */
  setTaskRouting: (task: string, providerId: string, model: string) => Promise<void>;
}

/** Resolves each task's effective provider and model from the stored settings, mirroring the
 * backend's fallback chain so the UI can't disagree with what actually runs.
 *
 * TWO round-trips, not 44. This used to be 14 tasks x 3 `getSetting`s inside a `Promise.all`, and
 * the concurrency was a fiction — `get_setting` takes the database mutex per key, so the Rust end
 * served all 44 in single file while the window sat there at launch.
 *
 * It cannot be one call, and the obvious flattening is wrong: **which** model keys to read depends
 * on the *values* read in the first wave. A task routed to Gemini has to be answered from Gemini's
 * rows, so the second wave's key list can only be built once the first wave has come back. (Reading
 * every provider's rows up front to dodge that would trade 2 calls for one call carrying ~100 keys
 * and would have to be revisited every time a provider is added — not worth it.) So: one call for
 * the routing overrides, one for the models they select.
 *
 * `prefetched` lets a caller that already had to read something else fold wave one into *its* call
 * — `init` does, since the global provider key and these are all statically known. */
async function loadRouting(defaultProvider: string, prefetched?: Record<string, string>) {
  const routed = prefetched ?? (await readMany(taskProviderKeys()));

  // Wave one, resolved. `?.trim() ?? ""` behaves as it always did — an absent key is `undefined`
  // here where it used to be `null`, and both short-circuit the `?.` to the same `""`.
  const taskProviders: Record<string, string> = {};
  const providerFor: Record<string, string> = {};
  for (const { key } of AI_TASKS) {
    const override = routed[taskProviderKey(key)]?.trim() ?? "";
    taskProviders[key] = override;
    providerFor[key] = override || defaultProvider;
  }

  // Wave two. Deduped through a Set because tasks sharing a provider share its base model key —
  // with no routing overrides at all that is 14 identical `${provider}_model` reads collapsing into
  // one. `modelKey(defaultProvider)` is added unconditionally: every caller wants the global
  // provider's own model too, and it is free here when some task already inherits it.
  const wanted = new Set<string>([modelKey(defaultProvider)]);
  for (const { key } of AI_TASKS) {
    wanted.add(taskModelKey(providerFor[key], key));
    wanted.add(modelKey(providerFor[key]));
  }
  const models = await readMany([...wanted]);

  const taskModels: Record<string, string> = {};
  for (const { key } of AI_TASKS) {
    const override = models[taskModelKey(providerFor[key], key)];
    const base = models[modelKey(providerFor[key])];
    taskModels[key] = override?.trim() || base?.trim() || "";
  }
  // Handed back rather than read again by the caller: it rode along in the wave-two call, and
  // `?? null` restores exactly the `string | null` the old `read(modelKey(providerId))` returned.
  return { taskProviders, taskModels, defaultModel: models[modelKey(defaultProvider)] ?? null };
}

export const useAiProviderStore = create<AiProviderState>((set, get) => ({
  providerId: DEFAULT_AI_PROVIDER,
  model: "",
  taskProviders: {},
  taskModels: {},

  // Two round-trips at boot where there were 46, in four dependent waves that could not overlap.
  // Everything whose key is known without reading anything first — the global provider and all 14
  // routing overrides — goes in the first call; the model keys those values select follow in
  // `loadRouting`'s second. State is still published in exactly one `set`, after both.
  init: async () => {
    const first = await readMany([KEY, ...taskProviderKeys()]);
    const raw = first[KEY] ?? null;
    const valid = raw && AI_PROVIDERS.some((p) => p.id === raw && p.available);
    const providerId = valid ? raw! : DEFAULT_AI_PROVIDER;
    const { defaultModel, ...routing } = await loadRouting(providerId, first);
    set({ providerId, model: defaultModel ?? "", ...routing });
  },

  refresh: async () => {
    const { providerId } = get();
    // The active provider's own model comes back from `loadRouting`'s wave-two call, which reads it
    // anyway — one call fewer, and it still lands in the same `set` as the routing table did.
    const { defaultModel, ...routing } = await loadRouting(providerId);
    set({ model: defaultModel ?? "", ...routing });
  },

  // Settings persists `${providerId}_model` itself when the user saves; this only mirrors the new
  // value in memory so the chat's model chip updates without waiting for a restart.
  setModel: (model) => set({ model }),

  setProvider: async (id) => {
    const provider = AI_PROVIDERS.find((p) => p.id === id);
    if (!provider || !provider.available) return;
    // Load the newly-active provider's own model so the chip reflects it immediately.
    const model = await read(modelKey(id));
    set({ providerId: id, model: model ?? "" });
    await setSetting(KEY, id);
    // Tasks that inherit the default now resolve to a different provider.
    await get().refresh();
  },

  setTaskProvider: async (task, providerId) => {
    await setSetting(taskProviderKey(task), providerId);
    set((s) => ({ taskProviders: { ...s.taskProviders, [task]: providerId } }));
    await get().refresh();
  },

  setTaskRouting: async (task, providerId, model) => {
    await Promise.all([
      setSetting(taskProviderKey(task), providerId),
      setSetting(taskModelKey(providerId, task), model),
    ]);
    set((s) => ({ taskProviders: { ...s.taskProviders, [task]: providerId } }));
    await get().refresh();
  },
}));

/** The provider that will actually handle `task` — its routing override, else the global default.
 * Use this (not `providerId`) wherever a feature's availability depends on the engine, so routing
 * one task elsewhere is reflected in the UI. */
export const useTaskProvider = (task: string) =>
  useAiProviderStore((s) => s.taskProviders[task]?.trim() || s.providerId);
