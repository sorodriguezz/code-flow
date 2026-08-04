import { create } from "zustand";
import {
  adoCreateChildTasks,
  adoGetWorkItem,
  adoParseWorkItemRef,
  adoUpdateWorkItem,
  deleteWorkItemReview,
  listWorkItemReviews,
  reviewWorkItem,
  saveWorkItemReview,
} from "../lib/tauri/commands";
import { parseClaudeError } from "../lib/claudeError";
import { renderMarkdown } from "../lib/markdown";
import { htmlToText, splitCriteriaHtml, storyPayload } from "../lib/workItemHtml";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import type {
  AdoWorkItem,
  InvestVerdict,
  ProposedCriterion,
  ProposedTask,
  ReviewFinding,
  ReviewProvenance,
  WorkItemKind,
  WorkItemReviewRow,
  WorkItemReviewStage,
} from "../types/domain";

/**
 * A review session over one story that is already on the board.
 *
 * **Five tabs, and each one owns its subject end to end.** The story as it stands, the
 * description, the criteria, the tasks, and the draft. A tab reads and produces only its own part:
 * running the criteria does not require having run the description, and a session that only ever
 * rewrites the description is a complete session. That independence is the whole point of the
 * shape — refinement rarely wants all three, and a screen that made them a chain charged the user
 * for two answers to reach the one they came for.
 *
 * **The draft is the only thing that writes.** Every other tab is local: the story is a snapshot,
 * the proposals are text a model produced. Nothing reaches Azure DevOps that the user has not sent
 * to the draft and then published from there.
 *
 * **Sessions are saved from the moment the item loads.** The row is written when the work item
 * comes back — before any AI has run — so a review that was only ever *looked at* still leaves a
 * mark in the history. Every later change updates that same row, and reviewing the same item again
 * next sprint starts a new one. What is stored is a snapshot: the item as it was fetched, the
 * proposals that survived triage, and what was published. It is deliberately not reconciled with
 * the board afterwards — the item moves on and the record does not follow, which is what makes it
 * a record rather than a stale copy pretending to be live.
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

/** The analysis stage's answer. Only ever read now, out of sessions saved before the tab split. */
export interface StoryAnalysis {
  summary: string;
  invest: InvestVerdict[];
  findings: ReviewFinding[];
}

/**
 * The three things a review can publish.
 *
 * A menu, not an order. Each is decided in its own tab, staged into the draft on its own, and
 * published on its own — a description everyone agreed on can land while the tasks are still being
 * argued about, and a session that only ever touches the tasks never has to visit the other two.
 */
export const PUBLISH_PARTS = ["description", "criteria", "tasks"] as const;
export type PublishPart = (typeof PUBLISH_PARTS)[number];

/**
 * The screen's tabs, in order.
 *
 * `story` is what the work item says today, read-only and complete. The three middle tabs each own
 * one part of it: the current value on the left, what a model proposes on the right. `draft` is
 * the only one that writes, and it holds whatever the other three sent it.
 */
