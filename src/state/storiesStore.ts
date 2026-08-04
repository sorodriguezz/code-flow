import { create } from "zustand";
import {
  addStoryDraft,
  createStoryBatch,
  deleteStoryBatch,
  deleteStoryDraft,
  generateStories,
  getStoryBatch,
  listStoryBatches,
  publishStories,
  renameStoryBatch,
  saveStoryDraft,
  setStoryBatchAnswers,
  setStoryBatchInstructions,
  setStoryBatchTarget,
  setStoryBatchFeatureProject,
  setStoryBatchVerifyProjects,
  verifyStories,
  writeStoryFeatureFile,
} from "../lib/tauri/commands";
import { featureFileName, parseCriteria, toFeatureFile } from "../lib/gherkin";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { notify } from "./notificationStore";
import type {
  CriterionVerdict,
  QuestionAnswer,
  StoryBatch,
  StoryDraft,
  StorySourceKind,
} from "../types/domain";

/** How much of the source names a batch until the user renames it. */
const TITLE_MAX = 64;

export function batchTitleFrom(source: string): string {
  const oneLine = source.replace(/\s+/g, " ").trim();
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX)}…` : oneLine;
}

/** The acceptance criteria as the card edits them. Lives in `lib/gherkin` with everything else
 * that reads a criterion, and is re-exported here because this is where the rest of the app has
 * always imported it from. */
export { parseCriteria };

/** The batch's open questions, same encoding. */
export const parseOpenQuestions = parseCriteria;

/** The repositories the batch's criteria are checked against, same encoding. */
export const parseVerifyProjectIds = parseCriteria;

/** The answers given to the batch's open questions. Tolerant like the rest: a row that can't be read
 * yields none, because a corrupt answer is worth exactly as much as no answer and must not take the
 * screen down with it. */
export function parseQuestionAnswers(raw: string): QuestionAnswer[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is QuestionAnswer =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as QuestionAnswer).question === "string" &&
        typeof (entry as QuestionAnswer).answer === "string",
    );
  } catch {
    return [];
  }
}

/** The per-criterion verdicts of the last check against the code, positionally aligned with the
 * story's criteria. An unreadable row yields none rather than throwing: a corrupt verdict is worth
 * exactly as much as no verdict, and it must not take the card down with it. */
export function parseVerdicts(json: string): CriterionVerdict[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is CriterionVerdict => typeof v === "object" && v !== null && "verdict" in v);
  } catch {
    return [];
  }
}

/** Everything one story card can edit. Kept apart from `StoryDraft` because the row also carries
 * what the *host* decided (`work_item_id`, `status`), which the card never writes. */
export interface StoryEdits {
  title: string;
  narrative: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  storyPoints: number;
  tags: string;
  notes: string;
}

export function editsFrom(story: StoryDraft): StoryEdits {
  return {
    title: story.title,
    narrative: story.narrative,
    description: story.description,
    acceptanceCriteria: parseCriteria(story.acceptance_criteria),
    priority: story.priority,
    storyPoints: story.story_points,
    tags: story.tags,
    notes: story.notes,
  };
}

/** What a batch publishes into. Held together because the four fields are read and written as one
 * decision — see `set_story_batch_target` on the backend. */
export interface BoardsTarget {
  org: string;
  project: string;
  workItemType: string;
  areaPath: string;
  iterationPath: string;
  tags: string;
}

export function targetFrom(batch: StoryBatch): BoardsTarget {
  return {
    org: batch.ado_org,
    project: batch.ado_project,
    workItemType: batch.work_item_type,
    areaPath: batch.area_path,
    iterationPath: batch.iteration_path,
    tags: batch.tags,
  };
}

/** A batch has a target once it names an organization, a project and a type — the three Azure
 * refuses to create a work item without. Area and iteration are genuinely optional: left blank,
 * the project's own defaults apply, which is usually what a team wants. */
export function isPublishable(batch: StoryBatch): boolean {
  return (
    batch.ado_org.trim() !== "" && batch.ado_project.trim() !== "" && batch.work_item_type.trim() !== ""
  );
}

const NO_STORIES: StoryDraft[] = [];
const NO_SELECTION: string[] = [];

interface StoriesState {
  workspaceId: string | null;
  batches: StoryBatch[];
  /** Loaded lazily, per batch — the list only needs the rows above. */
  storiesByBatch: Record<string, StoryDraft[]>;
  /** Which stories the next publish covers, per batch. Seeded with everything unpublished. */
  selectionByBatch: Record<string, string[]>;
  /** The run id of a generation in flight, per batch — also the "is it running?" flag and what
   * the stop button cancels. */
  runByBatch: Record<string, string>;
  /** The same, for a verification against the code. Kept apart from `runByBatch` because the two
   * are genuinely independent runs with their own buttons: they touch different things (one reads
   * documentation, the other a working copy) and neither has any reason to block the other. */
  verifyRunByBatch: Record<string, string>;
  /** When each run in flight began, keyed by run id rather than by batch so a generation and a
   * verification of the same batch don't overwrite each other. Runs outlive the view that started
   * them — see `setWorkspace` — so without this the elapsed time restarted from zero every time the
   * batch was reopened, which reads as a stalled run rather than a long one. */
  runStartedAt: Record<string, number>;
  publishingBatchId: string | null;
  selectedId: string | null;
  query: string;
  /** Whether the target rail is open. View state, so it lives here rather than in `uiStore`. */
  targetOpen: boolean;
  loading: boolean;

  setWorkspace: (id: string | null) => Promise<void>;
  select: (batchId: string | null) => Promise<void>;
  setQuery: (query: string) => void;
  toggleTarget: () => void;
  create: (input: {
    projectId: string | null;
    title: string;
    sourceKind: StorySourceKind;
    sourceRef: string;
    sourceText: string;
    instructions: string;
  }) => Promise<StoryBatch>;
  rename: (batchId: string, title: string) => Promise<void>;
  remove: (batchId: string) => Promise<void>;
  setTarget: (batchId: string, target: BoardsTarget) => Promise<void>;
  setInstructions: (batchId: string, instructions: string) => Promise<void>;
  /** The whole answer sheet at once. Blank answers are dropped rather than stored empty. */
  setAnswers: (batchId: string, answers: QuestionAnswer[]) => Promise<void>;
  setVerifyProjects: (batchId: string, projectIds: string[]) => Promise<void>;
  /** `null` leaves the export falling back to the first repository of the set. */
  setFeatureProject: (batchId: string, projectId: string | null) => Promise<void>;
  /** How many stories come out is the documentation's business, not the caller's — see the
   *  "CUÁNTAS HISTORIAS" block in the prompt. There is deliberately no count to pass. */
  generate: (batchId: string, agent?: { provider: string; model: string }) => Promise<void>;
  stop: (batchId: string) => Promise<void>;
  verify: (batchId: string, storyIds?: string[]) => Promise<void>;
  stopVerify: (batchId: string) => Promise<void>;
  exportFeature: (batchId: string) => Promise<string | null>;
  addStory: (batchId: string) => Promise<void>;
  saveStory: (batchId: string, storyId: string, edits: StoryEdits) => Promise<void>;
  removeStory: (batchId: string, storyId: string) => Promise<void>;
  publish: (batchId: string) => Promise<void>;
  toggleSelected: (batchId: string, storyId: string) => void;
  selectAll: (batchId: string, selected: boolean) => void;
  storiesFor: (batchId: string | null) => StoryDraft[];
  selectionFor: (batchId: string | null) => string[];
}

/** Everything that isn't already published — the default selection, and the only thing a publish
 * can act on. */
function publishableIds(stories: StoryDraft[]): string[] {
  return stories.filter((story) => story.work_item_id === 0).map((story) => story.id);
}

/**
 * The user-stories workspace: the batches derived from documentation, the stories inside the open
 * one, and the Azure Boards target each publishes to.
 *
 * Batch rows load with the workspace; a batch's stories load when it is opened, because the list
 * only ever shows the row. A generation in flight is keyed by batch rather than global: two
 * batches can be generating at once (they touch nothing shared — no working copy, no engine lease),
 * and switching between them must not take the spinner with it.
 */
export const useStoriesStore = create<StoriesState>((set, get) => ({
  workspaceId: null,
  batches: [],
  storiesByBatch: {},
  selectionByBatch: {},
  runByBatch: {},
  verifyRunByBatch: {},
  runStartedAt: {},
  publishingBatchId: null,
  selectedId: null,
  query: "",
  targetOpen: true,
  loading: false,

  setWorkspace: async (id) => {
    if (get().workspaceId === id) return;
    // Runs still in flight are kept, everything else is dropped — batch ids are UUIDs, so nothing
    // collides across workspaces, and a generation does not stop because the user looked elsewhere.
    set((s) => ({
      workspaceId: id,
      batches: [],
      storiesByBatch: {},
      selectionByBatch: {},
      runByBatch: s.runByBatch,
      verifyRunByBatch: s.verifyRunByBatch,
      runStartedAt: s.runStartedAt,
      selectedId: null,
      query: "",
      loading: id !== null,
    }));
    if (!id) return;
    const batches = await listStoryBatches(id).catch(() => [] as StoryBatch[]);
    set((s) => (s.workspaceId === id ? { batches, loading: false } : s));
  },

  select: async (batchId) => {
    set({ selectedId: batchId });
    if (!batchId || get().storiesByBatch[batchId]) return;
    const detail = await getStoryBatch(batchId).catch(() => null);
    if (!detail) return;
    set((s) => ({
      // The row is refreshed too: it may have been generated in a session that has since been
      // reloaded, and the list's copy would be the pre-generation one.
      batches: s.batches.map((b) => (b.id === batchId ? detail.batch : b)),
      storiesByBatch: { ...s.storiesByBatch, [batchId]: detail.stories },
      selectionByBatch: { ...s.selectionByBatch, [batchId]: publishableIds(detail.stories) },
    }));
  },

  setQuery: (query) => set({ query }),
  toggleTarget: () => set((s) => ({ targetOpen: !s.targetOpen })),

  storiesFor: (batchId) => (batchId ? (get().storiesByBatch[batchId] ?? NO_STORIES) : NO_STORIES),
  selectionFor: (batchId) => (batchId ? (get().selectionByBatch[batchId] ?? NO_SELECTION) : NO_SELECTION),

  create: async ({ projectId, title, sourceKind, sourceRef, sourceText, instructions }) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) throw new Error("no workspace");
    const batch = await createStoryBatch(
      workspaceId,
      projectId,
      title.trim() || batchTitleFrom(sourceRef || sourceText),
      sourceKind,
      sourceRef,
      sourceText,
      instructions,
    );
    set((s) => ({
      batches: [batch, ...s.batches],
      selectedId: batch.id,
      storiesByBatch: { ...s.storiesByBatch, [batch.id]: [] },
      selectionByBatch: { ...s.selectionByBatch, [batch.id]: [] },
    }));
    return batch;
  },

  rename: async (batchId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => ({ batches: s.batches.map((b) => (b.id === batchId ? { ...b, title: trimmed } : b)) }));
    await renameStoryBatch(batchId, trimmed).catch((e: unknown) => pushErrorToast(String(e)));
  },

  remove: async (batchId) => {
    // Stop them first: neither run holds a working copy the deletion would strand, but leaving one
    // alive would strand a spinner with no row to draw it on and no button left to cancel it.
    const runId = get().runByBatch[batchId];
    if (runId) await useAiRunStore.getState().cancel(runId);
    const verifyRunId = get().verifyRunByBatch[batchId];
    if (verifyRunId) await useAiRunStore.getState().cancel(verifyRunId);
    set((s) => {
      const { [batchId]: _stories, ...storiesByBatch } = s.storiesByBatch;
      const { [batchId]: _selection, ...selectionByBatch } = s.selectionByBatch;
      return {
        batches: s.batches.filter((b) => b.id !== batchId),
        storiesByBatch,
        selectionByBatch,
        selectedId: s.selectedId === batchId ? null : s.selectedId,
      };
    });
    await deleteStoryBatch(batchId).catch((e: unknown) => pushErrorToast(String(e)));
  },

  setTarget: async (batchId, target) => {
    set((s) => ({
      batches: s.batches.map((b) =>
        b.id === batchId
          ? {
              ...b,
              ado_org: target.org,
              ado_project: target.project,
              work_item_type: target.workItemType,
              area_path: target.areaPath,
              iteration_path: target.iterationPath,
              tags: target.tags,
            }
          : b,
      ),
    }));
    await setStoryBatchTarget(
      batchId,
      target.org,
      target.project,
      target.workItemType,
      target.areaPath,
      target.iterationPath,
      target.tags,
    ).catch((e: unknown) => pushErrorToast(String(e)));
  },

  setInstructions: async (batchId, instructions) => {
    set((s) => ({
      batches: s.batches.map((b) => (b.id === batchId ? { ...b, instructions } : b)),
    }));
    await setStoryBatchInstructions(batchId, instructions).catch((e: unknown) => pushErrorToast(String(e)));
  },

  generate: async (batchId, agent) => {
    if (get().runByBatch[batchId]) return;
    const runId = newRunId("stories");
    // Before the invoke, or the first lines the engine prints have nowhere to land.
    useAiRunStore.getState().start(runId);
    set((s) => ({
      runByBatch: { ...s.runByBatch, [batchId]: runId },
      runStartedAt: { ...s.runStartedAt, [runId]: Date.now() },
      batches: s.batches.map((b) =>
        b.id === batchId ? { ...b, status: "generating" as const, last_error: "" } : b,
      ),
    }));

    const where = get().batches.find((b) => b.id === batchId)?.title ?? "";

    try {
      const detail = await generateStories(batchId, runId, agent);
      set((s) => ({
        batches: s.batches.map((b) => (b.id === batchId ? detail.batch : b)),
        storiesByBatch: { ...s.storiesByBatch, [batchId]: detail.stories },
        selectionByBatch: { ...s.selectionByBatch, [batchId]: publishableIds(detail.stories) },
      }));
      notify({
        source: "stories",
        titleKey: "notifications.storiesGenerated",
        params: { n: detail.stories.length },
        status: "success",
        detail: where,
      });
    } catch (e: unknown) {
      const cancelled = isCancellation(e);
      // A run the user stopped is not news — they were there, they stopped it. Only a genuine
      // failure is worth finding in the panel afterwards.
      if (!cancelled) {
        notify({
          source: "stories",
          titleKey: "notifications.storiesGenerateFailed",
          status: "error",
          detail: where,
        });
      }
      set((s) => ({
        batches: s.batches.map((b) =>
          b.id === batchId
            ? {
                ...b,
                // A stopped run leaves the batch exactly as it was — the backend already restored
                // the row, and treating it as a failure would put an error on a non-event.
                status: cancelled ? ("draft" as const) : ("error" as const),
                last_error: cancelled ? "" : String(e),
              }
            : b,
        ),
      }));
      if (!cancelled) pushErrorToast(String(e));
    } finally {
      useAiRunStore.getState().finish(runId);
      set((s) => {
        const { [batchId]: _done, ...runByBatch } = s.runByBatch;
        const { [runId]: _started, ...runStartedAt } = s.runStartedAt;
        return { runByBatch, runStartedAt };
      });
    }
  },

  stop: async (batchId) => {
    const runId = get().runByBatch[batchId];
    if (!runId) return;
    await useAiRunStore.getState().cancel(runId);
  },

  setAnswers: async (batchId, answers) => {
    const kept = answers
      .map((qa) => ({ question: qa.question.trim(), answer: qa.answer.trim() }))
      .filter((qa) => qa.question !== "" && qa.answer !== "");
    set((s) => ({
      batches: s.batches.map((b) =>
        b.id === batchId ? { ...b, question_answers: JSON.stringify(kept) } : b,
      ),
    }));
    await setStoryBatchAnswers(batchId, kept).catch((e: unknown) => pushErrorToast(String(e)));
  },

  setVerifyProjects: async (batchId, projectIds) => {
    const json = JSON.stringify(projectIds);
    set((s) => ({
      batches: s.batches.map((b) => {
        if (b.id !== batchId) return b;
        // A destination that just left the set stops being one: keeping it would write the
        // `.feature` into a repository the user can no longer see listed here.
        const feature = b.feature_project_id && projectIds.includes(b.feature_project_id)
          ? b.feature_project_id
          : null;
        return { ...b, verify_project_ids: json, feature_project_id: feature };
      }),
    }));
    await setStoryBatchVerifyProjects(batchId, projectIds).catch((e: unknown) => pushErrorToast(String(e)));
  },

  setFeatureProject: async (batchId, projectId) => {
    set((s) => ({
      batches: s.batches.map((b) => (b.id === batchId ? { ...b, feature_project_id: projectId } : b)),
    }));
    await setStoryBatchFeatureProject(batchId, projectId).catch((e: unknown) => pushErrorToast(String(e)));
  },

  /**
   * Checks the criteria against the repository's code.
   *
   * Nothing on the batch is set to a "verifying" state the way a generation sets `status`: this run
   * writes verdicts onto stories and leaves the batch itself alone, so a failure has no half-state
   * to restore. The previous verdicts stay exactly as they were until new ones land, which is what
   * makes stopping the run a non-event rather than a loss.
   */
  verify: async (batchId, storyIds = []) => {
    if (get().verifyRunByBatch[batchId]) return;
    const runId = newRunId("story-verify");
    useAiRunStore.getState().start(runId);
    set((s) => ({
      verifyRunByBatch: { ...s.verifyRunByBatch, [batchId]: runId },
      runStartedAt: { ...s.runStartedAt, [runId]: Date.now() },
    }));

    const where = get().batches.find((b) => b.id === batchId)?.title ?? "";

    try {
      const detail = await verifyStories(batchId, runId, storyIds);
      set((s) => ({
        batches: s.batches.map((b) => (b.id === batchId ? detail.batch : b)),
        storiesByBatch: { ...s.storiesByBatch, [batchId]: detail.stories },
      }));
      notify({
        source: "stories",
        titleKey: "notifications.storiesVerified",
        status: "success",
        detail: where,
      });
    } catch (e: unknown) {
      if (!isCancellation(e)) {
        pushErrorToast(String(e));
        notify({
          source: "stories",
          titleKey: "notifications.storiesVerifyFailed",
          status: "error",
          detail: where,
        });
      }
    } finally {
      useAiRunStore.getState().finish(runId);
      set((s) => {
        const { [batchId]: _done, ...verifyRunByBatch } = s.verifyRunByBatch;
        const { [runId]: _started, ...runStartedAt } = s.runStartedAt;
        return { verifyRunByBatch, runStartedAt };
      });
    }
  },

  stopVerify: async (batchId) => {
    const runId = get().verifyRunByBatch[batchId];
    if (!runId) return;
    await useAiRunStore.getState().cancel(runId);
  },

  /** Writes the set's Gherkin into `<repo>/features/`. Returns the path it landed on, or `null`
   * when it couldn't be written — the caller reports either outcome. */
  exportFeature: async (batchId) => {
    const batch = get().batches.find((b) => b.id === batchId);
    if (!batch) return null;
    const stories = get().storiesFor(batchId);
    try {
      return await writeStoryFeatureFile(batchId, featureFileName(batch), toFeatureFile(batch, stories));
    } catch (e: unknown) {
      pushErrorToast(String(e));
      return null;
    }
  },

  addStory: async (batchId) => {
    const story = await addStoryDraft(batchId).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (!story) return;
    set((s) => ({
      storiesByBatch: { ...s.storiesByBatch, [batchId]: [...(s.storiesByBatch[batchId] ?? []), story] },
      selectionByBatch: {
        ...s.selectionByBatch,
        [batchId]: [...(s.selectionByBatch[batchId] ?? []), story.id],
      },
    }));
  },

  saveStory: async (batchId, storyId, edits) => {
    const saved = await saveStoryDraft(storyId, edits).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (!saved) return;
    set((s) => ({
      storiesByBatch: {
        ...s.storiesByBatch,
        [batchId]: (s.storiesByBatch[batchId] ?? []).map((story) => (story.id === storyId ? saved : story)),
      },
    }));
  },

  removeStory: async (batchId, storyId) => {
    set((s) => ({
      storiesByBatch: {
        ...s.storiesByBatch,
        [batchId]: (s.storiesByBatch[batchId] ?? []).filter((story) => story.id !== storyId),
      },
      selectionByBatch: {
        ...s.selectionByBatch,
        [batchId]: (s.selectionByBatch[batchId] ?? []).filter((id) => id !== storyId),
      },
    }));
    await deleteStoryDraft(storyId).catch((e: unknown) => pushErrorToast(String(e)));
  },

  publish: async (batchId) => {
    if (get().publishingBatchId) return;
    const ids = get().selectionFor(batchId);
    if (ids.length === 0) return;
    set({ publishingBatchId: batchId });
    try {
      const outcome = await publishStories(batchId, ids);
      set((s) => ({
        storiesByBatch: { ...s.storiesByBatch, [batchId]: outcome.stories },
        // What is left to publish becomes the new selection: re-publishing what just succeeded is
        // the one thing this screen must never make easy.
        selectionByBatch: { ...s.selectionByBatch, [batchId]: publishableIds(outcome.stories) },
      }));
      if (outcome.failed > 0) {
        pushErrorToast(
          translate("stories.publishedPartial", {
            ok: String(outcome.published),
            failed: String(outcome.failed),
          }),
        );
      } else {
        useToastStore
          .getState()
          .pushToast(translate("stories.publishedOk", { n: String(outcome.published) }), "success");
      }
    } catch (e: unknown) {
      pushErrorToast(String(e));
    } finally {
      set({ publishingBatchId: null });
    }
  },

  toggleSelected: (batchId, storyId) =>
    set((s) => {
      const current = s.selectionByBatch[batchId] ?? [];
      const next = current.includes(storyId)
        ? current.filter((id) => id !== storyId)
        : [...current, storyId];
      return { selectionByBatch: { ...s.selectionByBatch, [batchId]: next } };
    }),

  selectAll: (batchId, selected) =>
    set((s) => ({
      selectionByBatch: {
        ...s.selectionByBatch,
        // "All" means all *publishable*: a published story can't be in a selection the publish
        // button acts on, so offering it checked would promise something that won't happen.
        [batchId]: selected ? publishableIds(s.storiesByBatch[batchId] ?? []) : [],
      },
    })),
}));
