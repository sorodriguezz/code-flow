import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { toolSetupInstall, toolSetupStatus } from "../lib/tauri/commands";
import type { ToolInstallResult, ToolStatus } from "../types/domain";
import { useProviderStatusStore } from "./providerStatusStore";

interface ToolSetupState {
  tools: ToolStatus[] | null;
  loading: boolean;
  loadError: boolean;
  /** The tool being installed right now — the backend runs one at a time. */
  installing: string | null;
  /** The last output line per tool, while it installs. */
  lastLine: Record<string, string>;
  results: Record<string, ToolInstallResult>;
  load: () => Promise<void>;
  install: (id: string) => Promise<ToolInstallResult | null>;
}

let pendingLoad: Promise<void> | null = null;

export const useToolSetupStore = create<ToolSetupState>((set, get) => ({
  tools: null,
  loading: false,
  loadError: false,
  installing: null,
  lastLine: {},
  results: {},

  load: () => {
    if (pendingLoad) return pendingLoad;
    set({ loading: true, loadError: false });
    pendingLoad = toolSetupStatus()
      .then((tools) => set({ tools }))
      .catch(() => set({ loadError: true }))
      .finally(() => {
        pendingLoad = null;
        set({ loading: false });
      });
    return pendingLoad;
  },

  install: async (id) => {
    if (get().installing) return null;
    const tool = get().tools?.find((entry) => entry.id === id);
    set((s) => ({ installing: id, lastLine: { ...s.lastLine, [id]: "" } }));
    listenForToolSetupProgress();
    const result = await toolSetupInstall(id).catch(
      (error): ToolInstallResult => ({ id, outcome: "failed", detail: "", errorKind: null, reference: null, details: String(error) }),
    );
    if (result.outcome === "done") {
      set((state) => ({
        tools: state.tools?.map((entry) => entry.id === id ? { ...entry, installed: true, detail: result.detail } : entry) ?? null,
      }));
      // A check that started before the installer finished may carry the previous state.
      await pendingLoad;
      await get().load();
      if (tool?.group === "agent") void useProviderStatusStore.getState().check(id);
    }
    set((s) => ({ installing: null, results: { ...s.results, [id]: result } }));
    return result;
  },
}));

let listening = false;
/** Follows the installer's output. Once; cheap to call again. */
export function listenForToolSetupProgress() {
  if (listening) return;
  listening = true;
  void listen<{ id: string; line: string }>("tool-setup:progress", (event) => {
    const { id, line } = event.payload;
    useToolSetupStore.setState((s) => ({ lastLine: { ...s.lastLine, [id]: line } }));
  }).catch(() => {
    listening = false;
  });
}
