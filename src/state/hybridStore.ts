import { create } from "zustand";
import {
  hybridChangedPaths,
  hybridUndo,
  hybridView,
  onHybridItem,
  onHybridProgress,
  type HybridView,
  type RunFile,
} from "../lib/tauri/hybridCommands";
import { pushErrorToast } from "./toastStore";

/**
 * Hybrid runs' plans and live progress, keyed by chain.
 *
 * Keyed by chain id and never cleared by a workspace switch, for the reason `codeflow-run-isolation`
 * gives: a run's home is its chain, and the local model keeps writing while the user looks at
 * another workspace. The chain itself — status, steps, gate — lives in `chainStore`; this holds only
 * what a hybrid run has on top: its frozen configuration, its tasks, and how far the one being
 * written has got.
 */

interface Progress {
  tokens: number;
  elapsedMs: number;
}

interface HybridStore {
  views: Record<string, HybridView>;
  /** Keyed by item id: the task being written right now. Not stored anywhere. */
  progress: Record<string, Progress>;
  load: (chainId: string) => Promise<void>;
  changedPaths: (chainId: string) => Promise<RunFile[]>;
  undo: (chainId: string, files?: RunFile[]) => Promise<RunFile[]>;
}

let subscribed = false;

function subscribe(set: (fn: (s: HybridStore) => Partial<HybridStore>) => void) {
  if (subscribed) return;
  subscribed = true;
  void onHybridItem(({ chain_id, item }) => {
    set((s) => {
      const view = s.views[chain_id];
      // Only for runs somebody has opened; the next `load` reads the rest.
      if (!view) return {};
      const items = view.items.map((existing) => (existing.id === item.id ? item : existing));
      const { [item.id]: _done, ...progress } = s.progress;
      return {
        views: { ...s.views, [chain_id]: { ...view, items } },
        progress: item.status === "running" ? s.progress : progress,
      };
    });
  });
  void onHybridProgress(({ item_id, tokens, elapsed_ms }) => {
    set((s) => ({ progress: { ...s.progress, [item_id]: { tokens, elapsedMs: elapsed_ms } } }));
  });
}

export const useHybridStore = create<HybridStore>((set) => ({
  views: {},
  progress: {},

  load: async (chainId) => {
    subscribe(set);
    try {
      const view = await hybridView(chainId);
      if (view) set((s) => ({ views: { ...s.views, [chainId]: view } }));
    } catch {
      // Re-read on the chain's next change; a failure here is a stale panel, not lost work.
    }
  },

  changedPaths: async (chainId) => {
    try {
      return await hybridChangedPaths(chainId);
    } catch (error) {
      pushErrorToast(String(error));
      return [];
    }
  },

  undo: async (chainId, files) => {
    try {
      return await hybridUndo(chainId, files);
    } catch (error) {
      pushErrorToast(String(error));
      return [];
    }
  },
}));
