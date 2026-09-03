import type { TranslationKey } from "./i18n/translations";

export interface AiTaskDef {
  /** Settings-key fragment. Must match Rust's `AiTask::key()` — these strings are the contract
   * between the routing UI (`ai_provider_{key}`, `{provider}_{key}_model`) and the backend. */
  key: string;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  /** Needs a write-capable agentic engine, so local models can't be routed here. */
  agenticOnly?: boolean;
  /**
   * Which heading the settings table files this task under.
   *
   * Sixteen rows in one flat list is a list you read top to bottom every time, because nothing in
   * it tells you where to start looking. Grouped by the part of the app the task belongs to, the
   * one you came for is in the group you already had in mind.
   */
  area: AiTaskArea;
}

/** The groups the AI tasks table is divided into, in the order it shows them. */
export type AiTaskArea = "git" | "review" | "stories" | "docs" | "code" | "data" | "other";

export const AI_TASK_AREAS: { id: AiTaskArea; labelKey: TranslationKey }[] = [
  { id: "git", labelKey: "task.areaGit" },
  { id: "review", labelKey: "task.areaReview" },
  { id: "stories", labelKey: "task.areaStories" },
  { id: "docs", labelKey: "task.areaDocs" },
  { id: "code", labelKey: "task.areaCode" },
  { id: "data", labelKey: "task.areaData" },
  { id: "other", labelKey: "task.areaOther" },
];

/** Every AI action that can be pointed at its own provider + model, in the order the settings
 * table lists them (most-used first). */
export const AI_TASKS: AiTaskDef[] = [
  { key: "chat", labelKey: "task.chat", hintKey: "task.chatHint", area: "other" },
  { key: "commit", labelKey: "task.commit", hintKey: "task.commitHint", area: "git" },
  { key: "analyze", labelKey: "task.analyze", hintKey: "task.analyzeHint", area: "git" },
  { key: "review", labelKey: "task.review", hintKey: "task.reviewHint", area: "review" },
  { key: "pr_description", labelKey: "task.prDescription", hintKey: "task.prDescriptionHint", area: "git" },
  { key: "fix", labelKey: "task.fix", hintKey: "task.fixHint", agenticOnly: true, area: "code" },
  { key: "conflict", labelKey: "task.conflict", hintKey: "task.conflictHint", area: "git" },
  { key: "inline", labelKey: "task.inline", hintKey: "task.inlineHint", area: "code" },
  // Text-only for the same reason `inline` is: the schema is read by CodeFlow's own driver and put
  // on stdin, so the engine never reaches the database and any provider can answer.
  { key: "db_query", labelKey: "task.dbQuery", hintKey: "task.dbQueryHint", area: "data" },
  // Text-only too: the note goes to the engine on stdin, nothing is read from disk. Its own row
  // rather than riding on `inline` because the two are different jobs — prose in a document versus
  // a rewrite of a code fragment — and which engine writes your notes is a matter of taste in a way
  // that inline edit is not.
  { key: "notes", labelKey: "task.notes", hintKey: "task.notesHint", area: "docs" },
  // Text-only, like `notes` above it: the engine is asked to *describe* a diagram as nodes and
  // edges and never places anything, so nothing is read from disk and any provider can answer.
  // Its own row rather than sharing the notes one, because the two produce different things and a
  // team routinely wants the cheaper engine for one of them.
  { key: "diagram", labelKey: "task.diagram", hintKey: "task.diagramHint", area: "data" },
  { key: "stories", labelKey: "task.stories", hintKey: "task.storiesHint", area: "stories" },
  // Reads the repository to answer, so it needs an engine with tools — a text-only local model
  // would answer from the criteria alone, which is the confident-and-wrong verdict this whole
  // feature exists to avoid.
  { key: "story_verify", labelKey: "task.storyVerify", hintKey: "task.storyVerifyHint", agenticOnly: true, area: "stories" },
  // The other two tabs of that same section. They used to ride on `story_verify`, which meant one
  // model choice for three jobs of very different length — and the one that reads a whole
  // repository to write its documentation is not the one that judges four acceptance criteria.
  {
    key: "work_item_review",
    labelKey: "task.workItemReview",
    hintKey: "task.workItemReviewHint",
    agenticOnly: true,
    area: "review",
  },
  { key: "wiki", labelKey: "task.wiki", hintKey: "task.wikiHint", agenticOnly: true, area: "docs" },
  // Reads the repository — that is the entire value of asking it here rather than pasting the
  // log into a chat window — so it needs an engine with tools. Its own row rather than sharing
  // `analyze`'s: that one is handed a diff and answers about the diff, this one is handed a log
  // and has to go looking, which is a different length of run and routinely a different engine.
  { key: "pipeline", labelKey: "task.pipeline", hintKey: "task.pipelineHint", agenticOnly: true, area: "other" },
];

export const AI_TASK_KEYS = AI_TASKS.map((t) => t.key);
