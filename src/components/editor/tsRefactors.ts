import type { Monaco } from "@monaco-editor/react";
import type { CancellationToken, IRange, Range, editor as MonacoEditorNS, languages } from "monaco-editor";
import {
  TS_LANGUAGES,
  tsFileOf,
  tsIsRunning,
  tsRelPath,
  tsRequest,
  tsServedProject,
  tsSynced,
  type TsApplicableRefactor,
  type TsFileCodeEdits,
  type TsRefactorEditInfo,
} from "../../lib/tsserver";
import { applyEditPlan, defaultApplyDeps, planTsFileEdits, type ApplyOutcome } from "../../lib/workspaceEdit";
import { createFile, statEditorFile } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import { useRepoStore } from "../../state/repoStore";
import { translate } from "../../state/languageStore";

/**
 * The compiler's refactorings, and Organize Imports — the code actions that are not fixes.
 *
 * # What this adds
 *
 * Until now the only code actions TypeScript offered here were quick fixes for errors (`compilerFixes`
 * and the missing-package install in `useTypeScript`): Ctrl+. on a selection that compiled offered
 * nothing. `tsserver` has always known how to extract a function or a constant, move a declaration to
 * a new file, turn a function into an arrow and back, and sort and prune a file's imports — the menu
 * VS Code opens on the same keys is this same server's answer. So it is asked, and the answer goes
 * into Monaco's own surfaces: the lightbulb on a selection, Ctrl+., "Refactor…" (⌃⇧R) and "Source
 * Action…" in the context menu, and ⇧⌥O for organize imports.
 *
 * # Asked for the list, not for the edits
 *
 * `getApplicableRefactors` names what is possible and costs little; `getEditsForRefactor` does the
 * work, and doing it for every row of a menu nobody has picked from yet would be the expensive half
 * for nothing. So each action carries a command, and the edits are asked for once a row is chosen —
 * the same split VS Code's TypeScript extension makes.
 *
 * # Applied by `workspaceEdit`, not by Monaco
 *
 * Monaco's bulk edit refuses any file without a model, and a refactoring is not confined to the file
 * on screen: "Move to a new file" writes a file that does not exist yet and adds an import to the one
 * that does. So the edits go through `applyEditPlan`, the way a rename's do — open tabs in their
 * buffers (one Ctrl+Z away), every other file through the checked write after a restore point — and a
 * file that is not there yet is created first.
 *
 * # Then the rename
 *
 * An extraction has to invent a name (`newFunction`, `newLocal`), and the name is the first thing
 * anyone changes. tsserver says where it put it, and the rename box opens there — again VS Code's
 * behaviour — once the server has the new text (`tsSynced`): asked about the old one, it would offer to
 * rename whatever used to be at those coordinates.
 */

/** The command a refactoring row runs once it is picked. Registered once for the whole app, like the
 *  providers — command ids are global. */
const REFACTOR_COMMAND = "cf.ts.refactor";
const ORGANIZE_IMPORTS_COMMAND = "cf.ts.organizeImports";

/**
 * What the provider can answer with — which is what makes Monaco offer "Refactor…", "Source
 * Action…" and ⇧⌥O for a TypeScript file at all. Monaco enables those entries from the kinds the
 * registered providers *declare*, not from what they happen to return, so a provider that declared
 * nothing would answer Ctrl+. and stay out of every menu.
 */
const PROVIDED_KINDS = [
  "refactor",
  "refactor.extract",
  "refactor.inline",
  "refactor.move",
  "refactor.rewrite",
  "source.organizeImports",
];

/** Whether `kind` falls under `parent` in the dotted hierarchy (`refactor` covers `refactor.extract`). */
function covers(parent: string, kind: string): boolean {
  return kind === parent || kind.startsWith(`${parent}.`);
}

let installed = false;

