import { create } from "zustand";
import { adoGetWorkItem, adoParseWorkItemRef, reviewWorkItem } from "../lib/tauri/commands";
import { parseClaudeError } from "../lib/claudeError";
import { htmlToText, splitCriteria, storyPayload } from "../lib/workItemHtml";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { translate } from "./languageStore";
import { pushErrorToast } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import type {
  AdoWorkItem,
  InvestVerdict,
  ProposedCriterion,
  ProposedTask,
  ReviewFinding,
  WorkItemKind,
  WorkItemReviewStage,
} from "../types/domain";

/**
 * A review session over one story that is already on the board.
 *
 * Nothing here is persisted, and that is the current shape of the feature rather than an oversight:
 * this stage reads Azure and writes nothing back, so a session is worth exactly what the user copied
 * out of it before closing. Persisting it would mean deciding what happens when the story changes on
 * the board underneath a saved review, which is a question for the stage that writes.
 *
 * The three AI stages are separate calls on purpose — analysis, then criteria, then tasks — because
 * each is meant to read a story the user has already curated with what the previous one proposed.
 */

/**
 * Whether this is judged as a story or as a defect.
 *
 * Matched on the type *name*, because that is all the API gives that is stable across process
 * templates and languages — a Spanish-language project reports "Error" where an English one reports
 * "Bug". Anything unrecognised is reviewed as a story: the story checklist asked of a Feature is
 * merely a stretch, while the bug checklist asked of a requirement is nonsense.
 */
export function kindOf(workItemType: string): WorkItemKind {
  return /bug|error|defect|incidencia|defecto/i.test(workItemType) ? "bug" : "story";
}

/** The estimate as the process itself names it, or an empty string when nobody estimated it. */
export function effortLabel(item: AdoWorkItem): string {
  if (!item.effort) return "";
  const unit = item.effort_field.split(".").pop() ?? "";
  const name = unit === "StoryPoints" ? "story points" : unit === "Size" ? "size" : "effort";
  // Whole numbers print whole: "5 story points", not "5.0".
  return `${Number.isInteger(item.effort) ? item.effort : item.effort.toFixed(1)} ${name}`;
}

/** The analysis stage's answer, kept whole so the summary and its findings can't drift apart. */
export interface StoryAnalysis {
  summary: string;
  invest: InvestVerdict[];
  findings: ReviewFinding[];
}

interface WorkItemReviewState {
  /** What the user pasted: a link, or a bare id. */
  input: string;
  /** The organisation a bare id belongs to — filled from the last link, or from the batch target. */
  org: string;
  /**
   * The repositories the analysis reads. A story usually lives across more than one — the API that
   * exposes it and the front that consumes it — and reviewing it against only one is how half its
   * behaviour goes unchecked. Empty blocks the AI stages.
   */
  projectIds: string[];
  loading: boolean;
  error: string;
  item: AdoWorkItem | null;

  /** The story as text, editable, seeded from the work item and never written back on its own. */
  title: string;
  description: string;
  /** A bug's steps. Kept apart from the description because in Azure they are different fields. */
  reproSteps: string;
  criteria: string[];

  analysis: StoryAnalysis | null;
  proposedCriteria: ProposedCriterion[];
  proposedTasks: ProposedTask[];
  /** Run ids by stage — present means "in flight", which is also what the Stop button acts on. */
  runByStage: Partial<Record<WorkItemReviewStage, string>>;
  /** Proposals the user threw away, so a re-run doesn't resurrect them mid-session. */
  dismissed: Record<string, true>;

  setInput: (input: string) => void;
  setOrg: (org: string) => void;
  toggleProject: (projectId: string) => void;
  load: () => Promise<void>;
  run: (stage: WorkItemReviewStage) => Promise<void>;
  stop: (stage: WorkItemReviewStage) => Promise<void>;
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  setReproSteps: (reproSteps: string) => void;
  setCriterion: (at: number, value: string) => void;
  addCriterion: (value: string) => void;
  removeCriterion: (at: number) => void;
  dismiss: (key: string) => void;
  reset: () => void;
}

const EMPTY = {
  loading: false,
  error: "",
  item: null,
  title: "",
  description: "",
  reproSteps: "",
  criteria: [] as string[],
  analysis: null,
  proposedCriteria: [] as ProposedCriterion[],
  proposedTasks: [] as ProposedTask[],
  dismissed: {} as Record<string, true>,
};

