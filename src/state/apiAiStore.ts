import { create } from "zustand";
import { apiAi } from "../lib/tauri/apiCommands";
import { cancelAiRun } from "../lib/tauri/commands";
import { parseClaudeError } from "../lib/claudeError";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { useLanguageStore } from "./languageStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { TranslationKey } from "../lib/i18n/translations";

/**
 * The API client's assistant (`api_ai`, the `api` task's engine): «Explicar con IA» answers by
 * request tab, and the one-shot jobs — «Generar tests», «Crear con IA» — by what they are for.
 *
 * Held here rather than in the panels so a run outlives a tab switch: back on the tab finds the
 * answer, or the run still going, with its stop.
 */
export interface ApiExplanation {
  runId: string;
  startedAt: number;
  text?: string;
  error?: string;
}

type Kind = "explain" | "tests" | "request";

const KIND_KEYS: Record<Kind, TranslationKey> = {
  explain: "api.ai.kindExplain",
  tests: "api.ai.kindTests",
  request: "api.ai.kindRequest",
};

interface ApiAiState {
  explanations: Record<string, ApiExplanation>;
  /** Jobs running, by what they are for (`tests:<tab>`, `request`) → their run id. */
  busy: Record<string, string>;
  explain: (tabId: string, payload: string, detail: string) => Promise<void>;
  closeExplanation: (tabId: string) => void;
  /** A one-shot job: the engine's answer, or `null` when it was stopped. Throws a readable error. */
  run: (key: string, kind: Kind, payload: string, detail: string) => Promise<string | null>;
  stop: (key: string) => void;
}

export function explanationRunning(explanation: ApiExplanation | undefined): boolean {
  return explanation !== undefined && explanation.text === undefined && explanation.error === undefined;
}

export const useApiAiStore = create<ApiAiState>((set, get) => {
  const call = async (kind: Kind, payload: string, runId: string, detail: string) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    useAiRunStore.getState().start(runId, { kindKey: KIND_KEYS[kind], detail, workspaceId });
    try {
      return await apiAi({ kind, payload, language: useLanguageStore.getState().language, runId, workspaceId });
    } finally {
      useAiRunStore.getState().finish(runId);
    }
  };

  return {
    explanations: {},
    busy: {},

    explain: async (tabId, payload, detail) => {
      if (explanationRunning(get().explanations[tabId])) return;
      const runId = newRunId("api");
      set((s) => ({ explanations: { ...s.explanations, [tabId]: { runId, startedAt: Date.now() } } }));
      const settle = (patch: Partial<ApiExplanation>) =>
        set((s) => (s.explanations[tabId]?.runId === runId ? { explanations: { ...s.explanations, [tabId]: { ...s.explanations[tabId], ...patch } } } : s));
      try {
        settle({ text: await call("explain", payload, runId, detail) });
      } catch (e) {
        if (isCancellation(e)) {
          set((s) => {
            if (s.explanations[tabId]?.runId !== runId) return s;
            const explanations = { ...s.explanations };
            delete explanations[tabId];
            return { explanations };
          });
        } else {
          settle({ error: parseClaudeError(String(e)).message });
        }
      }
    },

    closeExplanation: (tabId) => {
      const current = get().explanations[tabId];
      if (!current) return;
      if (explanationRunning(current)) void cancelAiRun(current.runId).catch(() => {});
      set((s) => {
        const explanations = { ...s.explanations };
        delete explanations[tabId];
        return { explanations };
      });
    },

    run: async (key, kind, payload, detail) => {
      if (get().busy[key]) return null;
      const runId = newRunId("api");
      set((s) => ({ busy: { ...s.busy, [key]: runId } }));
      try {
        return await call(kind, payload, runId, detail);
      } catch (e) {
        if (isCancellation(e)) return null;
        throw new Error(parseClaudeError(String(e)).message);
      } finally {
        set((s) => {
          if (s.busy[key] !== runId) return s;
          const busy = { ...s.busy };
          delete busy[key];
          return { busy };
        });
      }
    },

    stop: (key) => {
      const runId = get().busy[key];
      if (runId) void cancelAiRun(runId).catch(() => {});
    },
  };
});