export function installTsRefactors(monaco: Monaco): void {
  if (installed) return;
  installed = true;

  monaco.editor.registerCommand(
    REFACTOR_COMMAND,
    (_accessor: unknown, modelUri: string, file: string, range: IRange, refactor: string, action: string) =>
      void runRefactor(monaco, modelUri, file, range, refactor, action),
  );
  monaco.editor.registerCommand(ORGANIZE_IMPORTS_COMMAND, (_accessor: unknown, file: string) => void organizeImports(file));

  monaco.languages.registerCodeActionProvider(
    TS_LANGUAGES,
    {
      provideCodeActions: async (
        model: MonacoEditorNS.ITextModel,
        range: Range,
        context: languages.CodeActionContext,
        token: CancellationToken,
      ) => {
        const none = { actions: [], dispose: () => {} };
        const file = tsFileOf(model.uri);
        if (!file || !tsIsRunning()) return none;
        const actions: languages.CodeAction[] = [];
        // A source action is only ever asked for by name — ⇧⌥O or "Source Action…" — and offering it
        // to the lightbulb would light it on every line of every file.
        if (context.only && covers(context.only, "source.organizeImports")) {
          const title = translate("editor.organizeImports");
          actions.push({
            title,
            kind: "source.organizeImports",
            command: { id: ORGANIZE_IMPORTS_COMMAND, title, arguments: [file] },
          });
        }
        const invoked = context.trigger === monaco.languages.CodeActionTriggerType.Invoke;
        actions.push(...(await refactorsAt(model, file, range, context, invoked, token)));
        return { actions, dispose: () => {} };
      },
    },
    { providedCodeActionKinds: PROVIDED_KINDS },
  );
}

/**
 * The refactorings tsserver can do on `range`, as rows that run `REFACTOR_COMMAND`.
 *
 * Unasked — the lightbulb, which Monaco consults on every move of the caret — only for a selection:
 * a caret resting on a line is not a question, and the server can always offer *something* there
 * ("Convert to arrow function"), which would light the bulb on half the lines of a file. Ctrl+.,
 * "Refactor…" and a selection are asking; those get the full list, including the rows the server
 * knows but cannot run here, greyed out with its reason why.
 */
async function refactorsAt(
  model: MonacoEditorNS.ITextModel,
  file: string,
  range: Range,
  context: languages.CodeActionContext,
  /** Asked for — Ctrl+., "Refactor…" — rather than consulted for the lightbulb. */
  invoked: boolean,
  token: CancellationToken,
): Promise<languages.CodeAction[]> {
  if (context.only && !covers(context.only, "refactor") && !covers("refactor", context.only)) return [];
  if (!invoked && range.isEmpty()) return [];
  const span: IRange = {
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: range.endColumn,
  };
  const infos = await tsRequest<TsApplicableRefactor[]>("getApplicableRefactors", {
    file,
    startLine: span.startLineNumber,
    startOffset: span.startColumn,
    endLine: span.endLineNumber,
    endOffset: span.endColumn,
    triggerReason: invoked ? "invoked" : "implicit",
    // Narrowed by the server when Monaco asked for one family ("Refactor…" asks for `refactor`).
    kind: context.only,
  }).catch(() => null);
  if (!infos || token.isCancellationRequested) return [];
  const actions: languages.CodeAction[] = [];
  for (const info of infos) {
    for (const action of info.actions) {
      // "Move to file" needs a destination picked from a list this editor has no widget for. Never
      // requested (`includeInteractiveActions` is left off), so this is a guard, not a filter.
      if (action.isInteractive) continue;
      // Older servers leave `kind` out; `refactor` is still true of every one of them.
      const kind = action.kind ?? "refactor";
      if (context.only && !covers(context.only, kind) && !covers(kind, context.only)) continue;
      actions.push({
        title: action.description,
        kind,
        disabled: action.notApplicableReason,
        command: {
          id: REFACTOR_COMMAND,
          title: action.description,
          arguments: [model.uri.toString(), file, span, info.name, action.name],
        },
      });
    }
  }
  return actions;
}