export const REVIEW_TABS = ["story", "description", "criteria", "tasks", "draft"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

/** Which AI stage a tab's Generate button runs. `story` and `draft` have none — one is a record
 *  and the other is a decision, and neither is a question for a model. */
export const STAGE_OF_TAB: Partial<Record<ReviewTab, WorkItemReviewStage>> = {
  description: "description",
  criteria: "criteria",
  tasks: "tasks",
};

/**
 * How far along a session is, and whether it can still be changed.
 *
 * `closed` and `published` are both endings and both read-only: what the tabs then show is the
 * review as it was left, with nothing to generate and nothing to edit. The difference between them
 * is only what happened to the board, which is worth saying in the history and nowhere else.
 */
export type ReviewStatus = "open" | "closed" | "published";

/**
 * One AI-proposed criterion as the screen holds it.
 *
 * `id` rather than an index because the user edits, deletes and reorders these while more of them
 * arrive: an index-keyed dismissal map quietly moves the deletion onto the neighbour the moment
 * anything above it goes.
 *
 * `pick` is the answer to a `format` of `ambos` — the two texts are the same requirement written
 * two ways, and exactly one of them goes to the draft.
 */
export interface CriterionProposal extends ProposedCriterion {
  id: string;
  pick: "gherkin" | "checklist";
}

export interface TaskProposal extends ProposedTask {
  id: string;
}

/** The description stage's answer, kept whole so the text and its rationale cannot drift apart. */
export interface DescriptionProposal {
  description: string;
  rationale: string;
  evidence: string[];
}

/**
 * What the user decided goes back to the board, and what already went.
 *
 * `null` means "nothing was sent for this part", which is different from an empty value: an empty
 * string is the user deliberately blanking a field, and publishing it would clear it on a board
 * other people read.
 *
 * **The criteria list is the whole final field, not just the new ones.** Azure's acceptance
 * criteria is one field and publishing replaces it, so a draft holding only the two criteria the
 * model proposed would silently delete the four the story already had. It is therefore seeded from
 * the story's own criteria the first time anything is sent to it — and a proposal that says it
 * `replaces` criterion 3 replaces the third entry rather than becoming a fifth.
 *
 * The tasks list is the opposite and for the opposite reason: tasks are *created* as children, so
 * what is staged is only ever the new ones.
 */
export interface ReviewDraft {
  description: string | null;
  criteria: string[] | null;
  tasks: { title: string; detail: string }[] | null;
}

const EMPTY_DRAFT: ReviewDraft = { description: null, criteria: null, tasks: null };

/**
 * A session as it goes to the database and comes back.
 *
 * Versioned because it is written to disk and read by a later build. Version 2 is the tab split:
 * it carries the work item itself (so a reopened session can render the story tab without going
 * back to Azure), the per-part proposals, the draft, and the session's status. A version 1 row
 * still opens — its story text, its criteria and its analysis are all still meaningful.
 */
export interface ReviewSessionPayload {
  version: 1 | 2;
  status: ReviewStatus;
  title: string;
  description: string;
  reproSteps: string;
  criteria: string[];
  /** The item as fetched, so the story tab has its children, its state and its estimate. */
  item: AdoWorkItem | null;
  /** Only ever read: written by builds that had a whole-story analysis stage. */
  analysis: StoryAnalysis | null;
  proposedDescription: DescriptionProposal | null;
  proposedCriteria: CriterionProposal[];
  proposedTasks: TaskProposal[];
  /** How many proposals each stage came back with, which is how "ran and found nothing" stays
   *  distinguishable from "never run" after the user has deleted every card. */
  producedByStage: Partial<Record<WorkItemReviewStage, number>>;
  draft: ReviewDraft;
  published: Partial<Record<PublishPart, { at: string; count: number }>>;
  projectIds: string[];
  useContext: boolean;
  /** What produced each stage, so a reopened review still says who judged it. */
  provenance: Partial<Record<WorkItemReviewStage, ReviewProvenance>>;
}

/** Which text of an `ambos` proposal the user is sending. */
function textOf(criterion: CriterionProposal): string {
  if (criterion.format === "checklist") return criterion.checklist;
  if (criterion.format === "gherkin") return criterion.gherkin;
  return criterion.pick === "checklist" ? criterion.checklist : criterion.gherkin;
}

interface WorkItemReviewState {
  /** What the user pasted: a link, or a bare id. */
  input: string;
  /** The organisation a bare id belongs to — filled from the last link, or from the batch target. */
  org: string;
  /**
   * The repositories the review reads. A story usually lives across more than one — the API that
   * exposes it and the front that consumes it — and reviewing it against only one is how half its
   * behaviour goes unchecked.
   *
   * Empty is a real choice, not a missing one: a workspace is a project, and a story written before
   * its code — or against a system with no checkout here — is still worth reviewing on its text.
   */
  projectIds: string[];
  /** Whether the workspace's saved context notes travel with the story. */
  useContext: boolean;
  loading: boolean;
  error: string;
  item: AdoWorkItem | null;

  /** The story as text, seeded from the work item. Read-only on screen: the story tab is a record,
   *  and the one editable copy of the description lives in the description tab. */
  title: string;
  description: string;
  /** A bug's steps. Kept apart from the description because in Azure they are different fields. */
  reproSteps: string;
  criteria: string[];

  analysis: StoryAnalysis | null;
  proposedDescription: DescriptionProposal | null;
  proposedCriteria: CriterionProposal[];
  proposedTasks: TaskProposal[];
  producedByStage: Partial<Record<WorkItemReviewStage, number>>;
  /** Run ids by stage — present means "in flight", which is also what the Stop button acts on. */
  runByStage: Partial<Record<WorkItemReviewStage, string>>;
  /** What produced each stage's answer: engine, model, version, how long it took. */
  provenance: Partial<Record<WorkItemReviewStage, ReviewProvenance>>;
  draft: ReviewDraft;
  published: Partial<Record<PublishPart, { at: string; count: number }>>;
  /** Which tab the screen is on. */
  tab: ReviewTab;
  /** The part currently being written to Azure, if any. */
  publishing: PublishPart | null;
  status: ReviewStatus;

  /** This session's row id. Minted on load; empty means nothing is on screen to save. */
  sessionId: string;
  /** When the session on screen was taken, for one reopened out of the history. */
  openedFrom: { at: string; id: string } | null;
  history: WorkItemReviewRow[];

  /** A change the last completed write did not cover. Drives the save button's wording. */
  dirty: boolean;
  /** A write in flight. */
  saving: boolean;
  /** When the last write landed, so the screen can say so rather than only imply it. */
  savedAt: string | null;

  setInput: (input: string) => void;
  setOrg: (org: string) => void;
  toggleProject: (projectId: string) => void;
  setUseContext: (useContext: boolean) => void;
  load: () => Promise<void>;
  run: (stage: WorkItemReviewStage) => Promise<void>;
  /** The tasks tab's three-way generate. `both` is two runs, DEV then QA, into one panel. */
  runTasks: (scope: "dev" | "qa" | "both") => Promise<void>;
  stop: (stage: WorkItemReviewStage) => Promise<void>;
  setTab: (tab: ReviewTab) => void;

  /** The description tab's editable copy of the field. */
  setDescription: (description: string) => void;
  setReproSteps: (reproSteps: string) => void;

  editCriterionProposal: (id: string, patch: Partial<CriterionProposal>) => void;
  removeCriterionProposal: (id: string) => void;
  clearCriterionProposals: () => void;
  editTaskProposal: (id: string, patch: Partial<TaskProposal>) => void;
  removeTaskProposal: (id: string) => void;
  clearTaskProposals: () => void;
  clearDescriptionProposal: () => void;

  /** Moves the tab's own text into the draft, and empties the proposal panel it came from. */
  sendDescriptionToDraft: () => void;
  sendCriterionToDraft: (id: string) => void;
  sendAllCriteriaToDraft: () => void;
  sendTaskToDraft: (id: string) => void;
  sendAllTasksToDraft: () => void;

  setDraftDescription: (text: string) => void;
  setDraftCriterion: (at: number, value: string) => void;
  removeDraftCriterion: (at: number) => void;
  addDraftCriterion: () => void;
  setDraftTask: (at: number, patch: { title?: string; detail?: string }) => void;
  removeDraftTask: (at: number) => void;
  discardDraft: (part: PublishPart) => void;

  /** Writes one staged part to Azure DevOps. The only thing in this store that changes the board. */
  publish: (part: PublishPart) => Promise<void>;
  /** Publishes everything staged, ends the session as `published`, and clears the screen. */
  publishAll: () => Promise<void>;
  /** Ends the session without publishing and clears the screen. The record keeps everything. */
  close: () => Promise<void>;
  /** Clears the screen without ending the session — it stays in the history as a draft. */
  dismiss: () => Promise<void>;
  /** Writes the session as it stands. Called after every change; safe to call at any time. */
  persist: () => Promise<void>;
  /** Writes now instead of when the typing stops. What the save button calls. */
  saveNow: () => Promise<void>;
  loadHistory: () => Promise<void>;
  openFromHistory: (row: WorkItemReviewRow) => void;
  removeFromHistory: (id: string) => Promise<void>;
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
  proposedDescription: null as DescriptionProposal | null,
  proposedCriteria: [] as CriterionProposal[],
  proposedTasks: [] as TaskProposal[],
  producedByStage: {} as Partial<Record<WorkItemReviewStage, number>>,
  provenance: {} as Partial<Record<WorkItemReviewStage, ReviewProvenance>>,
  // Cleared with the rest: a run still registered here after the session was replaced would let a
  // late answer land on the new story. The engine process is left to finish on its own — stopping
  // it is the user's call, and its output simply has nowhere to go now.
  runByStage: {} as Partial<Record<WorkItemReviewStage, string>>,
  draft: EMPTY_DRAFT,
  published: {} as Partial<Record<PublishPart, { at: string; count: number }>>,
  tab: "story" as ReviewTab,
  publishing: null,
  status: "open" as ReviewStatus,
  sessionId: "",
  openedFrom: null,
  dirty: false,
  saving: false,
  savedAt: null as string | null,
};

/** A session that has ended takes no more changes — every mutator asks this first. */
function editable(status: ReviewStatus): boolean {
  return status === "open";
}

export const useWorkItemReviewStore = create<WorkItemReviewState>((set, get) => ({
  input: "",
  org: "",
  projectIds: [],
  useContext: false,
  history: [],
  ...EMPTY,

  setInput: (input) => set({ input }),
  setOrg: (org) => set({ org }),
  toggleProject: (projectId) =>
    set((s) => ({
      projectIds: s.projectIds.includes(projectId)
        ? s.projectIds.filter((id) => id !== projectId)
        : [...s.projectIds, projectId],
    })),
  setUseContext: (useContext) => set({ useContext }),
  setTab: (tab) => set({ tab }),

  setDescription: (description) => {
    if (!editable(get().status)) return;
    set({ description });
    void saveSoon();
  },
  setReproSteps: (reproSteps) => {
    if (!editable(get().status)) return;
    set({ reproSteps });
    void saveSoon();
  },

  // ---------- the proposal panels ----------

  editCriterionProposal: (id, patch) => {
    if (!editable(get().status)) return;
    set((s) => ({
      proposedCriteria: s.proposedCriteria.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
    void saveSoon();
  },
  removeCriterionProposal: (id) => {
    if (!editable(get().status)) return;
    set((s) => ({ proposedCriteria: s.proposedCriteria.filter((c) => c.id !== id) }));
    void saveSoon();
  },
  clearCriterionProposals: () => {
    if (!editable(get().status)) return;
    // The count goes with the cards. An emptied panel is "nothing here", not "the model found
    // nothing" — saying the second would put words in its mouth the user typed themselves.
    set((s) => ({ proposedCriteria: [], producedByStage: without(s.producedByStage, "criteria") }));
    void saveSoon();
  },
  editTaskProposal: (id, patch) => {
    if (!editable(get().status)) return;
    set((s) => ({ proposedTasks: s.proposedTasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    void saveSoon();
  },
  removeTaskProposal: (id) => {
    if (!editable(get().status)) return;
    set((s) => ({ proposedTasks: s.proposedTasks.filter((t) => t.id !== id) }));
    void saveSoon();
  },
  clearTaskProposals: () => {
    if (!editable(get().status)) return;
    set((s) => ({
      proposedTasks: [],
      producedByStage: without(without(s.producedByStage, "tasks"), "tasksqa"),
    }));
    void saveSoon();
  },
  clearDescriptionProposal: () => {
    if (!editable(get().status)) return;
    set((s) => ({
      proposedDescription: null,
      producedByStage: without(s.producedByStage, "description"),
    }));
    void saveSoon();
  },

  // ---------- into the draft ----------

  sendDescriptionToDraft: () => {
    const s = get();
    if (!editable(s.status)) return;
    const text = s.proposedDescription?.description.trim();
    if (!text) {
      pushErrorToast(translate("huReview.stageEmpty"));
      return;
    }
    set({
      draft: { ...s.draft, description: text },
      // Cleared on the way out: the panel's job was to hold this until it was decided, and leaving
      // a copy behind invites sending the same text a second time.
      proposedDescription: null,
      producedByStage: without(s.producedByStage, "description"),
    });
    useToastStore.getState().pushToast(translate("huReview.sentToDraft"), "success");
    void saveSoon();
  },

  sendCriterionToDraft: (id) => {
    const s = get();
    if (!editable(s.status)) return;
    const proposal = s.proposedCriteria.find((c) => c.id === id);
    if (!proposal) return;
    const text = textOf(proposal).trim();
    if (!text) {
      pushErrorToast(translate("huReview.stageEmpty"));
      return;
    }
    set({
      draft: { ...s.draft, criteria: mergeCriterion(s.draft.criteria ?? s.criteria, proposal, text) },
      proposedCriteria: s.proposedCriteria.filter((c) => c.id !== id),
    });
    useToastStore.getState().pushToast(translate("huReview.sentToDraft"), "success");
    void saveSoon();
  },

  sendAllCriteriaToDraft: () => {
    const s = get();
    if (!editable(s.status)) return;
    const kept = s.proposedCriteria.filter((c) => textOf(c).trim());
    if (kept.length === 0) {
      pushErrorToast(translate("huReview.stageEmpty"));
      return;
    }
    // Folded in order, each onto the result of the last, so two proposals rewriting the same
    // criterion end as one entry rather than as the second silently landing beside the first.
    let criteria = s.draft.criteria ?? s.criteria;
    for (const proposal of kept) criteria = mergeCriterion(criteria, proposal, textOf(proposal).trim());
    set({
      draft: { ...s.draft, criteria },
      proposedCriteria: [],
      producedByStage: without(s.producedByStage, "criteria"),
    });
    useToastStore.getState().pushToast(translate("huReview.sentToDraft"), "success");
    void saveSoon();
  },

  sendTaskToDraft: (id) => {
    const s = get();
    if (!editable(s.status)) return;
    const proposal = s.proposedTasks.find((t) => t.id === id);
    if (!proposal?.title.trim()) return;
    set({
      draft: { ...s.draft, tasks: appendTask(s.draft.tasks ?? [], proposal) },
      proposedTasks: s.proposedTasks.filter((t) => t.id !== id),
    });
    useToastStore.getState().pushToast(translate("huReview.sentToDraft"), "success");
    void saveSoon();
  },

  sendAllTasksToDraft: () => {
    const s = get();
    if (!editable(s.status)) return;
    const kept = s.proposedTasks.filter((t) => t.title.trim());
    if (kept.length === 0) {
      pushErrorToast(translate("huReview.stageEmpty"));
      return;
    }
    // DEV before QA whatever order they were generated in: the board reads better when the work
    // comes before the verification of it, and "both" runs the two stages independently.
    const ordered = [...kept].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dev" ? -1 : 1));
    let tasks = s.draft.tasks ?? [];
    for (const proposal of ordered) tasks = appendTask(tasks, proposal);
    set({
      draft: { ...s.draft, tasks },
      proposedTasks: [],
      producedByStage: without(without(s.producedByStage, "tasks"), "tasksqa"),
    });
    useToastStore.getState().pushToast(translate("huReview.sentToDraft"), "success");
    void saveSoon();
  },

  // ---------- the draft itself ----------

  setDraftDescription: (text) => {
    if (!editable(get().status)) return;
    set((s) => ({ draft: { ...s.draft, description: text } }));
    void saveSoon();
  },
  setDraftCriterion: (at, value) => {
    if (!editable(get().status)) return;
    set((s) => ({
      draft: { ...s.draft, criteria: (s.draft.criteria ?? []).map((c, i) => (i === at ? value : c)) },
    }));
    void saveSoon();
  },
  removeDraftCriterion: (at) => {
    if (!editable(get().status)) return;
    set((s) => ({
      draft: { ...s.draft, criteria: (s.draft.criteria ?? []).filter((_, i) => i !== at) },
    }));
    void saveSoon();
  },
  addDraftCriterion: () => {
    if (!editable(get().status)) return;
    set((s) => ({ draft: { ...s.draft, criteria: [...(s.draft.criteria ?? s.criteria), ""] } }));
    void saveSoon();
  },
  setDraftTask: (at, patch) => {
    if (!editable(get().status)) return;
    set((s) => ({
      draft: {
        ...s.draft,
        tasks: (s.draft.tasks ?? []).map((task, i) => (i === at ? { ...task, ...patch } : task)),
      },
    }));
    void saveSoon();
  },
  removeDraftTask: (at) => {
    if (!editable(get().status)) return;
    set((s) => ({ draft: { ...s.draft, tasks: (s.draft.tasks ?? []).filter((_, i) => i !== at) } }));
    void saveSoon();
  },
  discardDraft: (part) => {
    if (!editable(get().status)) return;
    set((s) => ({ draft: { ...s.draft, [part]: null } }));
    void saveSoon();
  },

  // ---------- loading ----------

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
        // A fresh id per load, which is what makes this sitting one history entry and a re-review
        // of the same item next sprint a second one.
        sessionId: crypto.randomUUID(),
        // The lookup is done: leaving the reference in the box makes Load look armed when what it
        // would do is fetch the item already on screen.
        input: "",
        org: resolved,
        item,
        title: item.title,
        description: htmlToText(item.description_html),
        reproSteps: htmlToText(item.repro_steps_html),
        criteria: splitCriteriaHtml(item.acceptance_criteria_html),
      });
      // Saved before anything has been asked of a model. Loading an item *is* the start of a
      // review, and a session the user only read is still a session they can come back to.
      await get()
        .persist()
        .catch((e: unknown) => pushErrorToast(String(e)));
    } catch (e: unknown) {
      set({ loading: false, error: String(e) });
    }
  },

  // ---------- the runs ----------

  run: async (stage) => {
    const state = get();
    if (state.runByStage[stage] || !state.item || !editable(state.status)) return;
    const workspaceId = activeWorkspaceId();
    if (!workspaceId) return;

    const runId = newRunId("hu-review");
    // Before the invoke, or the first lines the engine prints have nowhere to land.
    useAiRunStore.getState().start(runId);
    set((s) => ({ runByStage: { ...s.runByStage, [stage]: runId } }));

    try {
      const result = await reviewWorkItem({
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
        useContext: state.useContext,
        runId,
      });

      // The session may have moved on: loading another work item, or opening one from the history,
      // replaces everything while this run is still in flight. `runByStage` is cleared by both, so
      // a run whose id is no longer registered is a run whose answer belongs to a story that is no
      // longer on screen — and writing it here would put story A's proposals under story B, then
      // save them there.
      if (get().runByStage[stage] !== runId) return;

      const { review, ...provenance } = result;
      if (review.stage === "description") {
        const produced = review.description.trim() ? 1 : 0;
        set((s) => ({
          proposedDescription: produced
            ? {
                description: review.description,
                rationale: review.rationale,
                evidence: review.evidence,
              }
            : null,
          producedByStage: { ...s.producedByStage, description: produced },
        }));
      } else if (review.stage === "criteria") {
        set((s) => ({
          // Appended, not replaced: a second run against a story the user has since edited is a
          // second opinion, and throwing away the first would take the cards they were still
          // reading with it. The Clear button is right there for the user who wants a blank panel.
          proposedCriteria: [...s.proposedCriteria, ...review.criteria.map(asCriterionProposal)],
          producedByStage: { ...s.producedByStage, criteria: review.criteria.length },
        }));
      } else if (review.stage === "tasks") {
        set((s) => ({
          proposedTasks: [...s.proposedTasks, ...review.tasks.map(asTaskProposal)],
          producedByStage: { ...s.producedByStage, [stage]: review.tasks.length },
        }));
      }
      set((s) => ({ provenance: { ...s.provenance, [stage]: provenance } }));
      // Saved once the stage has landed in state, so what is written is what is on screen. A
      // failure to save is reported and no more: the review itself is still in front of the user,
      // and losing the copy is not a reason to also throw away the answer.
      void get()
        .persist()
        .catch((e: unknown) => pushErrorToast(String(e)));
    } catch (e: unknown) {
      // A stopped run is not a failure: nothing was written, and the previous answer is still on
      // screen exactly as it was.
      //
      // Parsed rather than raw: a provider refusal arrives tagged with the quota marker, and
      // `String(e)` would put that machine prefix in front of the sentence the user reads.
      if (!isCancellation(e)) pushErrorToast(parseClaudeError(String(e)).message);
    } finally {
      useAiRunStore.getState().finish(runId);
      set((s) => ({ runByStage: without(s.runByStage, stage) }));
    }
  },

  runTasks: async (scope) => {
    // Sequential rather than concurrent: the two runs lease the same repositories, and the second
    // would be refused by the lock the first is holding.
    if (scope === "dev" || scope === "both") await get().run("tasks");
    if (scope === "qa" || scope === "both") await get().run("tasksqa");
  },

  stop: async (stage) => {
    const runId = get().runByStage[stage];
    if (runId) await useAiRunStore.getState().cancel(runId);
  },

  /**
   * Writes one staged part to Azure DevOps.
   *
   * The only thing in this store that changes something other people are working from, so it is
   * deliberately narrow: one part at a time, only what is in the draft, and never a field the user
   * did not stage. A bug's prose goes to Repro Steps rather than Description — they are different
   * fields in Azure, and writing a bug's steps into Description puts them where the bug form does
   * not show them.
   */
  publish: async (part) => {
    const s = get();
    if (s.publishing || !s.item) return;
    const org = s.org.trim();
    if (!org) {
      pushErrorToast(translate("huReview.orgMissing"));
      return;
    }

    set({ publishing: part });
    try {
      const count = await writePart(part);
      if (count === null) return;
      set((state) => ({
        published: { ...state.published, [part]: { at: new Date().toISOString(), count } },
      }));
      useToastStore.getState().pushToast(translate("huReview.published"), "success");
      void get()
        .persist()
        .catch((e: unknown) => pushErrorToast(String(e)));
    } catch (e: unknown) {
      pushErrorToast(parseClaudeError(String(e)).message);
    } finally {
      set({ publishing: null });
    }
  },

  publishAll: async () => {
    const s = get();
    if (s.publishing || !s.item) return;
    if (!s.org.trim()) {
      pushErrorToast(translate("huReview.orgMissing"));
      return;
    }
    const staged = PUBLISH_PARTS.filter((part) => hasPart(get().draft, part));
    if (staged.length === 0) return;

    try {
      for (const part of staged) {
        set({ publishing: part });
        const count = await writePart(part);
        if (count === null) continue;
        set((state) => ({
          published: { ...state.published, [part]: { at: new Date().toISOString(), count } },
        }));
      }
      // Only once every part landed. A failure part-way through throws out of the loop and leaves
      // the session open, which is the point: closing a review whose criteria never reached the
      // board would file a half-published story as done.
      set({ status: "published" });
      useToastStore.getState().pushToast(translate("huReview.published"), "success");
    } catch (e: unknown) {
      pushErrorToast(parseClaudeError(String(e)).message);
    } finally {
      set({ publishing: null });
      // Awaited rather than fired off, because the screen is cleared next and a save that reads the
      // state after that would find nothing to write.
      await get()
        .persist()
        .catch((e: unknown) => pushErrorToast(String(e)));
      // A published session is a record, and the place to read a record is the history. Leaving a
      // read-only copy on screen only invites editing what is already on the board.
      if (get().status === "published") set({ ...EMPTY });
    }
  },

  close: async () => {
    if (!get().item || !editable(get().status)) return;
    set({ status: "closed" });
    await stopEverything();
    cancelSave();
    await get()
      .persist()
      .catch((e: unknown) => pushErrorToast(String(e)));
    set({ ...EMPTY });
    useToastStore.getState().pushToast(translate("huReview.closedToast"), "success");
  },

  /**
   * Takes the session off the screen without ending it.
   *
   * The counterpart to closing: the review is not finished, it is merely not what you are looking
   * at right now. It stays in the history as a draft, with everything staged in it, and opening it
   * from there puts it back exactly as it was.
   *
   * Saved before it is cleared: the write is debounced, so the last thing typed may still be in the
   * air, and clearing first would leave that save with nothing to write.
   */
  dismiss: async () => {
    if (!get().item) return;
    await stopEverything();
    cancelSave();
    await get()
      .persist()
      .catch((e: unknown) => pushErrorToast(String(e)));
    set({ ...EMPTY });
    useToastStore.getState().pushToast(translate("huReview.setAsideDone"), "success");
  },

  persist: async () => {
    const s = get();
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!s.item || !s.sessionId || !workspaceId) return;
    // The edit this write is about to cover. Anything typed while it is in flight bumps the counter
    // again, and the session stays dirty rather than being reported saved on the strength of a
    // write that went out before it.
    const covering = edits;
    set({ saving: true });

    const payload: ReviewSessionPayload = {
      version: 2,
      status: s.status,
      title: s.title,
      description: s.description,
      reproSteps: s.reproSteps,
      criteria: s.criteria,
      item: s.item,
      analysis: s.analysis,
      proposedDescription: s.proposedDescription,
      proposedCriteria: s.proposedCriteria,
      proposedTasks: s.proposedTasks,
      producedByStage: s.producedByStage,
      draft: s.draft,
      published: s.published,
      projectIds: s.projectIds,
      useContext: s.useContext,
      provenance: s.provenance,
    };
    // Whichever stage ran last names the engine on the row. They share one config, so they agree;
    // picking the newest keeps a row stamped rather than blank when only one has run.
    const stamped = Object.values(s.provenance);
    const latest: ReviewProvenance | undefined = stamped[stamped.length - 1];
    try {
      await saveWorkItemReview({
        id: s.sessionId,
        workspaceId,
        org: s.org,
        workItemId: s.item.id,
        workItemType: s.item.work_item_type,
        workItemUrl: s.item.url,
        title: s.title,
        payload: JSON.stringify(payload),
        engine: latest?.engine ?? "",
        model: latest?.model ?? "",
        version: latest?.version ?? "",
      });
      set({ saving: false, dirty: edits !== covering, savedAt: new Date().toISOString() });
    } catch (e: unknown) {
      // Left dirty on purpose. A write that failed is not a saved session, and a button that says
      // "saved" anyway would be the only notice the user ever got of losing it.
      set({ saving: false, dirty: true });
      throw e;
    }
    await get().loadHistory();
  },

  saveNow: async () => {
    // The pending debounce is dropped rather than left to fire: it would write the same session a
    // second time, and its landing after this one would stamp an older time on the row.
    cancelSave();
    await get()
      .persist()
      .catch((e: unknown) => pushErrorToast(String(e)));
  },

  loadHistory: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!workspaceId) return;
    const history = await listWorkItemReviews(workspaceId).catch((e: unknown) => {
      pushErrorToast(String(e));
      return [] as WorkItemReviewRow[];
    });
    set({ history });
  },

  /**
   * Puts a saved session back on screen.
   *
   * Nothing is fetched: this is the review as it was taken, and going to Azure for a fresh copy
   * would quietly replace the text that was judged with text that has since changed — which is the
   * one thing a record must not do. `openedFrom` is what the screen uses to say so; the Load button
   * is right there for the user who does want today's version.
   */
  openFromHistory: (row) => {
    let payload: Partial<ReviewSessionPayload> = {};
    try {
      payload = JSON.parse(row.payload) as ReviewSessionPayload;
    } catch {
      // A row written by a build that has since changed shape still opens — with whatever the
      // header carries. Refusing to open it would be losing the record to protect it.
      pushErrorToast(translate("huReview.historyUnreadable"));
    }

    set({
      ...EMPTY,
      sessionId: row.id,
      openedFrom: { at: row.updated_at, id: row.id },
      org: row.ado_org,
      input: "",
      status: payload.status ?? "open",
      // A version 2 row carries the item it fetched. A version 1 row does not, so it gets enough
      // of one to render the header: its children lived on the board and belong to whatever it
      // says today, not to what it said then.
      item: payload.item ?? {
        id: row.work_item_id,
        url: row.work_item_url,
        work_item_type: row.work_item_type,
        title: payload.title ?? row.title,
        state: "",
        team_project: "",
        description_html: "",
        repro_steps_html: "",
        system_info_html: "",
        acceptance_criteria_html: "",
        effort: 0,
        effort_field: "",
        tags: "",
        area_path: "",
        iteration_path: "",
        children: [],
      },
      title: payload.title ?? row.title,
      description: payload.description ?? "",
      reproSteps: payload.reproSteps ?? "",
      criteria: payload.criteria ?? [],
      analysis: payload.analysis ?? null,
      proposedDescription: payload.proposedDescription ?? null,
      // Re-stamped with ids rather than trusted to have them: a version 1 row's proposals have
      // none, and a card with no id cannot be edited or deleted.
      proposedCriteria: (payload.proposedCriteria ?? []).map(asCriterionProposal),
      proposedTasks: (payload.proposedTasks ?? []).map(asTaskProposal),
      producedByStage: payload.producedByStage ?? {},
      provenance: payload.provenance ?? {},
      projectIds: payload.projectIds ?? [],
      useContext: payload.useContext ?? false,
      draft: payload.draft ?? EMPTY_DRAFT,
      published: payload.published ?? {},
    });
  },

  removeFromHistory: async (id) => {
    await deleteWorkItemReview(id).catch((e: unknown) => pushErrorToast(String(e)));
    // A session deleted while it is on screen keeps its content but loses its row: the next save
    // would otherwise silently resurrect what the user just threw away.
    if (get().sessionId === id) set({ sessionId: "", openedFrom: null });
    await get().loadHistory();
  },
}));

