import { create } from "zustand";
import { containersAnalyzeLogs } from "../lib/tauri/containersCommands";
import { cancelAiRun } from "../lib/tauri/commands";
import { parseClaudeError } from "../lib/claudeError";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { useLanguageStore } from "./languageStore";
import { useWorkspaceStore } from "./workspaceStore";
import { pushErrorToast } from "./toastStore";

/**
 * «Analizar con IA» on a container's, a Compose project's or a pod's log — the answers, by what they
 * are about (`logAnalysisKey`).
 *
 * Held here rather than in the log's page so a run outlives the page it was asked from: back to the
 * list and into the pod again finds the answer — or the run still going — the way a pull outlives
 * its page in `containersJobsStore`. Machine-wide like the rest of the panel.
 */
export interface LogAnalysis {
  runId: string;
  startedAt: number;
  /** What it is about, as the panel and the status bar name it. */
  subject: string;
  /** How many lines the engine was handed. */
  lines: number;
  text?: string;
  error?: string;
}

interface LogAiState {
  byKey: Record<string, LogAnalysis>;
  /** Hands `log` to the engine the `logs` task is routed to. A second ask while one runs is ignored. */
  analyze: (key: string, args: { subject: string; about: string; log: string }) => Promise<void>;
  /** Closes the answer — and stops the run, when it is still going: nobody is waiting for it. */
  clear: (key: string) => void;
}

/** What one analysis is about: the log's source, and the choices that change what it prints. */
export function logAnalysisKey(parts: (string | null | undefined | boolean)[]): string {
  return parts.map((part) => (part === null || part === undefined || part === false ? "" : String(part))).join("|");
}

export function analysisRunning(analysis: LogAnalysis | undefined): boolean {
  return analysis !== undefined && analysis.text === undefined && analysis.error === undefined;
}

export const useContainersLogAiStore = create<LogAiState>((set, get) => {
  /** Writes an answer only into the analysis that asked for it — one closed and asked again since
   *  is another run, and the old answer must not land in it. */
  const settle = (key: string, runId: string, patch: Partial<LogAnalysis>) =>
    set((s) => (s.byKey[key]?.runId === runId ? { byKey: { ...s.byKey, [key]: { ...s.byKey[key], ...patch } } } : s));
  const drop = (key: string, runId: string) =>
    set((s) => {
      if (s.byKey[key]?.runId !== runId) return s;
      const byKey = { ...s.byKey };
      delete byKey[key];
      return { byKey };
    });

  return {
    byKey: {},

    analyze: async (key, { subject, about, log }) => {
      if (analysisRunning(get().byKey[key])) return;
      const runId = newRunId("logs");
      // The account is resolved the way the picker beside the button names it — with the window's
      // workspace — but the run is stamped with none: a container belongs to the computer.
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      useAiRunStore.getState().start(runId, { kindKey: "containers.logs.aiKind", detail: subject, workspaceId: null });
      set((s) => ({ byKey: { ...s.byKey, [key]: { runId, startedAt: Date.now(), subject, lines: log ? log.split("\n").length : 0 } } }));
      try {
        const text = await containersAnalyzeLogs({ log, about, language: useLanguageStore.getState().language, runId, workspaceId });
        settle(key, runId, { text });
      } catch (e) {
        if (isCancellation(e)) {
          drop(key, runId);
        } else {
          const message = parseClaudeError(String(e)).message;
          settle(key, runId, { error: message });
          pushErrorToast(message);
        }
      } finally {
        useAiRunStore.getState().finish(runId);
      }
    },

    clear: (key) => {
      const analysis = get().byKey[key];
      if (!analysis) return;
      if (analysisRunning(analysis)) void cancelAiRun(analysis.runId).catch(() => {});
      drop(key, analysis.runId);
    },
  };
});
