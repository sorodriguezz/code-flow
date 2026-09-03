/**
 * Every prompt the app can send to a model, filed under the task that sends it.
 *
 * Before this file, routing and prompts were two settings panes that never referred to each other:
 * one said *which engine* runs "PR review", the other said *what it is told*, and the only way to
 * see both was to remember one while looking at the other. The prompts pane had to recompute the
 * routing itself just to print "Claude Code · Opus 5" under each row — which is the tell that they
 * were one screen split in half.
 *
 * So the unit here is the **task**, and a prompt is something a task has. A task with no editable
 * prompt (chat, inline edit, autocomplete) is still a row, because it still has an engine.
 *
 * Two storage scopes, deliberately kept apart and labelled as such in the UI:
 *
 * - `global` — a `settings` key. Applies to the whole installation.
 * - `workspace` — a row in `workspace_prompts`. Applies to the open workspace only, so a team can
 *   rewrite its review standard without changing anybody else's.
 *
 * The list of workspace kinds mirrors `WORKSPACE_PROMPT_KINDS` in `db/queries.rs`. A kind that
 * exists there and not here is a prompt nobody can edit — which is exactly how `pipeline_template`
 * spent several releases being read by the CI failure analyser with no screen anywhere to set it.
 */

import {
  Bug,
  Calculator,
  ClipboardCheck,
  ClipboardList,
  FileCode2,
  FileText,
  FlaskConical,
  Gauge,
  GitCommit,
  GitMerge,
  Glasses,
  ListChecks,
  Network,
  Route,
  ScanSearch,
  ShieldCheck,
  Split,
  SquarePen,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "./i18n/translations";
import {
  defaultAnalyzeTemplate,
  defaultCommitTemplate,
  defaultPipelineTemplate,
  defaultResolveConflictTemplate,
  defaultWorkspacePrompt,
  getSetting,
  getWorkspacePrompt,
  setSetting,
  setWorkspacePrompt,
} from "./tauri/commands";

export interface PromptDef {
  /** Stable id, unique across both scopes — used as the React key and the expand target. */
  id: string;
  /** The task whose engine runs it. */
  task: string;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  icon: LucideIcon;
  scope: "global" | "workspace";
  /** `global`: the settings key. `workspace`: the `kind` column. */
  key: string;
  /** Pre-rename settings key, read as a fallback so an old customization survives. Global only. */
  legacyKey?: string;
  /**
   * The output of this prompt is parsed by the app, so its format is a contract.
   *
   * Editing one of these freely is how the quality grades stop appearing with nothing to say why:
   * `parseAnalysis` wants a leading `📈 CALIDAD: Fiabilidad=A Seguridad=B Mantenibilidad=C` line
   * and silently reports "no grades" when it doesn't find one. The editor shows a warning on these
   * rows and checks the marker is still present before saving.
   */
  contract?: PromptContract;
}

export interface PromptContract {
  /** What the saved text must still contain, as a regular expression. */
  test: RegExp;
  /** Explains what breaks, shown when the text stops matching. */
  warningKey: TranslationKey;
}

/**
 * The grades line every review-style answer has to open with.
 *
 * Deliberately looser than `parseAnalysis`'s own `GRADES_RE`: this one only asks that the marker is
 * still mentioned somewhere in the instructions, because a prompt is *asking* for that format, not
 * producing it — a user may reasonably reword everything around it. Requiring the exact regex here
 * would refuse valid rewrites; requiring nothing would let the marker be deleted by accident.
 */
const GRADES_CONTRACT: PromptContract = {
  test: /CALIDAD/i,
  warningKey: "prompts.contractGrades",
};

export const AI_PROMPTS: PromptDef[] = [
  // ---------- global: one text for the whole installation ----------
  {
    id: "commit_template",
    task: "commit",
    labelKey: "prompts.commit",
    hintKey: "settings.commitTemplateHint",
    icon: GitCommit,
    scope: "global",
    key: "commit_template",
    legacyKey: "claude_commit_template",
  },
  {
    id: "analyze_template",
    task: "analyze",
    labelKey: "prompts.analyze",
    hintKey: "settings.analyzeTemplateHint",
    icon: ScanSearch,
    scope: "global",
    key: "analyze_template",
    legacyKey: "claude_analyze_template",
    contract: GRADES_CONTRACT,
  },
  {
    id: "resolve_conflict_template",
    task: "conflict",
    labelKey: "prompts.conflict",
    hintKey: "settings.conflictTemplateHint",
    icon: GitMerge,
    scope: "global",
    key: "resolve_conflict_template",
    legacyKey: "claude_resolve_conflict_template",
  },
  // Read by the CI failure analyser since it shipped, and until now editable from nowhere at all.
  {
    id: "pipeline_template",
    task: "pipeline",
    labelKey: "prompts.pipeline",
    hintKey: "prompts.pipelineHint",
    icon: Route,
    scope: "global",
    key: "pipeline_template",
  },

  // ---------- workspace: the review pipeline ----------
  {
    id: "review_standard",
    task: "review",
    labelKey: "prompts.reviewStandard",
    hintKey: "settings.reviewStandardHint",
    icon: ShieldCheck,
    scope: "workspace",
    key: "review_standard",
    contract: GRADES_CONTRACT,
  },
  {
    id: "review_lenses",
    task: "review",
    labelKey: "prompts.reviewLenses",
    hintKey: "settings.prPromptLensesHint",
    icon: Glasses,
    scope: "workspace",
    key: "review_lenses",
  },
  {
    id: "review_level_basico",
    task: "review",
    labelKey: "prompts.reviewLevelBasic",
    hintKey: "settings.prPromptLevelHint",
    icon: Gauge,
    scope: "workspace",
    key: "review_level_basico",
  },
  {
    id: "review_level_completo",
    task: "review",
    labelKey: "prompts.reviewLevelFull",
    hintKey: "settings.prPromptLevelHint",
    icon: Gauge,
    scope: "workspace",
    key: "review_level_completo",
  },
  {
    id: "review_level_ultra",
    task: "review",
    labelKey: "prompts.reviewLevelUltra",
    hintKey: "settings.prPromptLevelHint",
    icon: Gauge,
    scope: "workspace",
    key: "review_level_ultra",
  },
  {
    id: "review_worker",
    task: "review",
    labelKey: "prompts.reviewWorker",
    hintKey: "settings.prPromptWorkerHint",
    icon: Users,
    scope: "workspace",
    key: "review_worker",
  },
  {
    id: "review_crossfile",
    task: "review",
    labelKey: "prompts.reviewCrossfile",
    hintKey: "settings.prPromptCrossfileHint",
    icon: Network,
    scope: "workspace",
    key: "review_crossfile",
  },
  {
    id: "review_summary",
    task: "review",
    labelKey: "prompts.reviewSummary",
    hintKey: "settings.prPromptSummaryHint",
    icon: ClipboardCheck,
    scope: "workspace",
    key: "review_summary",
    contract: GRADES_CONTRACT,
  },
  {
    id: "pr_description",
    task: "pr_description",
    labelKey: "prompts.prDescription",
    hintKey: "settings.prDescHint",
    icon: SquarePen,
    scope: "workspace",
    key: "pr_description",
  },

  // ---------- workspace: stories ----------
  {
    id: "user_stories",
    task: "stories",
    labelKey: "prompts.userStories",
    hintKey: "settings.sPromptStoriesHint",
    icon: ClipboardList,
    scope: "workspace",
    key: "user_stories",
  },
  {
    id: "story_verify",
    task: "story_verify",
    labelKey: "prompts.storyVerify",
    hintKey: "settings.sPromptVerifyHint",
    icon: FlaskConical,
    scope: "workspace",
    key: "story_verify",
  },

  // ---------- workspace: work items ----------
  {
    id: "work_item_analyze",
    task: "work_item_review",
    labelKey: "prompts.workItemAnalyze",
    hintKey: "settings.wiPromptAnalyzeHint",
    icon: Glasses,
    scope: "workspace",
    key: "work_item_analyze",
  },
  {
    id: "work_item_bug_analyze",
    task: "work_item_review",
    labelKey: "prompts.workItemBug",
    hintKey: "settings.wiPromptBugAnalyzeHint",
    icon: Bug,
    scope: "workspace",
    key: "work_item_bug_analyze",
  },
  {
    id: "work_item_description",
    task: "work_item_review",
    labelKey: "prompts.workItemDescription",
    hintKey: "settings.wiPromptDescriptionHint",
    icon: FileText,
    scope: "workspace",
    key: "work_item_description",
  },
  {
    id: "work_item_criteria",
    task: "work_item_review",
    labelKey: "prompts.workItemCriteria",
    hintKey: "settings.wiPromptCriteriaHint",
    icon: ListChecks,
    scope: "workspace",
    key: "work_item_criteria",
  },
  {
    id: "work_item_tasks",
    task: "work_item_review",
    labelKey: "prompts.workItemTasks",
    hintKey: "settings.wiPromptTasksHint",
    icon: Split,
    scope: "workspace",
    key: "work_item_tasks",
  },
  {
    id: "work_item_tasks_qa",
    task: "work_item_review",
    labelKey: "prompts.workItemTasksQa",
    hintKey: "settings.wiPromptTasksQaHint",
    icon: FlaskConical,
    scope: "workspace",
    key: "work_item_tasks_qa",
  },
  {
    id: "work_item_qa_estimation",
    task: "work_item_review",
    labelKey: "prompts.workItemQaEstimation",
    hintKey: "settings.wiPromptQaEstimationHint",
    icon: Calculator,
    scope: "workspace",
    key: "work_item_qa_estimation",
  },

  // ---------- workspace: documentation ----------
  {
    id: "repo_doc",
    task: "wiki",
    labelKey: "prompts.repoDoc",
    hintKey: "settings.wikiPromptRepoHint",
    icon: FileCode2,
    scope: "workspace",
    key: "repo_doc",
  },
  {
    id: "workspace_doc",
    task: "wiki",
    labelKey: "prompts.workspaceDoc",
    hintKey: "settings.wikiPromptWorkspaceHint",
    icon: Network,
    scope: "workspace",
    key: "workspace_doc",
  },
];

/** The prompts one task sends, in declaration order. */
export function promptsForTask(task: string): PromptDef[] {
  return AI_PROMPTS.filter((prompt) => prompt.task === task);
}

/** The built-in text for a prompt — what "restore default" puts back, and what "edited" compares
 *  against. */
export async function loadPromptDefault(prompt: PromptDef): Promise<string> {
  if (prompt.scope === "workspace") return defaultWorkspacePrompt(prompt.key).catch(() => "");
  switch (prompt.key) {
    case "commit_template":
      return defaultCommitTemplate().catch(() => "");
    case "analyze_template":
      return defaultAnalyzeTemplate().catch(() => "");
    case "resolve_conflict_template":
      return defaultResolveConflictTemplate().catch(() => "");
    case "pipeline_template":
      return defaultPipelineTemplate().catch(() => "");
    default:
      return "";
  }
}

/** The text in force: the user's version when there is one, the built-in otherwise. */
export async function loadPromptValue(
  prompt: PromptDef,
  workspaceId: string | null,
  fallback: string,
): Promise<string> {
  if (prompt.scope === "workspace") {
    if (!workspaceId) return fallback;
    const stored = await getWorkspacePrompt(workspaceId, prompt.key).catch(() => null);
    // The backend already falls back to the default, so a blank here means "no workspace yet".
    return stored?.trim() ? stored : fallback;
  }
  const [stored, legacy] = await Promise.all([
    getSetting(prompt.key).catch(() => null),
    prompt.legacyKey ? getSetting(prompt.legacyKey).catch(() => null) : Promise.resolve(null),
  ]);
  if (stored?.trim()) return stored;
  if (legacy?.trim()) return legacy;
  return fallback;
}

export async function savePromptValue(
  prompt: PromptDef,
  workspaceId: string | null,
  value: string,
): Promise<void> {
  if (prompt.scope === "workspace") {
    if (!workspaceId) return;
    await setWorkspacePrompt(workspaceId, prompt.key, value.trim());
    return;
  }
  await setSetting(prompt.key, value.trim());
}

/**
 * Restores the built-in text.
 *
 * Blanked rather than overwritten with a copy of the current default: an empty override is what
 * makes both backends fall back, so a later release that improves the built-in prompt still reaches
 * a workspace that pressed this button.
 */
export async function resetPromptValue(prompt: PromptDef, workspaceId: string | null): Promise<void> {
  await savePromptValue(prompt, workspaceId, "");
}

/** Whether the saved text still honours the prompt's output contract, if it has one. */
export function contractHolds(prompt: PromptDef, value: string): boolean {
  return !prompt.contract || prompt.contract.test.test(value);
}
