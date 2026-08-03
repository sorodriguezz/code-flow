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
  { key: "stories", labelKey: "task.stories", hintKey: "task.storiesHint" },
  // Reads the repository to answer, so it needs an engine with tools — a text-only local model
  // would answer from the criteria alone, which is the confident-and-wrong verdict this whole
  // feature exists to avoid.
  { key: "story_verify", labelKey: "task.storyVerify", hintKey: "task.storyVerifyHint", agenticOnly: true },
];

export const AI_TASK_KEYS = AI_TASKS.map((t) => t.key);