// ---------- helpers ----------

/**
 * One key gone, without mutating what the rest of the state still points at.
 *
 * `NoInfer` on the key so the map's own key type wins: without it, `without(byStage, "tasks")`
 * narrows the whole record to `Record<"tasks", …>` and the next call in the chain is rejected for
 * naming a stage the first one just legislated out of existence.
 */
function without<K extends string, V>(held: Partial<Record<K, V>>, key: NoInfer<K>): Partial<Record<K, V>> {
  const { [key]: _gone, ...rest } = held;
  return rest as Partial<Record<K, V>>;
}

/** A proposal as the screen holds it: with an id it can be edited and deleted by, and with the
 *  format's own text pre-picked so an `ambos` card opens showing something. */
function asCriterionProposal(criterion: ProposedCriterion | CriterionProposal): CriterionProposal {
  return {
    format: criterion.format ?? "gherkin",
    gherkin: criterion.gherkin ?? "",
    checklist: criterion.checklist ?? "",
    rationale: criterion.rationale ?? "",
    replaces: criterion.replaces ?? 0,
    evidence: criterion.evidence ?? [],
    repo: criterion.repo ?? "",
    id: crypto.randomUUID(),
    pick:
      "pick" in criterion && criterion.pick
        ? criterion.pick
        : criterion.format === "checklist"
          ? "checklist"
          : "gherkin",
  };
}

