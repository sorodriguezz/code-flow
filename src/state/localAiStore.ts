import { create } from "zustand";
import { broadcast } from "../lib/windowBus";
import {
  localAiCancelDownload,
  localAiDeleteModel,
  localAiDownloadModel,
  localAiSetEnabled,
  localAiSetModel,
  localAiState,
  localAiStopEngine,
  type LocalAiState,
} from "../lib/tauri/localaiCommands";
import { onLocalAiDownload, onLocalAiEngine, type LocalAiDownloadEvent } from "../lib/tauri/events";
import { pushErrorToast } from "./toastStore";

/**
 * The editor's local completion: what is downloaded, what is running, and how far a download has
 * got.
 *
 * **Two kinds of state, deliberately kept apart.** `state` is the authoritative answer from Rust
 * and is re-read after anything that could change it. `progress` is a per-model live feed that
 * only ever comes from the `localai:download` event. Merging them would mean either re-querying
 * the backend four times a second while a download runs, or letting a stale snapshot overwrite a
 * bar that has since moved.
 *
 * **The download promise is not awaited for progress.** `localAiDownloadModel` resolves when the
 * file is complete *and* verified — minutes, for the 7B — so the bar is driven by the event and the
 * promise is used only to know when to refresh `state`.
 */

interface LocalAiStore {
  state: LocalAiState | null;
  /** Keyed by model id. An entry appears when a download starts and is dropped when it settles. */
  progress: Record<string, LocalAiDownloadEvent>;
  /** True while the first `load()` is in flight, so the pane can skeleton rather than flash empty. */
  loading: boolean;
  /**
   * A completion request has been in flight long enough to be worth mentioning.
   *
   * Set by the Monaco provider, and deliberately *not* set the moment a request starts: a warm
   * engine answers in under 200 ms, and an indicator that blinks on every pause in typing is
   * noise pretending to be information. See `useInlineCompletion`.
   */
  thinking: boolean;
  setThinking: (thinking: boolean) => void;
  /**
   * Window labels where inline completion is thinking right now, this one excluded.
   *
   * The status bar lives in the main window and claims to show what the models on this machine are
   * doing; a completion running in a detached repository window is a model on this machine. Held as
   * a set of labels rather than a count so a window that closes mid-request cannot leave the count
   * stuck above zero — the label simply stops being re-announced, and the close sweeps it.
   */
  foreignThinking: string[];
  setForeignThinking: (label: string, busy: boolean) => void;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  download: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  remove: (modelId: string) => Promise<void>;
  stopEngine: () => Promise<void>;
}

/** The event listener is global and installed once, not per component mount. */
let subscribed = false;

export const useLocalAiStore = create<LocalAiStore>((set, get) => ({
  state: null,
  progress: {},
  loading: false,
  thinking: false,
  foreignThinking: [],

  setThinking: (thinking) => {
    set({ thinking });
    // Announced rather than kept private: the bar that draws this is in the main window, and a
    // completion running in a satellite is still a model running on this machine.
    broadcast({ kind: "completion", busy: thinking });
  },

  setForeignThinking: (label, busy) =>
    set((s) => {
      const without = s.foreignThinking.filter((held) => held !== label);
      const next = busy ? [...without, label] : without;
      // Same length means the same set here — labels are unique and only ever added once — so this
      // avoids re-rendering the bar on every idle announcement.
      return next.length === s.foreignThinking.length ? {} : { foreignThinking: next };
    }),

  load: async () => {
    if (!subscribed) {
      subscribed = true;
      // The engine announces every move it makes, so the status bar does not have to poll and the
      // settings pane cannot show a stale "ready" for a process that died a minute ago.
      void onLocalAiEngine((engine) => {
        set((current) => (current.state ? { state: { ...current.state, engine } } : {}));
      });
      void onLocalAiDownload((event) => {
        set((current) => {
          // A settled download leaves the map so the row goes back to its resting appearance —
          // installed, or offering a resume — rather than holding a bar at 100% forever.
          if (event.phase === "done" || event.phase === "cancelled") {
            const { [event.model_id]: _settled, ...rest } = current.progress;
            return { progress: rest };
          }
          return { progress: { ...current.progress, [event.model_id]: event } };
        });
        // `failed` stays in the map, because the row has to show the reason. Everything that
        // settles changes what is on disk, so the authoritative state is re-read.
        if (event.phase === "done" || event.phase === "cancelled" || event.phase === "failed") {
          void get().refresh();
        }
      });
    }
    if (get().state) return;
    set({ loading: true });
    await get().refresh();
    set({ loading: false });
  },

  refresh: async () => {
    try {
      set({ state: await localAiState() });
    } catch {
      // Deliberately silent. This is polled after every mutation and on every settled download;
      // a toast per failure would bury the one the user actually caused.
    }
  },

  setEnabled: async (enabled) => {
    // Optimistic, because the switch has to move under the finger. The refresh below is what makes
    // it honest if the write failed.
    set((current) => (current.state ? { state: { ...current.state, enabled } } : {}));
    try {
      await localAiSetEnabled(enabled);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },

  setModel: async (modelId) => {
    try {
      await localAiSetModel(modelId);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },

  download: async (modelId) => {
    // Seeded before the first event so the row switches to its downloading state on the click
    // rather than up to 250 ms later, which otherwise reads as the button having missed.
    set((current) => ({
      progress: {
        ...current.progress,
        [modelId]: { model_id: modelId, phase: "downloading", done: 0, total: 0 },
      },
    }));
    try {
      await localAiDownloadModel(modelId);
    } catch (error) {
      // The backend already emitted `failed` with the reason, and the row shows it. A toast on top
      // would say the same thing twice — except for a cancel, which is not a failure at all.
      const message = String(error);
      if (!message.includes("cancelled")) {
        set((current) => ({
          progress: {
            ...current.progress,
            [modelId]: {
              model_id: modelId,
              phase: "failed",
              done: 0,
              total: 0,
              error: message,
            },
          },
        }));
      }
    }
    await get().refresh();
  },

  cancelDownload: async (modelId) => {
    try {
      await localAiCancelDownload(modelId);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  remove: async (modelId) => {
    try {
      await localAiDeleteModel(modelId);
    } catch (error) {
      pushErrorToast(String(error));
    }
    set((current) => {
      const { [modelId]: _gone, ...rest } = current.progress;
      return { progress: rest };
    });
    await get().refresh();
  },

  stopEngine: async () => {
    try {
      await localAiStopEngine();
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },
}));

/**
 * Whether inline completion is worth asking for at all.
 *
 * Read by the Monaco provider on every keystroke, so it is a plain synchronous look at the store
 * rather than a command: a round trip to Rust per character to ask "are you switched on" would
 * cost more than the completion.
 */
export function completionIsUsable(): boolean {
  const state = useLocalAiStore.getState().state;
  return Boolean(state?.enabled && state.model_installed && state.engine_available);
}
