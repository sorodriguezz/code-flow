import { create } from "zustand";
import {
  boardCreateChildTasks,
  boardGetWorkItem,
  boardParseItemRef,
  boardUpdateWorkItem,
  deleteWorkItemReview,
  listWorkItemReviews,
  reviewWorkItem,
  saveWorkItemReview,
} from "../lib/tauri/commands";
import { parseClaudeError } from "../lib/claudeError";
import { loadJiraConnections } from "../lib/jiraConnections";
import { renderMarkdown } from "../lib/markdown";
import { htmlToText, splitCriteriaHtml, storyPayload } from "../lib/workItemHtml";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { notify } from "./notificationStore";
import type { TranslationKey } from "../lib/i18n/translations";
import { useWorkspaceStore } from "./workspaceStore";
import type {
  BoardProvider,
  BoardWorkItem,
  InvestVerdict,
  ProposedCriterion,
  ProposedTask,
  ReviewFinding,
  ReviewProvenance,
  WorkItemKind,
  WorkItemReviewResult,
  WorkItemReviewRow,
  WorkItemReviewStage,
} from "../types/domain";

/**
 * What each stage says when it lands in the notification centre.
 *
 * Per stage rather than one generic "review finished": these runs are minutes long and a user who
 * fired the criteria and went to read code needs the panel to tell them *which* of the four came
 * back, not merely that something did.
 */
