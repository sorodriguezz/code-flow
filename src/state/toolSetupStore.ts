import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { toolSetupInstall, toolSetupStatus } from "../lib/tauri/commands";
import type { ToolInstallResult, ToolStatus } from "../types/domain";
import { useProviderStatusStore } from "./providerStatusStore";

/**
 * `git` and the AI CLIs: which are installed, and installing them — for the first-launch
 * «Preparar CodeFlow» screen and the one-click «Instalar» in Settings. One store so the two agree:
 * an install started in one shows its progress in the other. The commands are the backend's
 * (`tool_setup.rs`); this only names a tool.
 */
interface ToolSetupState {
  tools: ToolStatus[] | null;
  loading: boolean;
  /** The tool being installed right now — the backend runs one at a time. */
  installing: string | null;
  /** The last output line per tool, while it installs. */
  lastLine: Record<string, string>;
  results: Record<string, ToolInstallResult>;
  load: () => Promise<void>;
  install: (id: string) => Promise<ToolInstallResult | null>;
  /** One after another, in the order given; stops on nothing — each gets its own result. */
  installMany: (ids: string[]) => Promise<void>;
}

export const useToolSetupStore = create<ToolSetupState>((set, get) => ({
  tools: null,
  loading: false,
  installing: null,
  lastLine: {},
  results: {},

  load: async () => {
    set({ loading: true });
    const tools = await toolSetupStatus().catch(() => null);
    set((s) => ({ tools: tools ?? s.tools, loading: false }));
  },

  install: async (id) => {
    if (get().installing) return null;
    listenForToolSetupProgress();
    set((s) => ({ installing: id, lastLine: { ...s.lastLine, [id]: "" } }));
    const result = await toolSetupInstall(id).catch(
      (error): ToolInstallResult => ({ id, outcome: "failed", detail: "", errorKind: null, reference: null, details: String(error) }),
    );
    set((s) => ({ installing: null, results: { ...s.results, [id]: result } }));
    if (result.outcome === "done") {
      await get().load();
      // The Providers list's badge and the routing table read their own probe.
      if (id !== "git") void useProviderStatusStore.getState().check(id);
    }
    return result;
  },

  installMany: async (ids) => {
    for (const id of ids) await get().install(id);
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
