import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";

/**
 * What the user hid from AI in the Contenedores panel: clusters by context, Azure subscriptions by
 * id, container engines by runtime id. One setting, `ai_infra_hidden`, which the backend reads on
 * every look a chat or an agent makes (`agentcli::infra`) — so a switch counts from the next call.
 * Everything is visible until hidden: the panel's tools only ever read.
 */

export type AiInfraKind = "kube" | "azure" | "engines";

type Hidden = Record<AiInfraKind, string[]>;

const KEY = "ai_infra_hidden";
const NONE: Hidden = { kube: [], azure: [], engines: [] };

interface AiInfraState {
  hidden: Hidden;
  loaded: boolean;
  load: () => Promise<void>;
  toggle: (kind: AiInfraKind, id: string) => void;
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export const useAiInfraStore = create<AiInfraState>((set, get) => ({
  hidden: NONE,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await getSetting(KEY);
      const parsed = raw ? (JSON.parse(raw) as Partial<Record<AiInfraKind, unknown>>) : {};
      set({ hidden: { kube: list(parsed.kube), azure: list(parsed.azure), engines: list(parsed.engines) }, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  toggle: (kind, id) => {
    const current = get().hidden[kind];
    const next = { ...get().hidden, [kind]: current.includes(id) ? current.filter((h) => h !== id) : [...current, id] };
    set({ hidden: next });
    void setSetting(KEY, JSON.stringify(next)).catch(() => {});
  },
}));