async function runRefactor(
  monaco: Monaco,
  modelUri: string,
  file: string,
  range: IRange,
  refactor: string,
  action: string,
): Promise<void> {
  const project = tsServedProject();
  if (!project || !tsIsRunning()) return;
  let info: TsRefactorEditInfo | null;
  try {
    info = await tsRequest<TsRefactorEditInfo>("getEditsForRefactor", {
      file,
      startLine: range.startLineNumber,
      startOffset: range.startColumn,
      endLine: range.endLineNumber,
      endOffset: range.endColumn,
      refactor,
      action,
    });
  } catch (e) {
    pushErrorToast(translate("editor.refactorFailed", { error: String(e) }));
    return;
  }
  if (!info) return;
  if (info.notApplicableReason) {
    pushErrorToast(translate("editor.refactorFailed", { error: info.notApplicableReason }));
    return;
  }
  const outcome = await applyTsEdits(project.repoPath, info.edits);
  if (!outcome || !info.renameLocation) return;
  const renameFile = info.renameFilename ?? file;
  // Only where the refactoring was asked from — the one file there is an editor in front of.
  if (tsRelPath(renameFile) !== tsRelPath(file)) return;
  if (!outcome.applied.some((applied) => applied.path === tsRelPath(file))) return;
  await renameAt(monaco, modelUri, info.renameLocation);
}

/**
 * Organize Imports: unused ones removed, the rest merged per module and sorted — tsserver's own,
 * so it agrees with the project's `tsconfig` and with what VS Code would have written.
 */
async function organizeImports(file: string): Promise<void> {
  const project = tsServedProject();
  if (!project || !tsIsRunning()) return;
  let edits: TsFileCodeEdits[] | null;
  try {
    edits = await tsRequest<TsFileCodeEdits[]>("organizeImports", { scope: { type: "file", args: { file } } });
  } catch (e) {
    pushErrorToast(translate("editor.refactorFailed", { error: String(e) }));
    return;
  }
  if (edits?.length) await applyTsEdits(project.repoPath, edits);
}

/**
 * tsserver's edits, applied the way a rename's are — see `workspaceEdit` — with one addition: a file
 * that does not exist yet is created empty first, so the checked write has something to write into.
 * Only "Move to a new file" ever names one; its edits are insertions at the top of an empty file.
 *
 * Says nothing when every file took its change — the change is right there in the buffer — and
 * names the first file that did not otherwise.
 */
async function applyTsEdits(repoPath: string, edits: readonly TsFileCodeEdits[]): Promise<ApplyOutcome | null> {
  const plan = planTsFileEdits(edits, tsRelPath);
  if (plan.files.length === 0) return null;
  const deps = defaultApplyDeps(repoPath);
  for (const file of plan.files) {
    if (deps.host?.isOpen(file.path)) continue;
    const there = await statEditorFile(repoPath, file.path, null).catch(() => undefined);
    if (there === null) await createFile(repoPath, file.path).catch(() => undefined);
  }
  const outcome = await applyEditPlan(plan, deps);
  const trouble =
    outcome.failed[0] !== undefined
      ? `${outcome.failed[0].path}: ${outcome.failed[0].error}`
      : outcome.conflicts[0] !== undefined
        ? translate("editor.refactorConflict", { path: outcome.conflicts[0] })
        : null;
  if (trouble) pushErrorToast(translate("editor.refactorFailed", { error: trouble }));
  // The Changes panel and the tree read git status, which knows nothing of a write it did not see.
  if (outcome.applied.some((file) => !file.inBuffer)) void useRepoStore.getState().refreshStatus();
  return outcome;
}

/** Opens the rename box at `location` in the editor showing `modelUri` — the focused one, when the
 *  same file is open in two splits. */
async function renameAt(monaco: Monaco, modelUri: string, location: { line: number; offset: number }): Promise<void> {
  const editors: MonacoEditorNS.ICodeEditor[] = monaco.editor
    .getEditors()
    .filter((candidate: MonacoEditorNS.ICodeEditor) => candidate.getModel()?.uri.toString() === modelUri);
  const editor = editors.find((candidate) => candidate.hasWidgetFocus()) ?? editors[0];
  if (!editor) return;
  await tsSynced();
  const position = { lineNumber: location.line, column: location.offset };
  editor.setPosition(position);
  editor.revealPositionInCenterIfOutsideViewport(position);
  editor.focus();
  editor.trigger("cf-refactor", "editor.action.rename", null);
}
