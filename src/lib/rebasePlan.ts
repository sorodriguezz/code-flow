import type { RebaseStep } from "./tauri/commands";
import type { TranslationKey } from "./i18n/translations";

/** Why a plan cannot run, checked before git is asked — the same rules `git/rebase.rs` enforces.
 *  `steps` oldest first. */
export function rebasePlanProblem(steps: RebaseStep[]): TranslationKey | null {
  const kept = steps.filter((step) => step.action !== "drop");
  if (kept.length === 0) return "rebase.problemAllDropped";
  if (kept[0].action === "squash" || kept[0].action === "fixup") return "rebase.problemSquashFirst";
  if (steps.some((step) => step.action === "reword" && !step.message?.trim())) return "rebase.problemEmptyMessage";
  return null;
}
