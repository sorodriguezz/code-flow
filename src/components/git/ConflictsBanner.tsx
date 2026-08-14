import { lazy, Suspense, useState } from "react";
import { AlertTriangle, Check, Code2, GitMerge, Sparkles, X } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * Lazy, and this banner is the reason it has to be.
 *
 * The banner itself is rendered by the Changes panel, which is on the first frame — so a static
 * import from here would put the modal's two Monaco editors in the entry chunk and make every
 * launch pay 4 MB to draw a merge dialog that most sessions never open. The modal is already
 * behind `aiFile &&`, i.e. behind a click on "resolve with AI", so the chunk is fetched at exactly
 * the moment the user has asked for it.
 */
const ConflictResolveModal = lazy(() =>
  import("./ConflictResolveModal").then((m) => ({ default: m.ConflictResolveModal })),
);

export function ConflictsBanner() {
  const conflicts = useRepoStore((s) => s.conflicts);
  const resolveConflict = useRepoStore((s) => s.resolveConflict);
  const markConflictResolved = useRepoStore((s) => s.markConflictResolved);
  const completeMerge = useRepoStore((s) => s.completeMerge);
  const abortMerge = useRepoStore((s) => s.abortMerge);
  const busy = useRepoStore((s) => s.busy);
  const openInEditor = useUiStore((s) => s.openInEditor);
  const t = useT();
  const [message, setMessage] = useState("Merge");
  const [aiFile, setAiFile] = useState<string | null>(null);

  return (
    <div className="border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-[var(--cf-text)]">
        <AlertTriangle size={14} className="text-[var(--cf-warning)]" />
        {t("conflicts.title")}
      </div>

      <div className="mb-3 space-y-1">
        {conflicts.map((c) => (
          <div
            key={c.path}
            className="flex items-center gap-2 rounded-md bg-[var(--cf-surface)] px-2 py-1.5 text-[12px]"
          >
            <span className="flex-1 min-w-0 truncate font-mono">{c.path}</span>
            <button
              title={t("conflicts.aiResolveTitle")}
              onClick={() => setAiFile(c.path)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]"
            >
              <Sparkles size={12} />
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
        {conflicts.length === 0 && (
          <p className="rounded-md bg-[var(--cf-surface)] px-2 py-1.5 text-[12px] text-[var(--cf-success)]">
            {t("conflicts.allResolved")}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />
        <button
          disabled={busy || conflicts.length > 0 || !message.trim()}
          onClick={() => completeMerge(message.trim())}
          className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
        >
          <GitMerge size={12} />
          {t("conflicts.completeMerge")}
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            if (await confirmAction(t("conflicts.abortConfirm"))) void abortMerge();
          }}
          className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] text-[var(--cf-danger)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
        >
          <X size={12} />
          {t("conflicts.abortMerge")}
        </button>
      </div>
      {aiFile && (
        // No fallback: the modal opens over the banner, and a skeleton flashing where a dialog is
        // about to be is worse than the dialog simply appearing a frame later.
        <Suspense fallback={null}>
          <ConflictResolveModal filePath={aiFile} onClose={() => setAiFile(null)} />
        </Suspense>
      )}
    </div>
  );
}
