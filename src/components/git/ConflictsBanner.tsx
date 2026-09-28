import { lazy, Suspense, useEffect, useState } from "react";
import { AlertTriangle, Check, Code2, GitMerge, X } from "lucide-react";
import { useConflictEditorStore } from "../../state/conflictEditorStore";
import { AiSparkles } from "../common/AiGlyph";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { OperationKind } from "../../types/domain";

/**
 * Lazy, and this banner is the reason it has to be.
 *
 * The banner itself is rendered by the Changes panel, which is on the first frame — so a static
 * import from here would put the editor's four Monaco panes in the entry chunk and make every launch
 * pay 4 MB to draw a merge editor that most sessions never open. The modal is behind a click on a
 * conflicted file, so the chunk is fetched at exactly the moment the user has asked for it.
 */
const ConflictResolveModal = lazy(() =>
  import("./ConflictResolveModal").then((m) => ({ default: m.ConflictResolveModal })),
);

const TITLES: Record<OperationKind, TranslationKey> = {
  merge: "conflicts.titleMerge",
  revert: "conflicts.titleRevert",
  cherry_pick: "conflicts.titleCherryPick",
  rebase: "conflicts.titleRebase",
};

/**
 * Whatever git has left half done, and the way out of it.
 *
 * It used to exist for a merge only. A revert or cherry-pick that conflicted, a pull that stopped
 * mid-rebase, a `stash pop` that could not apply cleanly — each left conflicted files behind with
 * nothing on screen about them. Now it is drawn whenever an operation is in progress *or* the index
 * holds conflicts, and its buttons fit the case:
 *
 * - a merge, revert or cherry-pick: a message (the one git prepared) and Continue/Abort, finished by
 *   the app itself;
 * - a rebase, or a multi-commit sequence from a terminal: Continue/Abort through `git <op>`, with no
 *   message — git uses each commit's own;
 * - conflicts with no operation behind them: only the files — once they are resolved they are
 *   ordinary staged changes, committed the ordinary way.
 */
export function ConflictsBanner() {
  const conflicts = useRepoStore((s) => s.conflicts);
  const operation = useRepoStore((s) => s.operation);
  const sequenced = useRepoStore((s) => s.operationSequenced);
  const preparedMessage = useRepoStore((s) => s.operationMessage);
  const resolveConflict = useRepoStore((s) => s.resolveConflict);
  const markConflictResolved = useRepoStore((s) => s.markConflictResolved);
  const continueOperation = useRepoStore((s) => s.continueOperation);
  const abortOperation = useRepoStore((s) => s.abortOperation);
  const busy = useRepoStore((s) => s.busy);
  const openInEditor = useUiStore((s) => s.openInEditor);
  const t = useT();
  const [message, setMessage] = useState(preparedMessage ?? "");
  // The three-way editor, opened from here or from a conflicted row of the Changes list — see
  // `conflictEditorStore`. Drawn here, which is on screen whenever there is a conflict to open.
  const editorPath = useConflictEditorStore((s) => s.path);
  const editorAi = useConflictEditorStore((s) => s.ai);
  const openEditor = useConflictEditorStore((s) => s.open);
  const closeEditor = useConflictEditorStore((s) => s.close);

  // The prepared message arrives with the refresh that finds the operation, after the first render —
  // and a different operation brings its own. Keyed on the text, so a watcher tick that reads the
  // same message back does not undo what the user has typed.
  useEffect(() => {
    setMessage(preparedMessage ?? (operation === "merge" ? "Merge" : ""));
  }, [preparedMessage, operation]);

  const ownCommit = operation !== null && !sequenced;
  const isMerge = operation === "merge";

  return (
    <div className="border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] p-3">
      <div
        className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-[var(--cf-text)]"
        title={operation ? undefined : t("conflicts.looseHint")}
      >
        <AlertTriangle size={14} className="text-[var(--cf-warning)]" />
        {t(operation ? TITLES[operation] : "conflicts.titleLoose")}
      </div>

      <div className={`space-y-1 ${operation ? "mb-3" : ""}`}>
        {conflicts.map((c) => (
          <div
            key={c.path}
            className="flex items-center gap-2 rounded-md bg-[var(--cf-surface)] px-2 py-1.5 text-[12px]"
          >
            <span className="flex-1 min-w-0 truncate font-mono">{c.path}</span>
            <button
              title={t("conflictEditor.open")}
              onClick={() => openEditor(c.path)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--cf-text)] hover:bg-[var(--cf-accent-soft)] hover:text-[var(--cf-accent)]"
            >
              <GitMerge size={12} />
              {t("conflictEditor.openShort")}
            </button>
            <button
              title={t("conflicts.aiResolveTitle")}
              onClick={() => openEditor(c.path, true)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]"
            >
              <AiSparkles size={12} />
              {t("conflicts.aiResolve")}
            </button>
            <button
              title={t("conflicts.keepOurs")}
              onClick={() => resolveConflict(c.path, "ours")}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-accent-soft)] hover:text-[var(--cf-accent)]"
            >
              {t("conflicts.keepOurs")}
            </button>
            <button
              title={t("conflicts.keepTheirs")}
              onClick={() => resolveConflict(c.path, "theirs")}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-accent-soft)] hover:text-[var(--cf-accent)]"
            >
              {t("conflicts.keepTheirs")}
            </button>
            <button
              title={t("conflicts.editManually")}
              onClick={() => openInEditor(c.path)}
              className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
            >
              <Code2 size={13} />
            </button>
            <button
              title={t("conflicts.markResolved")}
              onClick={() => markConflictResolved(c.path)}
              className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-success)]"
            >
              <Check size={13} />
            </button>
          </div>
        ))}
        {conflicts.length === 0 && operation && (
          <p className="rounded-md bg-[var(--cf-surface)] px-2 py-1.5 text-[12px] text-[var(--cf-success)]">
            {t("conflicts.allResolvedContinue")}
          </p>
        )}
      </div>

      {operation && (
        <div className="flex items-end gap-2">
          {ownCommit ? (
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              spellCheck={false}
              className="min-w-0 flex-1 resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-1 font-mono text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
            />
          ) : (
            <span className="flex-1" />
          )}
          <button
            disabled={busy || conflicts.length > 0 || (ownCommit && !message.trim())}
            title={ownCommit ? t("conflicts.continueHint") : t("conflicts.rebaseContinueHint")}
            onClick={() => continueOperation(ownCommit ? message.trim() : undefined)}
            className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--cf-accent-fill)] px-2.5 py-1 text-[12px] font-medium text-[var(--cf-on-accent)] disabled:opacity-40"
          >
            <GitMerge size={12} />
            {isMerge ? t("conflicts.completeMerge") : t("conflicts.continue")}
          </button>
          <button
            disabled={busy}
            // Confirmed in the store, which also names the operation being thrown away.
            onClick={() => void abortOperation()}
            className="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[12px] text-[var(--cf-danger)] hover:bg-[var(--cf-hover)]"
          >
            <X size={12} />
            {isMerge ? t("conflicts.abortMerge") : t("conflicts.abort")}
          </button>
        </div>
      )}
      {editorPath && (
        // No fallback: the modal opens over the banner, and a skeleton flashing where a dialog is
        // about to be is worse than the dialog simply appearing a frame later. Keyed on the path so a
        // second file opens a fresh editor rather than inheriting the first one's result pane.
        <Suspense fallback={null}>
          <ConflictResolveModal key={editorPath} filePath={editorPath} autoAi={editorAi} onClose={closeEditor} />
        </Suspense>
      )}
    </div>
  );
}