function asTaskProposal(task: ProposedTask | TaskProposal): TaskProposal {
  return {
    kind: task.kind === "qa" ? "qa" : "dev",
    title: task.title ?? "",
    detail: task.detail ?? "",
    what: task.what ?? "",
    how: task.how ?? "",
    why: task.why ?? "",
    evidence: task.evidence ?? [],
    repo: task.repo ?? "",
    id: crypto.randomUUID(),
  };
}

/**
 * One proposal folded into the criteria list that will replace the field.
 *
 * A proposal that names the criterion it rewrites lands *on* that criterion, keeping the list's
 * order and length. One that names nothing is an addition. Anything out of range is treated as an
 * addition rather than dropped: a model that miscounted still wrote a criterion worth keeping.
 */
function mergeCriterion(criteria: string[], proposal: CriterionProposal, text: string): string[] {
  const at = proposal.replaces - 1;
  if (at >= 0 && at < criteria.length) return criteria.map((held, i) => (i === at ? text : held));
  return [...criteria, text];
}

/** Matched on title, because that is the identity a user reads. Sending the same proposal twice is
 *  a double click, not a request for two tasks. */
function appendTask(
  tasks: { title: string; detail: string }[],
  proposal: TaskProposal,
): { title: string; detail: string }[] {
  if (tasks.some((held) => held.title === proposal.title)) return tasks;
  return [...tasks, { title: proposal.title, detail: proposal.detail }];
}

