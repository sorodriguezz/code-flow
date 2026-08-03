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
import { htmlToText, splitCriteria, storyPayload } from "../lib/workItemHtml";
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
 * The three AI stages are separate calls on purpose — analysis, then criteria, then tasks — because
 * each is meant to read a story the user has already curated with what the previous one proposed.
 *
 * **Sessions are saved.** Each stage that produces something writes the whole session to
 * `work_item_reviews` under `sessionId`, which is minted when a work item is loaded: the three
 * stages of one sitting update one row, and reviewing the same item again next sprint starts a new
 * one. What is stored is a *snapshot* — the story as the user edited it locally, and the proposals
 * that survived their triage. It is deliberately not reconciled with the board afterwards: the item
 * moves on and the record does not follow it, which is what makes it a record rather than a stale
 * copy pretending to be live. Reopening one says when it was taken, and reloading from Azure is one
 * click away.
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

/**
 * The three things a review can publish, in the order they are decided.
 *
 * An order, not a menu: the criteria are written against a description the team has agreed on, and
 * the tasks against those criteria. Publishing tasks for a story whose description is still being
 * argued about is how a board fills with work nobody committed to.
 */
export const PUBLISH_STEPS = ["description", "criteria", "tasks"] as const;
export type PublishStep = (typeof PUBLISH_STEPS)[number];

/**
 * The one path through the screen, in order.
 *
 * `analysis` opens it and is deliberately not a publish step: it is a judgement about the whole
 * story — INVEST, and the findings — and there is no field on the board it corresponds to. Every
 * other step is a decision about one part of the item, and the three columns filter to it.
 *
 * The screen used to carry two of these at once: the AI runs (analizar / criterios / tareas) and
 * the publish steps (descripción / criterios / tareas). Two near-identical triads that shared two
 * of their three names, so neither read as a path. There is one now, and the AI run for a step
 * lives inside that step's own column.
 */
export const REVIEW_STEPS = ["analysis", "description", "criteria", "tasks"] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

/** Which AI stage, if any, produces the proposals for a step. `description` has none of its own —
 *  what it gets to work with are the analysis findings aimed at the story's prose. */
export const STAGE_OF_STEP: Partial<Record<ReviewStep, WorkItemReviewStage>> = {
  analysis: "analyze",
  criteria: "criteria",
  tasks: "tasks",
};

/**
 * What is staged to go back to the board, and what already went.
 *
 * Separate from the story on the left on purpose. The middle column is what the AI proposes and the
 * left is what the item says today; neither is a decision. This is the decision — nothing reaches
 * Azure that the user did not put here first, and each step publishes on its own so a description
 * everyone agrees on can land while the tasks are still being argued about.
 */
export interface PublishQueue {
  /** The description (or, for a bug, the steps) as it will be written. `null` means "not staged". */
  description: string | null;
  criteria: string[] | null;
  tasks: { title: string; detail: string }[] | null;
  /** Steps already written to the board this session, so the UI stops offering to send them twice. */
  published: Partial<Record<PublishStep, { at: string; count: number }>>;
}

const EMPTY_QUEUE: PublishQueue = {
  description: null,
  criteria: null,
  tasks: null,
  published: {},
};

/**
 * A session as it goes to the database and comes back.
 *
 * Versioned because it is written to disk and read by a later build: a row saved today has to stay
 * readable when the screen grows a field, and `version` is what lets a future reader tell "this
 * predates X" from "this lost X".
 */
export interface ReviewSessionPayload {
  version: 1;
  title: string;
  description: string;
  reproSteps: string;
  criteria: string[];
  analysis: StoryAnalysis | null;
  proposedCriteria: ProposedCriterion[];
  proposedTasks: ProposedTask[];
  dismissed: Record<string, true>;
  projectIds: string[];
  useContext: boolean;
  /** What produced each stage, so a reopened review still says who judged it. */
  provenance: Partial<Record<WorkItemReviewStage, ReviewProvenance>>;
  /** What was staged to publish, and what of it had already gone. */
  queue: PublishQueue;
}