const STAGE_NOTIFICATION: Record<WorkItemReviewStage, TranslationKey> = {
  analyze: "notifications.huAnalyzed",
  description: "notifications.huDescription",
  criteria: "notifications.huCriteria",
  tasks: "notifications.huTasks",
  tasksqa: "notifications.huTasksQa",
};

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
export function effortLabel(item: BoardWorkItem): string {
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
/**
 * One task in the draft, as it will be published.
 *
 * Everything on it is editable on the draft tab, which is the point: the run *proposes* an
 * estimate and a priority, and the person who knows the team decides whether they are right
 * before anything reaches the board. What publishes is what is on this object.
 */
export interface DraftTask {
  title: string;
  detail: string;
  /** Decides the fields that say what kind of work it is — Azure's Activity, and the team's own
   *  "task type" field where the project has one. Carried from the proposal it came from. */
  kind: "dev" | "qa";
  /** Azure's 1-4. `0` publishes without the field rather than with a guess. */
  priority: number;
  /** Hours. `0` publishes without an estimate. */
  estimateHours: number;
}

export interface ReviewDraft {
  description: string | null;
  criteria: string[] | null;
  tasks: DraftTask[] | null;
}

const EMPTY_DRAFT: ReviewDraft = { description: null, criteria: null, tasks: null };

/**
 * A saved draft's tasks, filled in.
 *
 * Sessions saved before tasks carried planning numbers have none of these fields, and a `priority`
 * that reads `undefined` publishes as `NaN` rather than as "unset". Defaulting on the way in keeps
 * every session that ever opened openable, which is the whole contract of the payload version.
 */
/**
 * The skeleton a hand-added task starts from.
 *
 * Translated rather than hard-coded in English: this text is published to Azure DevOps and read by
 * the team, so it has to arrive in the language the board is kept in — which is the app's, the same
 * language the generated tasks come back in.
 *
 * The prefix on the title is what the generated tasks use (`[QA] …`), so the two sort and scan
 * together on the board; the numbers are left at 0, which publishes as "unset" rather than as a
 * guess the user never made.
 */
function newDraftTask(kind: "dev" | "qa", flavour: "plain" | "gherkin"): DraftTask {
  const detailKey: TranslationKey =
    kind === "dev"
      ? "huReview.taskTemplateDev"
      : flavour === "gherkin"
        ? "huReview.taskTemplateQaGherkin"
        : "huReview.taskTemplateQaList";
  return {
    title: kind === "qa" ? "[QA] " : "",
    detail: translate(detailKey),
    kind,
    priority: 0,
    estimateHours: 0,
  };
}

function draftFromPayload(draft: ReviewDraft | undefined): ReviewDraft {
  if (!draft) return EMPTY_DRAFT;
  if (!draft.tasks) return draft;
  return {
    ...draft,
    tasks: draft.tasks.map((task) => ({
      ...task,
      title: task.title ?? "",
      detail: task.detail ?? "",
      kind: task.kind === "qa" ? "qa" : "dev",
      priority: Number.isFinite(task.priority) ? task.priority : 0,
      estimateHours: Number.isFinite(task.estimateHours) ? task.estimateHours : 0,
    })),
  };
}

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
  item: BoardWorkItem | null;
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

/**
 * The saved Jira site, when there is exactly one.
 *
 * `null` for none and for several — both mean the same thing here, which is that the app must not
 * pick. Loading the wrong site's `WEB-12` is not an error the user would notice: it is a different
 * team's issue with a plausible title.
 */
async function theOneJiraSite(): Promise<string | null> {
  const connections = await loadJiraConnections().catch(() => []);
  return connections.length === 1 ? connections[0].site : null;
}

/** Which text of an `ambos` proposal the user is sending. */
/**
 * What a proposal becomes once it is staged: its heading lines, then its text.
 *
 * The heading lives inside the one string because that is all a criterion ever is — the board has a
 * single field for the whole list, and anything stored beside it would be lost the first time the
 * story was read back. Markdown carries it in both directions: it publishes as a `<strong>`
 * lead-in and comes back as `**…**` (see `splitCriterion` in the review view).
 *
 * Slice and risk join the title there for the same reason, and in the spelling the teams that write
 * them by hand already use — `**Slice:** Slice 1 – Persistencia`. The model returns them as their
 * own fields so the backend can hold them to three words and one shape; the app writes the line, so
 * a run where the model phrases it its own way still publishes the same document as every other.
 */
function textOf(criterion: CriterionProposal): string {
  const body =
    criterion.format === "checklist"
      ? criterion.checklist
      : criterion.format === "gherkin"
        ? criterion.gherkin
        : criterion.pick === "checklist"
          ? criterion.checklist
          : criterion.gherkin;
  const title = (criterion.title ?? "").trim();
  const slice = (criterion.slice ?? "").trim();
  const risk = (criterion.risk ?? "").trim();
  const head = [
    title && `**${title}**`,
    slice && `**Slice:** ${slice}`,
    risk && `**Riesgo:** ${risk}`,
  ].filter(Boolean);
  return head.length > 0 ? `${head.join("\n")}\n${body.trim()}` : body;
}

interface WorkItemReviewState {
  /** What the user pasted: a link, a bare id, or a Jira key. */
  input: string;
  /** The organisation or Jira site a bare reference belongs to — filled from the last link, or from
   *  the batch target. */
  org: string;
  /** Which board the loaded item came from. Derived from what was pasted, never chosen: the two
   *  hosts address an item differently, and asking the user which one their own link is would be
   *  asking them to repeat what the link already says. */
  provider: BoardProvider;
  /** Jira's `PROJ-123`. Empty on Azure, where `item.id` is the whole address. */
  itemKey: string;
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
  item: BoardWorkItem | null;

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
  /**
   * Run ids in flight, by session and then by stage. Present means "still generating", which is
   * also what the Stop buttons act on — hence run ids rather than booleans.
   *
   * Keyed by session and *not* part of [`EMPTY`], which is the whole point: a generation outlives
   * the screen it was started from. Setting the review aside with ✕ leaves its run going, and the
   * answer is filed into the saved session when it lands (see `landOffScreen`). Keying it by stage
   * alone was a way of saying "the session on screen", so a run could only ever report back to
   * whatever happened to be showing — which is why it had to be killed on the way out.
   *
   * Same shape and same reasoning as `storiesStore.runByBatch`.
   */
  runsBySession: Record<string, Partial<Record<WorkItemReviewStage, string>>>;
  /** Cancels every stage still running for one session, on screen or not. What the history row's
   * Stop button calls. */
  stopSession: (sessionId: string) => Promise<void>;
  /** Reopens a saved session by id, from anywhere — the notification bell, which knows an id and
   * not a row. Sets aside whatever is on screen first, exactly as opening from the history does. */
  openById: (sessionId: string) => Promise<void>;
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
  /** The workspace the session belongs to — see the note on it in `EMPTY`. */
  workspaceId: string | null;
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
  /**
   * Writes the estimate to the board and reflects it on the item on screen.
   *
   * The one field this screen changes outside the draft, and deliberately so: an estimate is a
   * number somebody says out loud in refinement, not a proposal to be staged, reviewed and
   * published in three moves. It is also the only edit here that is not destructive — there is
   * nothing to lose by getting it wrong, because typing it again fixes it.
   */
  setEffort: (effort: number) => Promise<void>;
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
  /**
   * Stages one hand-written task, pre-filled with the skeleton its kind expects.
   *
   * `flavour` only means anything for QA, where a test task is written either as a numbered list of
   * cases or as Gherkin scenarios; a dev task has one shape and ignores it. The body is a template
   * rather than a blank, so a task typed by hand and one proposed by a run read the same on the
   * board — and so the user is answering questions instead of facing an empty box.
   */
  addDraftTask: (kind: "dev" | "qa", flavour: "plain" | "gherkin") => void;
  setDraftTask: (at: number, patch: Partial<DraftTask>) => void;
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
  // `runsBySession` is deliberately *not* here. It used to be, as `runByStage`, because a run could
  // only report back to the session on screen and clearing it was the only way to stop a late
  // answer landing on the wrong story. Now every run carries the id of the session it belongs to,
  // so it can be left alone: what is in flight stays in flight across setting a review aside,
  // opening another one, and switching workspace.
  draft: EMPTY_DRAFT,
  published: {} as Partial<Record<PublishPart, { at: string; count: number }>>,
  tab: "story" as ReviewTab,
  publishing: null,
  status: "open" as ReviewStatus,
  sessionId: "",
  /**
   * The workspace the session belongs to.
   *
   * Held rather than read off `workspaceStore` at write time, because the one write that matters
   * most happens *after* the switch: leaving a review open and changing workspace closes it, and
   * closing it saves it. Reading the active workspace there would file the session under the one
   * the user just moved to, where it would show up in a history it has nothing to do with.
   */
  workspaceId: null as string | null,
  openedFrom: null,
  dirty: false,
  saving: false,
  savedAt: null as string | null,
};

/** A session that has ended takes no more changes — every mutator asks this first. */
function editable(status: ReviewStatus): boolean {
  return status === "open";
}

/** A stable empty map, so the selectors below can hand back the same reference on every miss.
 * Building `{}` inline would be a new object per render, which zustand's `Object.is` comparison
 * reads as a change — and re-rendering is what calls the selector again. */
const NO_RUNS: Partial<Record<WorkItemReviewStage, string>> = {};

/** What is generating *for the session on screen*. The drop-in replacement for the old
 * `runByStage`, and the only thing the review screen's own buttons care about. */
export const stagesRunning = (s: WorkItemReviewState): Partial<Record<WorkItemReviewStage, string>> =>
  s.runsBySession[s.sessionId] ?? NO_RUNS;

/** Whether a *saved* session has anything still generating — for the history, where the whole
 * point is asking about sessions that are not on screen. */
export const isSessionRunning = (
  runs: Record<string, Partial<Record<WorkItemReviewStage, string>>>,
  sessionId: string,
): boolean => Object.keys(runs[sessionId] ?? NO_RUNS).length > 0;

/**
 * Everything a run needs to know about the session that started it, taken before the invoke.
 *
 * Read once and carried, rather than looked up when the answer arrives: by then the screen may be
 * showing another story, or nothing at all, and `get().title` would be the empty string that
 * [`EMPTY`] left behind. The workspace matters for the same reason — the session is filed under the
 * workspace it was opened in, not whichever one the user has since moved to.
 */
interface RunSession {
  id: string;
  workspaceId: string;
  title: string;
}

/**
 * Sessions deleted from the history while one of their runs was still going.
 *
 * `saveWorkItemReview` is an upsert, so a background answer landing after a delete would write the
 * row back — resurrecting a review the user threw away, with no way to tell it apart from one they
 * kept. Module scope rather than store state because it is bookkeeping about rows that no longer
 * exist, and nothing renders from it.
 */
const deletedSessions = new Set<string>();

export const useWorkItemReviewStore = create<WorkItemReviewState>((set, get) => ({
  input: "",
  org: "",
  provider: "azure",
  itemKey: "",
  projectIds: [],
  useContext: false,
  history: [],
  // Outside the spread on purpose — `EMPTY` is what every "clear the screen" path applies, and
  // this map has to survive all of them. See its declaration.
  runsBySession: {},
  ...EMPTY,

  setInput: (input) => set({ input }),

  setEffort: async (effort) => {
    const s = get();
    if (!s.item || !editable(s.status)) return;
    const value = Number.isFinite(effort) ? Math.max(0, effort) : 0;
    if (value === s.item.effort) return;
    const container = s.item.container_id || s.item.team_project;
    try {
      await boardUpdateWorkItem({
        provider: s.provider,
        org: s.org,
        project: container,
        id: s.item.id,
        key: s.itemKey,
        effort: value,
        // Where this item already keeps its estimate. Empty on one that has never been estimated,
        // and the backend then picks the first field its process offers.
        effortField: s.item.effort_field,
      });
    } catch (e: unknown) {
      pushErrorToast(String(e));
      return;
    }
    // Only after the write lands. The header reads `item.effort`, and moving it first would show
    // the new number against a board that still holds the old one.
    set((state) => (state.item ? { item: { ...state.item, effort: value } } : state));
    useToastStore.getState().pushToast(translate("huReview.effortSaved"), "success");
    void saveSoon();
  },
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
  addDraftTask: (kind, flavour) => {
    if (!editable(get().status)) return;
    set((s) => ({
      draft: { ...s.draft, tasks: [...(s.draft.tasks ?? []), newDraftTask(kind, flavour)] },
    }));
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
      const ref = await boardParseItemRef(input);
      // A bare reference carries no host, so it falls back to what is already on screen. Failing
      // here rather than guessing: fetching the wrong org's item 4821 would look like it worked.
      //
      // The org box lists Azure organisations, so for a bare Jira key it holds the wrong kind of
      // name entirely — `WEB-12` with "contoso" selected would be sent to contoso.atlassian.net.
      // A single saved Jira site is unambiguous and used; anything else is asked for outright.
      // A monday reference is only ever recognised from a link, and that link always carries the
      // account in its subdomain — so monday never reaches the fallback at all, which is just as
      // well: the org box holds Azure organisations and there would be nothing sensible to put
      // there. Its message stays for the case the parser is ever loosened.
      const resolved = ref.org ?? (ref.provider === "jira" ? await theOneJiraSite() : org.trim());
      if (!resolved) {
        throw new Error(
          translate(
            ref.provider === "jira"
              ? "huReview.jiraSiteMissing"
              : ref.provider === "monday"
                ? "huReview.mondayLinkNeeded"
                : "huReview.orgMissing",
          ),
        );
      }
      const item = await boardGetWorkItem(ref.provider, resolved, ref.id, ref.key);
      set({
        // Everything derived from the previous item goes with it — a review of story A must not
        // still be on screen under story B.
        ...EMPTY,
        // A fresh id per load, which is what makes this sitting one history entry and a re-review
        // of the same item next sprint a second one.
        sessionId: crypto.randomUUID(),
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
        // The lookup is done: leaving the reference in the box makes Load look armed when what it
        // would do is fetch the item already on screen.
        input: "",
        org: resolved,
        provider: ref.provider,
        // Jira answers with the key the issue actually has, which is the one every later write has
        // to address; `ref.key` is only what the user happened to type.
        itemKey: item.key || ref.key,
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
    const request = captureRun(get(), stage);
    if (request) await runFor(request.session, stage, request.input);
  },

  runTasks: async (scope) => {
    // Captured once, up front, rather than per run. `both` is two sequential runs, and the second
    // used to read the store again — so setting the review aside during the DEV half meant the QA
    // half silently never started, because by then there was no item on screen to read.
    const request = captureRun(get(), "tasks");
    if (!request) return;
    // Sequential rather than concurrent: the two runs lease the same repositories, and the second
    // would be refused by the lock the first is holding.
    if (scope === "dev" || scope === "both") await runFor(request.session, "tasks", request.input);
    if (scope === "qa" || scope === "both") await runFor(request.session, "tasksqa", request.input);
  },

  stop: async (stage) => {
    const runId = stagesRunning(get())[stage];
    if (runId) await useAiRunStore.getState().cancel(runId);
  },

  stopSession: async (sessionId) => {
    const stages = get().runsBySession[sessionId];
    if (!stages) return;
    for (const runId of Object.values(stages)) {
      if (runId) await useAiRunStore.getState().cancel(runId).catch((e: unknown) => pushErrorToast(String(e)));
    }
  },

  openById: async (sessionId) => {
    await get().dismiss();
    await get().loadHistory();
    const row = get().history.find((r) => r.id === sessionId);
    if (!row) {
      // Deleted since the notification was posted, or filed under another workspace this one
      // can't see. Saying so beats landing the user on an empty review screen.
      pushErrorToast(translate("huReview.sessionGone"));
      return;
    }
    get().openFromHistory(row);
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
      // Published is an ending, so anything still generating stops here — same reasoning as
      // `close`. Without this the run would finish, find the session no longer `open`, and drop its
      // answer anyway: the tokens would be spent for nothing rather than merely wasted.
      if (get().status === "published") await stopEverything();
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
   *
   * A stage still generating is deliberately left alone — it is the one thing here that does *not*
   * belong to the screen. It keeps running, the history row says so, and when it lands the answer
   * is merged into this session's saved row and announced in the notification centre. Setting a
   * review aside is not a reason to throw away twenty minutes of work the user already paid for.
   */
  dismiss: async () => {
    const leaving = get().sessionId;
    if (!get().item) return;
    cancelSave();
    await get()
      .persist()
      .catch((e: unknown) => pushErrorToast(String(e)));
    // Something else claimed the screen while the save was in flight — the workspace subscription
    // fires this without awaiting, and `openById` can land in between. Clearing now would wipe a
    // session that has nothing to do with the one this call was about.
    if (get().sessionId !== leaving) return;
    set({ ...EMPTY });
    useToastStore.getState().pushToast(translate("huReview.setAsideDone"), "success");
  },

  persist: async () => {
    const s = get();
    const workspaceId = s.workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId;
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
        key: "",
        container_id: "",
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
      draft: draftFromPayload(payload.draft),
      published: payload.published ?? {},
      // The row came out of this workspace's history, so this is the workspace it goes back to.
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
    });
  },

  removeFromHistory: async (id) => {
    // Both are about the same hazard: a background run whose answer is written with an upsert, and
    // would therefore put the deleted row back. Stopping it is the fix; the tombstone covers the
    // one already on its way home.
    await get().stopSession(id);
    deletedSessions.add(id);
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
    // Absent on a run from a build before criteria were titled, and on a model that skipped it.
    title: (criterion.title ?? "").trim(),
    slice: (criterion.slice ?? "").trim(),
    risk: (criterion.risk ?? "").trim(),
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
    // A run from a build before tasks were estimated, or a model that skipped the field, leaves
    // these absent — `0` is the "unset" both of them already mean everywhere downstream.
    estimate_hours: Number.isFinite(task.estimate_hours) ? task.estimate_hours : 0,
    priority: Number.isFinite(task.priority) ? task.priority : 0,
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
function appendTask(tasks: DraftTask[], proposal: TaskProposal): DraftTask[] {
  if (tasks.some((held) => held.title === proposal.title)) return tasks;
  return [
    ...tasks,
    {
      title: proposal.title,
      detail: proposal.detail,
      kind: proposal.kind,
      priority: proposal.priority,
      estimateHours: proposal.estimate_hours,
    },
  ];
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
  const provider = s.provider;
  // Jira addresses an issue by key, Azure by id, monday by board *and* item. All three identifiers
  // travel on every write so the backend can use whichever its client needs, rather than each call
  // site deciding. `container_id` falls back to the display name, which is what Azure addresses by.
  const key = s.itemKey || item.key;
  const container = item.container_id || item.team_project.trim();

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
    await boardUpdateWorkItem({
      provider,
      org,
      project: container,
      id: item.id,
      key,
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
    await boardUpdateWorkItem({
      provider,
      org,
      project: container,
      id: item.id,
      key,
      acceptanceCriteria: criteria,
    });
    return criteria.length;
  }

  const tasks = s.draft.tasks;
  if (!tasks?.length) return null;
  // The container the story lives in, because a child is created inside one and the host alone does
  // not name it.
  const project = container;
  if (!project) throw new Error(translate("huReview.noTeamProject"));
  const created = await boardCreateChildTasks({
    provider,
    org,
    project,
    parentId: item.id,
    parentKey: key,
    // Azure's hierarchy is a link, so any type can be a child and "Task" is the one that means it.
    // Jira's is a property of the type, and its client resolves the real sub-task type against the
    // project. monday's sub-items have no type at all, so anything sent here is ignored.
    workItemType: provider === "jira" ? "Sub-task" : "Task",
    tasks,
  });
  return created.length;
}

/**
 * The active workspace, read at call time rather than held in this store.
 *
 * The run uses that workspace's prompts and skills, so reading it as the run starts is
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
 * Stops whatever the session on screen still has generating.
 *
 * For the ways a session *ends* — closed, or published. Not for ✕: setting a review aside says
 * "not now", not "never", and an answer that arrives afterwards still has somewhere to go. Ending
 * it is different, because an engine spending tokens on a review that is already on the board, or
 * that the user declared finished, is spending them on nothing.
 */
async function stopEverything(): Promise<void> {
  const store = useWorkItemReviewStore.getState();
  await store.stopSession(store.sessionId);
}

/**
 * Everything a run needs, read off the screen in one go before anything is dispatched.
 *
 * The capture is the whole trick: past this point the run holds a copy and never reads the store
 * for its own inputs again, so the user is free to set the review aside, open another one, or
 * change workspace while it works. `null` when there is nothing to run — no item, a session that
 * has ended, no workspace, or this stage already going for this session.
 */
function captureRun(
  state: WorkItemReviewState,
  stage: WorkItemReviewStage,
): { session: RunSession; input: string } | null {
  if (!state.item || !editable(state.status)) return null;
  if (stagesRunning(state)[stage]) return null;
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return null;
  // A session that has never been saved has no id to file an answer under. `load` mints one before
  // the screen is usable, so this is a guard rather than a case.
  if (!state.sessionId) return null;
  return {
    session: { id: state.sessionId, workspaceId, title: state.title },
    input: storyPayload({
      title: state.title,
      workItemType: state.item.work_item_type,
      effort: effortLabel(state.item),
      description: state.description,
      reproSteps: state.reproSteps,
      systemInfo: htmlToText(state.item.system_info_html),
      criteria: state.criteria,
      tasks: state.item.children.map((child) => ({ title: child.title, state: child.state })),
    }),
  };
}

/** The proposals a finished stage contributes, in the shape the session payload stores them. */
interface StageOutcome {
  produced: number;
  proposedDescription?: DescriptionProposal | null;
  addedCriteria?: CriterionProposal[];
  addedTasks?: TaskProposal[];
}

/**
 * What a stage's answer amounts to, independent of where it is about to be written.
 *
 * Split out so the on-screen path and the saved-session path apply *the same* rules — description
 * replaces, criteria and tasks append — rather than two copies that drift.
 */
function outcomeOf(review: WorkItemReviewResult["review"]): StageOutcome {
  if (review.stage === "description") {
    const produced = review.description.trim() ? 1 : 0;
    return {
      produced,
      proposedDescription: produced
        ? { description: review.description, rationale: review.rationale, evidence: review.evidence }
        : null,
    };
  }
  if (review.stage === "criteria") {
    return { produced: review.criteria.length, addedCriteria: review.criteria.map(asCriterionProposal) };
  }
  if (review.stage === "tasks") {
    return { produced: review.tasks.length, addedTasks: review.tasks.map(asTaskProposal) };
  }
  return { produced: 0 };
}

/**
 * One stage, start to finish, on behalf of `session` rather than on behalf of the screen.
 *
 * The two paths at the end are the point of the whole change. If the session is still the one being
 * looked at, the answer goes into state exactly as it always did. If it is not — the user pressed
 * ✕, or opened another story, or changed workspace — it goes into that session's saved row instead,
 * and the notification is what tells them it arrived.
 */
async function runFor(session: RunSession, stage: WorkItemReviewStage, storyText: string): Promise<void> {
  const store = () => useWorkItemReviewStore.getState();
  const runId = newRunId("hu-review");
  // Before the invoke, or the first lines the engine prints have nowhere to land.
  useAiRunStore.getState().start(runId, {
    kindKey: "agents.liveKindReview",
    detail: session.title,
    workspaceId: session.workspaceId,
    target: { view: "stories", storiesMode: "review", select: { kind: "reviewSession", id: session.id } },
  });
  useWorkItemReviewStore.setState((s) => ({
    runsBySession: {
      ...s.runsBySession,
      [session.id]: { ...(s.runsBySession[session.id] ?? {}), [stage]: runId },
    },
  }));

  try {
    const state = store();
    const result = await reviewWorkItem({
      workspaceId: session.workspaceId,
      // Read now rather than captured: the repositories a review reads are a setting of the screen,
      // and the ones in force when it was dispatched are the ones it should use. They only differ
      // if the user changed them mid-run, which is not a case worth a second snapshot.
      projectIds: state.sessionId === session.id ? state.projectIds : [],
      stage,
      kind: kindOf(state.item?.work_item_type ?? ""),
      storyText,
      useContext: state.sessionId === session.id ? state.useContext : false,
      runId,
    });

    // Not "is this session on screen?" but "is this run still the one this session is waiting on?".
    // A stopped or superseded run is one whose id has been taken off the map, and its answer is
    // discarded — the difference from before being that leaving the screen no longer does that.
    if (store().runsBySession[session.id]?.[stage] !== runId) return;

    const { review, ...provenance } = result;
    const outcome = outcomeOf(review);
    const onScreen = store().sessionId === session.id;

    if (onScreen) {
      useWorkItemReviewStore.setState((s) => ({
        proposedDescription:
          outcome.proposedDescription !== undefined ? outcome.proposedDescription : s.proposedDescription,
        // Appended, not replaced: a second run against a story the user has since edited is a
        // second opinion, and throwing away the first would take the cards they were still
        // reading with it. The Clear button is right there for the user who wants a blank panel.
        proposedCriteria: outcome.addedCriteria
          ? [...s.proposedCriteria, ...outcome.addedCriteria]
          : s.proposedCriteria,
        proposedTasks: outcome.addedTasks ? [...s.proposedTasks, ...outcome.addedTasks] : s.proposedTasks,
        // Keyed by the stage that was *asked for*, not the one that came back: the QA task run
        // reports itself as `tasks`, and collapsing the two would make one count overwrite the other.
        producedByStage: { ...s.producedByStage, [stage]: outcome.produced },
        provenance: { ...s.provenance, [stage]: provenance },
      }));
      // Saved once the stage has landed in state, so what is written is what is on screen. A
      // failure to save is reported and no more: the review itself is still in front of the user,
      // and losing the copy is not a reason to also throw away the answer.
      void store()
        .persist()
        .catch((e: unknown) => pushErrorToast(String(e)));
    } else {
      await landOffScreen(session, stage, outcome, provenance);
    }

    notify({
      source: "review",
      titleKey: STAGE_NOTIFICATION[stage],
      target: { view: "stories", storiesMode: "review", select: { kind: "reviewSession", id: session.id } },
      params: { n: outcome.produced },
      status: "success",
      // The captured title, not `get().title` — after ✕ that is the empty string `EMPTY` left, and
      // a notification that doesn't name the story is no use to someone who set three aside.
      detail: session.title,
      workspaceId: session.workspaceId,
    });
  } catch (e: unknown) {
    // A stopped run is not a failure: nothing was written, and the previous answer is still on
    // screen exactly as it was.
    //
    // Parsed rather than raw: a provider refusal arrives tagged with the quota marker, and
    // `String(e)` would put that machine prefix in front of the sentence the user reads.
    if (!isCancellation(e)) {
      // The toast only where there is a screen to put it on. The notification always — for a run
      // the user walked away from, that is the only way they learn it failed.
      if (store().sessionId === session.id) pushErrorToast(parseClaudeError(String(e)).message);
      notify({
        source: "review",
        titleKey: "notifications.huFailed",
        target: { view: "stories", storiesMode: "review", select: { kind: "reviewSession", id: session.id } },
        status: "error",
        detail: session.title,
        workspaceId: session.workspaceId,
      });
    }
  } finally {
    useAiRunStore.getState().finish(runId);
    useWorkItemReviewStore.setState((s) => {
      const stages = without(s.runsBySession[session.id] ?? {}, stage);
      const { [session.id]: _done, ...others } = s.runsBySession;
      // The session's key goes when its last stage does — that emptiness is exactly what turns the
      // history row's "working" chip back into its status.
      return {
        runsBySession: Object.keys(stages).length > 0 ? { ...others, [session.id]: stages } : others,
      };
    });
  }
}

/**
 * Files a finished stage into a session that isn't on screen.
 *
 * Deliberately not `persist()`: that one writes whatever the store currently holds, which is some
 * other review, and it drives the save indicator (`saving`, `dirty`, `savedAt`) belonging to the
 * session the user is actually editing. This reads the row back, merges into it, and writes it by
 * id — so the two sessions never touch.
 */
async function landOffScreen(
  session: RunSession,
  stage: WorkItemReviewStage,
  outcome: StageOutcome,
  provenance: ReviewProvenance,
): Promise<void> {
  // Thrown away while it was running. Writing would resurrect the row, since the save is an upsert.
  if (deletedSessions.has(session.id)) return;

  const rows = await listWorkItemReviews(session.workspaceId).catch((e: unknown) => {
    pushErrorToast(String(e));
    return [] as WorkItemReviewRow[];
  });
  const row = rows.find((r) => r.id === session.id);
  // No row means nothing to come back to — deleted, or never saved. Silence is right: there is no
  // screen showing this session and nothing the user could do about it.
  if (!row) return;

  let payload: Partial<ReviewSessionPayload> = {};
  try {
    payload = JSON.parse(row.payload) as ReviewSessionPayload;
  } catch {
    // Unreadable payload: merging into it would replace a record we can't read with one we made up.
    return;
  }
  // Ended while the run was in flight. Proposals in a published or closed review are unreachable —
  // `editable` locks the screen — so they would be invisible clutter on a finished record.
  if ((payload.status ?? "open") !== "open") return;

  // Reopened during the read above. The live path owns it now, and writing the row underneath would
  // put the answer somewhere the user can't see it while the screen shows the version without it.
  if (useWorkItemReviewStore.getState().sessionId === session.id) {
    useWorkItemReviewStore.setState((s) => ({
      proposedDescription:
        outcome.proposedDescription !== undefined ? outcome.proposedDescription : s.proposedDescription,
      proposedCriteria: outcome.addedCriteria ? [...s.proposedCriteria, ...outcome.addedCriteria] : s.proposedCriteria,
      proposedTasks: outcome.addedTasks ? [...s.proposedTasks, ...outcome.addedTasks] : s.proposedTasks,
      producedByStage: { ...s.producedByStage, [stage]: outcome.produced },
      provenance: { ...s.provenance, [stage]: provenance },
    }));
    void useWorkItemReviewStore
      .getState()
      .persist()
      .catch((e: unknown) => pushErrorToast(String(e)));
    return;
  }

  const merged: ReviewSessionPayload = {
    ...(payload as ReviewSessionPayload),
    version: 2,
    status: "open",
    proposedDescription:
      outcome.proposedDescription !== undefined
        ? outcome.proposedDescription
        : (payload.proposedDescription ?? null),
    proposedCriteria: [...(payload.proposedCriteria ?? []), ...(outcome.addedCriteria ?? [])],
    proposedTasks: [...(payload.proposedTasks ?? []), ...(outcome.addedTasks ?? [])],
    producedByStage: { ...(payload.producedByStage ?? {}), [stage]: outcome.produced },
    provenance: { ...(payload.provenance ?? {}), [stage]: provenance },
  };

  await saveWorkItemReview({
    id: row.id,
    workspaceId: session.workspaceId,
    org: row.ado_org,
    workItemId: row.work_item_id,
    workItemType: row.work_item_type,
    workItemUrl: row.work_item_url,
    title: row.title,
    payload: JSON.stringify(merged),
    engine: provenance.engine,
    model: provenance.model,
    version: provenance.version,
  }).catch((e: unknown) => pushErrorToast(String(e)));

  // The history list is the one thing on screen that shows this session, so it has to be re-read —
  // but only when it is this workspace's history that is being listed.
  if (useWorkspaceStore.getState().activeWorkspaceId === session.workspaceId) {
    await useWorkItemReviewStore.getState().loadHistory();
  }
}

/**
 * A review belongs to the workspace it was opened in, so switching workspace puts it down.
 *
 * At module scope, and not in the view's effect, for two reasons. The review screen is one sub-tab
 * of three and unmounts the moment the user looks at the wiki, so an effect would simply not run
 * for the case this exists for. And a session holds unsaved work — a draft description, staged
 * criteria, tasks with their estimates — which `dismiss` persists before clearing; leaving that to
 * a remount would mean the switch happened with the write still owed.
 *
 * `dismiss` is exactly what the screen's own ✕ does: writes the session and clears the screen.
 * Nothing is lost — the session is in the history of the workspace it belongs to, and that is where
 * it is picked back up.
 *
 * A generation in flight survives this, as it survives the ✕, and for a stronger reason: changing
 * workspace is an even weaker signal of "I'm done with that review" than setting it aside was. It
 * finishes against the workspace it was started in, files itself into that workspace's copy of the
 * session, and its notification is stamped with that workspace so the bell can cross back to it.
 */
useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId === previous.activeWorkspaceId) return;
  const store = useWorkItemReviewStore.getState();
  void store
    .dismiss()
    // The list on the screen is the old workspace's until this lands, which is the one thing a
    // dismissed session leaves visibly wrong.
    .then(() => useWorkItemReviewStore.getState().loadHistory())
    .catch((e: unknown) => pushErrorToast(String(e)));
});

/** What a criterion proposal sends to the draft, given the format the user settled on. */
export function criterionText(criterion: CriterionProposal): string {
  return textOf(criterion);
}

/** Whether a proposal rewrites one of the story's own criteria, which the screen colours. */
export function isRewrite(criterion: CriterionProposal, criteriaCount: number): boolean {
  return criterion.replaces > 0 && criterion.replaces <= criteriaCount;
}