export const useWorkItemReviewStore = create<WorkItemReviewState>((set, get) => ({
  input: "",
  org: "",
  projectIds: [],
  runByStage: {},
  ...EMPTY,

  setInput: (input) => set({ input }),
  setOrg: (org) => set({ org }),
  toggleProject: (projectId) =>
    set((s) => ({
      projectIds: s.projectIds.includes(projectId)
        ? s.projectIds.filter((id) => id !== projectId)
        : [...s.projectIds, projectId],
    })),
  setTitle: (title) => set({ title }),
  setDescription: (description) => set({ description }),
  setReproSteps: (reproSteps) => set({ reproSteps }),
  setCriterion: (at, value) =>
    set((s) => ({ criteria: s.criteria.map((c, i) => (i === at ? value : c)) })),
  addCriterion: (value) => set((s) => ({ criteria: [...s.criteria, value] })),
  removeCriterion: (at) => set((s) => ({ criteria: s.criteria.filter((_, i) => i !== at) })),
  dismiss: (key) => set((s) => ({ dismissed: { ...s.dismissed, [key]: true } })),

  reset: () => set({ input: "", ...EMPTY }),

  load: async () => {
    const { input, org } = get();
    if (!input.trim() || get().loading) return;
    set({ loading: true, error: "" });
    try {
      const ref = await adoParseWorkItemRef(input);
      // A bare id carries no organisation, so it falls back to the one already on screen. Failing
      // here rather than guessing: fetching the wrong org's item 4821 would look like it worked.
      const resolved = ref.org ?? org.trim();
      if (!resolved) throw new Error(translate("huReview.orgMissing"));
      const item = await adoGetWorkItem(resolved, ref.id);
      set({
        // Everything derived from the previous item goes with it — a review of story A must not
        // still be on screen under story B.
        ...EMPTY,
        org: resolved,
        item,
        title: item.title,
        description: htmlToText(item.description_html),
        reproSteps: htmlToText(item.repro_steps_html),
        criteria: splitCriteria(htmlToText(item.acceptance_criteria_html)),
      });
    } catch (e: unknown) {
      set({ loading: false, error: String(e) });
    }
  },

  run: async (stage) => {
    const state = get();
    if (state.runByStage[stage] || !state.item) return;
    if (state.projectIds.length === 0) {
      pushErrorToast(translate("huReview.pickReposFirst"));
      return;
    }
    const workspaceId = activeWorkspaceId();
    if (!workspaceId) return;

    const runId = newRunId("hu-review");
    // Before the invoke, or the first lines the engine prints have nowhere to land.
    useAiRunStore.getState().start(runId);
    set((s) => ({ runByStage: { ...s.runByStage, [stage]: runId } }));

    try {
      const review = await reviewWorkItem({
        workspaceId,
        projectIds: state.projectIds,
        stage,
        kind: kindOf(state.item.work_item_type),
        storyText: storyPayload({
          title: state.title,
          workItemType: state.item.work_item_type,
          effort: effortLabel(state.item),
          description: state.description,
          reproSteps: state.reproSteps,
          systemInfo: htmlToText(state.item.system_info_html),
          criteria: state.criteria,
          tasks: state.item.children.map((child) => ({ title: child.title, state: child.state })),
        }),
        runId,
      });

      if (review.stage === "analyze") {
        set({ analysis: { summary: review.summary, invest: review.invest, findings: review.findings } });
      } else if (review.stage === "criteria") {
        set({ proposedCriteria: review.criteria });
      } else {
        set({ proposedTasks: review.tasks });
      }
    } catch (e: unknown) {
      // A stopped run is not a failure: nothing was written, and the previous answer is still on
      // screen exactly as it was.
      //
      // Parsed rather than raw: a provider refusal arrives tagged with the quota marker, and
      // `String(e)` would put that machine prefix in front of the sentence the user reads.
      if (!isCancellation(e)) pushErrorToast(parseClaudeError(String(e)).message);
    } finally {
      useAiRunStore.getState().finish(runId);
      set((s) => {
        const { [stage]: _done, ...runByStage } = s.runByStage;
        return { runByStage };
      });
    }
  },

  stop: async (stage) => {
    const runId = get().runByStage[stage];
    if (runId) await useAiRunStore.getState().cancel(runId);
  },
}));

/**
 * The active workspace, read at call time rather than held in this store.
 *
 * The run uses that workspace's prompts, MCP config and skills, so reading it as the run starts is
 * what keeps a session opened before a workspace switch from running against the old one.
 */
function activeWorkspaceId(): string | null {
  const id = useWorkspaceStore.getState().activeWorkspaceId;
  if (!id) pushErrorToast(translate("huReview.noWorkspace"));
  return id;
}
