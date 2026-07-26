import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
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
 * backend's fallback chain so the UI can't disagree with what actually runs. */
async function loadRouting(defaultProvider: string) {
  const taskProviders: Record<string, string> = {};
  const taskModels: Record<string, string> = {};
  await Promise.all(
    AI_TASKS.map(async ({ key }) => {
      const routed = (await read(taskProviderKey(key)))?.trim() ?? "";
      taskProviders[key] = routed;
      const provider = routed || defaultProvider;
      const [override, base] = await Promise.all([
        read(taskModelKey(provider, key)),
        read(modelKey(provider)),
      ]);
      taskModels[key] = override?.trim() || base?.trim() || "";
    }),
  );
  return { taskProviders, taskModels };
}

export const useAiProviderStore = create<AiProviderState>((set, get) => ({
  providerId: DEFAULT_AI_PROVIDER,
  model: "",
  taskProviders: {},
  taskModels: {},

  init: async () => {
    const raw = await read(KEY);
    const valid = raw && AI_PROVIDERS.some((p) => p.id === raw && p.available);
    const providerId = valid ? raw! : DEFAULT_AI_PROVIDER;
    const model = await read(modelKey(providerId));
    const routing = await loadRouting(providerId);
    set({ providerId, model: model ?? "", ...routing });
  },

  refresh: async () => {
    const { providerId } = get();
    const model = await read(modelKey(providerId));
    const routing = await loadRouting(providerId);
    set({ model: model ?? "", ...routing });
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
