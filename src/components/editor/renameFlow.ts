import { applyEditPlan, defaultApplyDeps, type ApplyOutcome, type EditPlan } from "../../lib/workspaceEdit";
import { useEditorPanelStore, type ResultSet } from "../../state/editorPanelStore";
import { useToastStore } from "../../state/toastStore";
import { useRepoStore } from "../../state/repoStore";
import { translate } from "../../state/languageStore";

/**
 * A planned rename, applied and reported — the step both rename providers (`useLanguageServer` for
 * LSP, `useTypeScript` for tsserver) end in, so a rename reads the same whichever compiler planned
 * it. How it is applied is `lib/workspaceEdit`'s; this is what the user is told.
 *
 * The count always arrives as a toast. The file list opens in the panel under the editor when there
 * is something to look at: more than one file changed, or anything went wrong. A rename that stayed
 * inside the file on screen shows its result where it happened.
 */
export async function applyRename(plan: EditPlan, repoPath: string, newName: string): Promise<ApplyOutcome | null> {
  const toast = useToastStore.getState().pushToast;
  if (plan.files.length === 0) {
    toast(translate("editor.renameNothing"), "info");
    return null;
  }
  const outcome = await applyEditPlan(plan, defaultApplyDeps(repoPath));
  const summary = translate("editor.renameSummary", { changes: outcome.changes, files: outcome.applied.length });
  const results = renameResults(plan, outcome, newName, summary);
  const troubled = outcome.conflicts.length > 0 || outcome.failed.length > 0;

  if (outcome.applied.length > 1 || troubled) useEditorPanelStore.getState().showResults(results);
  toast(troubled ? `${summary} · ${translate("editor.renameIncomplete")}` : summary, troubled ? "error" : "success");
  // The Changes panel and the tree read git status, which knows nothing of a write it did not see.
  if (outcome.applied.some((file) => !file.inBuffer)) void useRepoStore.getState().refreshStatus();
  return outcome;
}

/** The results panel's view of a rename: the files it changed, where, and what it could not do. */
export function renameResults(plan: EditPlan, outcome: ApplyOutcome, newName: string, summary: string): ResultSet {
  const notes: string[] = [];
  for (const path of outcome.conflicts) notes.push(translate("editor.renameConflict", { path }));
  for (const failure of outcome.failed) {
    notes.push(translate("editor.renameFailed", { path: failure.path, error: failure.error }));
  }
  if (plan.outside.length > 0) notes.push(translate("editor.renameOutside", { n: plan.outside.length }));
  if (plan.unsupported > 0) notes.push(translate("editor.renameFileOps", { n: plan.unsupported }));
  const wroteToDisk = outcome.applied.some((file) => !file.inBuffer);
  if (wroteToDisk) {
    notes.push(outcome.checkpointId ? translate("editor.renameCheckpoint") : translate("editor.renameNoCheckpoint"));
  }
  if (outcome.applied.some((file) => file.inBuffer)) notes.push(translate("editor.renameUnsaved"));
  return {
    title: translate("editor.renameTitle", { name: newName, summary }),
    groups: outcome.applied.map((file) => ({
      path: file.path,
      items: file.at.map((position) => ({ line: position.lineNumber, column: position.column, text: position.text })),
    })),
    notes,
  };
}