interface WorkItemReviewState {
  /** What the user pasted: a link, or a bare id. */
  input: string;
  /** The organisation a bare id belongs to — filled from the last link, or from the batch target. */
  org: string;
  /**
   * The repositories the analysis reads. A story usually lives across more than one — the API that
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
  /** What produced each stage's answer: engine, model, version, how long it took. */
  provenance: Partial<Record<WorkItemReviewStage, ReviewProvenance>>;
  /** The third column: what the user decided goes back to the board. */
  queue: PublishQueue;
  /** Which step the screen is walking the user through. */
  step: ReviewStep;
  /** The step currently being written to Azure, if any. */
  publishing: PublishStep | null;

  /** This session's row id. Minted on load; empty means nothing worth saving has happened yet. */
  sessionId: string;
  /** When the session on screen was taken, for one reopened out of the history. */
  openedFrom: { at: string; id: string } | null;
  history: WorkItemReviewRow[];

  setInput: (input: string) => void;
  setOrg: (org: string) => void;
  toggleProject: (projectId: string) => void;
  setUseContext: (useContext: boolean) => void;
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
  setStep: (step: ReviewStep) => void;
  /** Puts the story's current text, or a proposal, into the publish column. */
  stageDescription: (text: string) => void;
  stageCriteria: (criteria: string[]) => void;
  stageTask: (task: { title: string; detail: string }) => void;
  unstageTask: (at: number) => void;
  clearStep: (step: PublishStep) => void;
  /** Writes one staged step to Azure DevOps. The only thing in this store that changes the board. */
  publish: (step: PublishStep) => Promise<void>;
  /** Writes the session as it stands. Called after each stage lands; safe to call at any time. */
  persist: () => Promise<void>;
  loadHistory: () => Promise<void>;
  openFromHistory: (row: WorkItemReviewRow) => void;
  removeFromHistory: (id: string) => Promise<void>;
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
  provenance: {} as Partial<Record<WorkItemReviewStage, ReviewProvenance>>,
  // Cleared with the rest: a run still registered here after the session was replaced would let a
  // late answer land on the new story. The engine process is left to finish on its own — stopping
  // it is the user's call, and its output simply has nowhere to go now.
  runByStage: {} as Partial<Record<WorkItemReviewStage, string>>,
  queue: EMPTY_QUEUE,
  step: "analysis" as ReviewStep,
  publishing: null,
  sessionId: "",
  openedFrom: null,
};

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
  setTitle: (title) => set({ title }),
  setDescription: (description) => set({ description }),
  setReproSteps: (reproSteps) => set({ reproSteps }),
  setCriterion: (at, value) =>
    set((s) => ({ criteria: s.criteria.map((c, i) => (i === at ? value : c)) })),
  addCriterion: (value) => set((s) => ({ criteria: [...s.criteria, value] })),
  removeCriterion: (at) => set((s) => ({ criteria: s.criteria.filter((_, i) => i !== at) })),
  dismiss: (key) => set((s) => ({ dismissed: { ...s.dismissed, [key]: true } })),
  setStep: (step) => set({ step }),

  // Staging empties is refused rather than allowed-and-warned. `null` means "not staged" and an
  // empty string means "the user emptied this on purpose", so an accidental empty stage would arm
  // Publish with a payload that blanks the field on a board other people are reading.
  stageDescription: (text) => {
    if (!text.trim()) {
      pushErrorToast(translate("huReview.stageEmpty"));
      return;
    }
    set((s) => ({ queue: { ...s.queue, description: text } }));
  },
  stageCriteria: (criteria) => {
    const kept = criteria.filter((criterion) => criterion.trim());
    if (kept.length === 0) {
      pushErrorToast(translate("huReview.stageEmpty"));
      return;
    }
    set((s) => ({ queue: { ...s.queue, criteria: kept } }));
  },
  stageTask: (task) =>
    set((s) => ({
      queue: {
        ...s.queue,
        // Matched on title because that is the identity a user reads. Staging the same proposal
        // twice is a double click, not a request for two tasks.
        tasks: (s.queue.tasks ?? []).some((held) => held.title === task.title)
          ? s.queue.tasks
          : [...(s.queue.tasks ?? []), task],
      },
    })),
  unstageTask: (at) =>
    set((s) => ({ queue: { ...s.queue, tasks: (s.queue.tasks ?? []).filter((_, i) => i !== at) } })),
  clearStep: (step) => set((s) => ({ queue: { ...s.queue, [step]: null } })),

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
        // A fresh id per load, which is what makes the three stages of this sitting one history
        // entry and a re-review of the same item next sprint a second one.
        sessionId: crypto.randomUUID(),
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
      // longer on screen — and writing it here would put story A's analysis under story B, then
      // save it there.
      if (get().runByStage[stage] !== runId) return;

      const { review, ...provenance } = result;
      if (review.stage === "analyze") {
        set({ analysis: { summary: review.summary, invest: review.invest, findings: review.findings } });
      } else if (review.stage === "criteria") {
        set({ proposedCriteria: review.criteria });
      } else {
        set({ proposedTasks: review.tasks });
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

  /**
   * Writes one staged step to Azure DevOps.
   *
   * The only thing in this store that changes something other people are working from, so it is
   * deliberately narrow: one step at a time, only what is in the queue, and never a field the user
   * did not stage. A bug's prose goes to Repro Steps rather than Description — they are different
   * fields in Azure, and writing a bug's steps into Description puts them where the bug form does
   * not show them.
   */
  publish: async (step) => {
    const s = get();
    if (s.publishing || !s.item) return;
    const org = s.org.trim();
    if (!org) {
      pushErrorToast(translate("huReview.orgMissing"));
      return;
    }

    set({ publishing: step });
    try {
      let count = 0;
      if (step === "description") {
        const text = s.queue.description;
        if (text === null) return;
        const isBug = kindOf(s.item.work_item_type) === "bug";
        await adoUpdateWorkItem({
          org,
          id: s.item.id,
          title: s.title.trim() || undefined,
          ...(isBug ? { reproSteps: text } : { description: text }),
        });
        count = 1;
      } else if (step === "criteria") {
        const criteria = s.queue.criteria;
        if (criteria === null) return;
        await adoUpdateWorkItem({ org, id: s.item.id, acceptanceCriteria: criteria });
        count = criteria.length;
      } else {
        const tasks = s.queue.tasks;
        if (!tasks?.length) return;
        // The project the story lives in, because a child is created inside a project and the
        // organisation alone does not name one.
        const project = s.item.team_project.trim();
        if (!project) throw new Error(translate("huReview.noTeamProject"));
        const created = await adoCreateChildTasks({
          org,
          project,
          parentId: s.item.id,
          workItemType: "Task",
          tasks,
        });
        count = created.length;
      }

      set((state) => ({
        queue: {
          ...state.queue,
          published: { ...state.queue.published, [step]: { at: new Date().toISOString(), count } },
        },
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

  persist: async () => {
    const s = get();
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!s.item || !s.sessionId || !workspaceId) return;

    const payload: ReviewSessionPayload = {
      version: 1,
      title: s.title,
      description: s.description,
      reproSteps: s.reproSteps,
      criteria: s.criteria,
      analysis: s.analysis,
      proposedCriteria: s.proposedCriteria,
      proposedTasks: s.proposedTasks,
      dismissed: s.dismissed,
      projectIds: s.projectIds,
      useContext: s.useContext,
      provenance: s.provenance,
      queue: s.queue,
    };
    // Whichever stage ran last names the engine on the row. The three share one config, so they
    // agree; picking the newest keeps a row stamped rather than blank when only one has run.
    const stamped = Object.values(s.provenance);
    const latest: ReviewProvenance | undefined = stamped[stamped.length - 1];
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
    await get().loadHistory();
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
      input: String(row.work_item_id),
      // Enough of a work item to render the screen. The children are not part of the snapshot —
      // they live on the board and belong to whatever it says today, not to what it said then.
      item: {
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
      proposedCriteria: payload.proposedCriteria ?? [],
      proposedTasks: payload.proposedTasks ?? [],
      dismissed: payload.dismissed ?? {},
      provenance: payload.provenance ?? {},
      projectIds: payload.projectIds ?? [],
      useContext: payload.useContext ?? false,
      queue: payload.queue ?? EMPTY_QUEUE,
    });
  },

  removeFromHistory: async (id) => {
    await deleteWorkItemReview(id).catch((e: unknown) => pushErrorToast(String(e)));
    // A session deleted while it is on screen keeps its content but loses its row: the next stage
    // would otherwise silently resurrect what the user just threw away.
    if (get().sessionId === id) set({ sessionId: "", openedFrom: null });
    await get().loadHistory();
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
