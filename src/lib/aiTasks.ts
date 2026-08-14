import type { TranslationKey } from "./i18n/translations";

export interface AiTaskDef {
  /** Settings-key fragment. Must match Rust's `AiTask::key()` — these strings are the contract
   * between the routing UI (`ai_provider_{key}`, `{provider}_{key}_model`) and the backend. */
  key: string;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  /** Needs a write-capable agentic engine, so local models can't be routed here. */
  agenticOnly?: boolean;
}

/** Every AI action that can be pointed at its own provider + model, in the order the settings
 * table lists them (most-used first). */
export const AI_TASKS: AiTaskDef[] = [
  { key: "chat", labelKey: "task.chat", hintKey: "task.chatHint" },
  { key: "commit", labelKey: "task.commit", hintKey: "task.commitHint" },
  { key: "analyze", labelKey: "task.analyze", hintKey: "task.analyzeHint" },
  { key: "review", labelKey: "task.review", hintKey: "task.reviewHint" },
  { key: "pr_description", labelKey: "task.prDescription", hintKey: "task.prDescriptionHint" },
  { key: "fix", labelKey: "task.fix", hintKey: "task.fixHint", agenticOnly: true },
  { key: "conflict", labelKey: "task.conflict", hintKey: "task.conflictHint" },
  { key: "inline", labelKey: "task.inline", hintKey: "task.inlineHint" },
  // Text-only for the same reason `inline` is: the schema is read by CodeFlow's own driver and put
  // on stdin, so the engine never reaches the database and any provider can answer.
  { key: "db_query", labelKey: "task.dbQuery", hintKey: "task.dbQueryHint" },
  // Text-only too: the note goes to the engine on stdin, nothing is read from disk. Its own row
  // rather than riding on `inline` because the two are different jobs — prose in a document versus
  // a rewrite of a code fragment — and which engine writes your notes is a matter of taste in a way
  // that inline edit is not.
  { key: "notes", labelKey: "task.notes", hintKey: "task.notesHint" },
  { key: "stories", labelKey: "task.stories", hintKey: "task.storiesHint" },
  // Reads the repository to answer, so it needs an engine with tools — a text-only local model
  // would answer from the criteria alone, which is the confident-and-wrong verdict this whole
  // feature exists to avoid.
  { key: "story_verify", labelKey: "task.storyVerify", hintKey: "task.storyVerifyHint", agenticOnly: true },
  // The other two tabs of that same section. They used to ride on `story_verify`, which meant one
  // model choice for three jobs of very different length — and the one that reads a whole
  // repository to write its documentation is not the one that judges four acceptance criteria.
  {
    key: "work_item_review",
    labelKey: "task.workItemReview",
    hintKey: "task.workItemReviewHint",
    agenticOnly: true,
  },
  { key: "wiki", labelKey: "task.wiki", hintKey: "task.wikiHint", agenticOnly: true },
];

export const AI_TASK_KEYS = AI_TASKS.map((t) => t.key);