/** Whether the draft holds anything for this part. */
function hasPart(draft: ReviewDraft, part: PublishPart): boolean {
  if (part === "tasks") return (draft.tasks?.length ?? 0) > 0;
  return draft[part] !== null;
}

/** Whether the draft holds anything at all, which is what enables its tab. */
export function draftIsEmpty(draft: ReviewDraft): boolean {
  return !PUBLISH_PARTS.some((part) => hasPart(draft, part));
}

/**
 * Writes one part to the board and answers how many items it wrote, or `null` if there was
 * nothing staged for it. Shared by the one-part button and by Publish everything, so the two can
 * never disagree about which Azure field a part lands in.
 */
async function writePart(part: PublishPart): Promise<number | null> {
  const s = useWorkItemReviewStore.getState();
  const item = s.item;
  if (!item) return null;
  const org = s.org.trim();

  if (part === "description") {
    const text = s.draft.description;
    if (text === null) return null;
    // Emptied on purpose is still emptied: publishing it would blank the field on a board other
    // people are reading, and "I deleted the text and pressed Publish" is not a sentence anybody
    // means as "clear the description". Refused rather than allowed-and-warned.
    if (!text.trim()) {
      pushErrorToast(translate("huReview.stageEmpty"));
      return null;
    }
    const isBug = kindOf(item.work_item_type) === "bug";
    // Rendered here rather than in Rust because this is the side that has a Markdown parser and a
    // sanitiser, and the tab the text was written in is a Markdown editor. `renderMarkdown` runs
    // its output through DOMPurify, so what leaves for the board carries no script or handler
    // even when the model wrote some.
    const html = renderMarkdown(text);
    await adoUpdateWorkItem({
      org,
      id: item.id,
      title: s.title.trim() || undefined,
      proseIsHtml: true,
      ...(isBug ? { reproSteps: html } : { description: html }),
    });
    return 1;
  }

  if (part === "criteria") {
    const criteria = s.draft.criteria?.filter((criterion) => criterion.trim());
    if (!criteria) return null;
    // Same reason as the description, and worse here: publishing an empty list replaces every
    // criterion the story had with nothing.
    if (criteria.length === 0) {
      pushErrorToast(translate("huReview.stageEmpty"));
      return null;
    }
    await adoUpdateWorkItem({ org, id: item.id, acceptanceCriteria: criteria });
    return criteria.length;
  }

  const tasks = s.draft.tasks;
  if (!tasks?.length) return null;
  // The project the story lives in, because a child is created inside a project and the
  // organisation alone does not name one.
  const project = item.team_project.trim();
  if (!project) throw new Error(translate("huReview.noTeamProject"));
  const created = await adoCreateChildTasks({
    org,
    project,
    parentId: item.id,
    workItemType: "Task",
    tasks,
  });
  return created.length;
}

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

