import { create } from "zustand";
import { cancelAiRun, skillGenerate, type SkillDraft, type SkillSource } from "../lib/tauri/commands";
import { parseClaudeError } from "../lib/claudeError";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { useLanguageStore } from "./languageStore";

/**
 * «Generar skill» (Herramientas de IA › Skills), one per workspace: what the skill is written from,
 * the run writing it, and the draft it came back as — edited in place until it is saved, downloaded
 * or thrown away.
 *
 * Held here and not in the panel so a run outlives closing Settings or visiting another workspace,
 * and lands in the workspace it was started from (the run's home is the key, never the active one).
 */
export interface SkillGen {
  sources: SkillSource[];
  focus: string;
  /** The run in flight, if any. */
  runId?: string;
  startedAt?: number;
  draft?: SkillDraft;
  error?: string;
}

const EMPTY: SkillGen = { sources: [], focus: "" };

interface SkillGenState {
  byWorkspace: Record<string, SkillGen>;
  /** Sources, focus or the draft, changed by the panel. */
  patch: (workspaceId: string, patch: Partial<SkillGen>) => void;
  generate: (workspaceId: string) => Promise<void>;
  stop: (workspaceId: string) => void;
  /** Forgets the draft and the error; the sources stay, for another try. */
  discard: (workspaceId: string) => void;
  /** Everything, after the skill was saved. */
  reset: (workspaceId: string) => void;
}

export function skillGenOf(state: SkillGenState, workspaceId: string | null): SkillGen {
  return (workspaceId && state.byWorkspace[workspaceId]) || EMPTY;
}

/** What a source is called in the status bar's list of runs. */
export function sourceLabel(source: SkillSource): string {
  switch (source.kind) {
    case "repo":
    case "document":
      return source.path.split(/[\\/]/).filter(Boolean).pop() ?? source.path;
    case "url":
      return source.url.replace(/^https?:\/\//, "");
    case "text":
      return source.text.trim().slice(0, 40);
  }
}

export const useSkillGenStore = create<SkillGenState>((set, get) => {
  const update = (workspaceId: string, change: (current: SkillGen) => SkillGen) =>
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: change(s.byWorkspace[workspaceId] ?? EMPTY) } }));

  return {
    byWorkspace: {},

    patch: (workspaceId, patch) => update(workspaceId, (current) => ({ ...current, ...patch })),

    generate: async (workspaceId) => {
      const current = get().byWorkspace[workspaceId] ?? EMPTY;
      if (current.runId || current.sources.length === 0) return;
      const runId = newRunId("skill");
      update(workspaceId, (c) => ({ ...c, runId, startedAt: Date.now(), draft: undefined, error: undefined }));
      const detail = current.focus.trim().slice(0, 60) || current.sources.map(sourceLabel).join(", ");
      useAiRunStore.getState().start(runId, { kindKey: "skills.gen.runKind", detail, workspaceId });
      // Only this run may settle what it started: a stop followed by a new run must not be overwritten
      // by the first one's late answer.
      const settle = (patch: Partial<SkillGen>) =>
        update(workspaceId, (c) => (c.runId === runId ? { ...c, ...patch, runId: undefined, startedAt: undefined } : c));
      try {
        const draft = await skillGenerate({
          sources: current.sources,
          focus: current.focus,
          language: useLanguageStore.getState().language,
          runId,
          workspaceId,
        });
        settle({ draft });
      } catch (e) {
        settle(isCancellation(e) ? {} : { error: parseClaudeError(String(e)).message });
      } finally {
        useAiRunStore.getState().finish(runId);
      }
    },

    stop: (workspaceId) => {
      const runId = get().byWorkspace[workspaceId]?.runId;
      if (runId) void cancelAiRun(runId).catch(() => {});
    },

    discard: (workspaceId) => update(workspaceId, (c) => ({ ...c, draft: undefined, error: undefined })),

    reset: (workspaceId) =>
      set((s) => {
        const byWorkspace = { ...s.byWorkspace };
        delete byWorkspace[workspaceId];
        return { byWorkspace };
      }),
  };
});
