import { create } from "zustand";
import {
  aiEvalCancel,
  aiEvalDelete,
  aiEvalList,
  aiEvalRun,
  aiEvalStatus,
  aiModelRegistryList,
  type EvalProgress,
  type EvalRequest,
  type EvaluationRow,
  type ModelRecord,
} from "../lib/tauri/evalsCommands";
import { onAiEval } from "../lib/tauri/events";
import { pushErrorToast } from "./toastStore";

/**
 * The bench and the model registry, for Settings › Diagnóstico and the local-model pane's tool
 * verdict.
 *
 * A run belongs to the app, not to the pane: it keeps going when the pane closes or the window
 * reloads, so `load` asks the backend whether one is in flight and picks its progress back up, and
 * the `ai:eval` feed is subscribed once for the life of the window.
 */
interface EvalStore {
  running: boolean;
  progress: EvalProgress | null;
  /** The model being measured, when the run names one. */
  runningModel: string | null;
  history: EvaluationRow[];
  registry: ModelRecord[];
  /** The last run that ended, for the line under the buttons. */
  lastError: string | null;

  load: () => Promise<void>;
  run: (request: EvalRequest) => Promise<void>;
  cancel: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

let subscribed = false;

export const useEvalStore = create<EvalStore>((set, get) => ({
  running: false,
  progress: null,
  runningModel: null,
  history: [],
  registry: [],
  lastError: null,

  load: async () => {
    if (!subscribed) {
      subscribed = true;
      void onAiEval((event) => {
        if (event.state === "progress") {
          set({ running: true, progress: event.progress });
          return;
        }
        set({ running: false, progress: null, runningModel: null, lastError: event.state === "failed" ? event.error : event.error ?? null });
        void get().load();
      });
    }
    try {
      const [status, history, registry] = await Promise.all([aiEvalStatus(), aiEvalList(50), aiModelRegistryList()]);
      set({ running: status.running, progress: status.progress, runningModel: status.model, history, registry });
    } catch (e) {
      pushErrorToast(String(e));
    }
  },

  run: async (request) => {
    set({ running: true, progress: null, runningModel: request.model ?? null, lastError: null });
    try {
      await aiEvalRun(request);
    } catch (e) {
      set({ running: false, lastError: String(e) });
    }
  },

  cancel: async () => {
    await aiEvalCancel().catch((e: unknown) => pushErrorToast(String(e)));
  },

  remove: async (id) => {
    set({ history: get().history.filter((row) => row.id !== id) });
    await aiEvalDelete(id).catch((e: unknown) => pushErrorToast(String(e)));
  },
}));