/**
 * A save, once the typing stops.
 *
 * Every edit on this screen is worth keeping — the session is a record, and losing the last
 * paragraph because the user closed the tab is exactly the failure the history exists to prevent.
 * Writing on every keystroke would put a SQLite round trip behind each one, so the write is
 * coalesced: the last change within the window is the one that lands, and it lands whole.
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every change. What a write covers is the value it read when it started. */
let edits = 0;
function saveSoon() {
  edits += 1;
  // Said as soon as it is true, not when the write starts: the seconds between a keystroke and the
  // save are exactly when the user wants to know there is something unsaved.
  useWorkItemReviewStore.setState({ dirty: true });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void useWorkItemReviewStore
      .getState()
      .persist()
      .catch((e: unknown) => pushErrorToast(String(e)));
  }, 800);
}

function cancelSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

/**
 * Stops whatever is still generating, for the two ways a session leaves the screen.
 *
 * Its answer had nowhere to land the moment the screen was cleared, and an engine left running is
 * one still spending tokens on a review nobody is looking at.
 */
async function stopEverything(): Promise<void> {
  const store = useWorkItemReviewStore.getState();
  for (const stage of Object.keys(store.runByStage) as WorkItemReviewStage[]) {
    await store.stop(stage).catch((e: unknown) => pushErrorToast(String(e)));
  }
}

/** What a criterion proposal sends to the draft, given the format the user settled on. */
export function criterionText(criterion: CriterionProposal): string {
  return textOf(criterion);
}

/** Whether a proposal rewrites one of the story's own criteria, which the screen colours. */
export function isRewrite(criterion: CriterionProposal, criteriaCount: number): boolean {
  return criterion.replaces > 0 && criterion.replaces <= criteriaCount;
}
