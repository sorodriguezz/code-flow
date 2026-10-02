import { create } from "zustand";
import { setSetting } from "../lib/tauri/commands";
import {
  isLocalExecKey,
  modelKeyFor,
  localExecCancelDownload,
  localExecDeleteModel,
  localExecDownloadModel,
  localExecOllamaCancelPull,
  localExecOllamaDelete,
  localExecOllamaPull,
  localExecProbe,
  localExecSetKey,
  localExecState,
  localExecStopEngine,
  type LocalExecProbe,
  type LocalExecState,
} from "../lib/tauri/localExecCommands";
import { onLocalAiDownload, onLocalExecEngine, type LocalAiDownloadEvent } from "../lib/tauri/events";
import { watchSettings } from "../lib/settingsSync";
import { pushErrorToast } from "./toastStore";

/**
 * The hybrid task's local model: which server, which model, what fits, how fast.
 *
 * Same split as `localAiStore`: `state` is Rust's resolved answer and is re-read after anything
 * that could change it; `progress` is the live download feed. The resolution makes a few short
 * network checks (is Ollama up, what does it list), so it is re-read on demand — the pane opening,
 * a setting changing — never on a timer.
 */

interface LocalExecStore {
  state: LocalExecState | null;
  loading: boolean;
  /** A re-read is in flight; the pane keeps showing the last answer meanwhile. */
  refreshing: boolean;
  probing: boolean;
  /** The last probe's failure, when the command itself failed (the server never answered). */
  probeError: string | null;
  progress: Record<string, LocalAiDownloadEvent>;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Writes one setting, then re-resolves. An empty value removes the choice ("decide for me"). */
  set: (key: string, value: string) => Promise<void>;
  probe: () => Promise<LocalExecProbe | null>;
  download: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  remove: (modelId: string) => Promise<void>;
  stopEngine: () => Promise<void>;
  setKey: (key: string | null) => Promise<void>;
  /** Pulls a model into Ollama; picks it when nothing was chosen yet. */
  pull: (tag: string) => Promise<void>;
  cancelPull: (tag: string) => Promise<void>;
  /** Removes a model from Ollama. */
  deletePulled: (tag: string) => Promise<void>;
}

/** The progress id an Ollama pull reports under — see `localexec_cmd::pull_id`. */
export const pullId = (tag: string) => `ollama:${tag}`;

let subscribed = false;

export const useLocalExecStore = create<LocalExecStore>((set, get) => ({
  state: null,
  loading: false,
  refreshing: false,
  probing: false,
  probeError: null,
  progress: {},

  load: async () => {
    if (!subscribed) {
      subscribed = true;
      void onLocalExecEngine((engine) => {
        set((current) => (current.state ? { state: { ...current.state, engine } } : {}));
      });
      // The completion pane's downloads arrive on the same event; only rows of this catalogue are
      // kept, so neither pane draws the other's bar.
      void onLocalAiDownload((event) => {
        const ours =
          event.model_id.startsWith("ollama:") ||
          get().state?.models.some((model) => model.id === event.model_id && model.installed !== null);
        if (!ours) return;
        set((current) => {
          if (event.phase === "done" || event.phase === "cancelled") {
            const { [event.model_id]: _settled, ...rest } = current.progress;
            return { progress: rest };
          }
          return { progress: { ...current.progress, [event.model_id]: event } };
        });
        if (event.phase === "done" || event.phase === "cancelled" || event.phase === "failed") {
          void get().refresh();
        }
      });
    }
    if (get().state) {
      void get().refresh();
      return;
    }
    set({ loading: true });
    await get().refresh();
    set({ loading: false });
  },

  refresh: async () => {
    set({ refreshing: true });
    try {
      set({ state: await localExecState() });
    } catch {
      // Silent, as in `localAiStore`: re-read after every change, and a toast per failure would
      // bury the one the user caused.
    } finally {
      set({ refreshing: false });
    }
  },

  set: async (key, value) => {
    try {
      await setSetting(key, value);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },

  probe: async () => {
    set({ probing: true, probeError: null });
    try {
      const result = await localExecProbe();
      set((current) => (current.state ? { state: { ...current.state, probe: result } } : {}));
      return result;
    } catch (error) {
      set({ probeError: String(error) });
      return null;
    } finally {
      set({ probing: false });
    }
  },

  download: async (modelId) => {
    set((current) => ({
      progress: { ...current.progress, [modelId]: { model_id: modelId, phase: "downloading", done: 0, total: 0 } },
    }));
    try {
      await localExecDownloadModel(modelId);
    } catch (error) {
      const message = String(error);
      if (!message.includes("cancelled")) {
        set((current) => ({
          progress: {
            ...current.progress,
            [modelId]: { model_id: modelId, phase: "failed", done: 0, total: 0, error: message },
          },
        }));
      }
    }
    await get().refresh();
  },

  cancelDownload: async (modelId) => {
    try {
      await localExecCancelDownload(modelId);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  remove: async (modelId) => {
    try {
      await localExecDeleteModel(modelId);
    } catch (error) {
      pushErrorToast(String(error));
    }
    set((current) => {
      const { [modelId]: _gone, ...rest } = current.progress;
      return { progress: rest };
    });
    await get().refresh();
  },

  pull: async (tag) => {
    const id = pullId(tag);
    set((current) => ({ progress: { ...current.progress, [id]: { model_id: id, phase: "downloading", done: 0, total: 0 } } }));
    try {
      await localExecOllamaPull(tag);
    } catch (error) {
      set((current) => ({
        progress: { ...current.progress, [id]: { model_id: id, phase: "failed", done: 0, total: 0, error: String(error) } },
      }));
      return;
    }
    await get().refresh();
    // The first model on a server nobody had picked from is the one to use.
    const state = get().state;
    if (state?.backend === "ollama" && !state.model_chosen && state.models.some((model) => model.id === tag)) {
      await get().set(modelKeyFor("ollama"), tag);
    }
  },

  cancelPull: async (tag) => {
    try {
      await localExecOllamaCancelPull(tag);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  deletePulled: async (tag) => {
    try {
      await localExecOllamaDelete(tag);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },

  stopEngine: async () => {
    try {
      await localExecStopEngine();
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },

  setKey: async (key) => {
    try {
      await localExecSetKey(key);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },
}));

// Written from Settings, read by the new-task dialog in any window.
watchSettings(isLocalExecKey, () => {
  if (useLocalExecStore.getState().state) void useLocalExecStore.getState().refresh();
});
