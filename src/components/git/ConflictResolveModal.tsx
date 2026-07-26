import { useEffect, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { AlertTriangle, Check, Columns2, Loader2, Sparkles, X } from "lucide-react";
import { readFileText, writeFileText, resolveConflictWithAi } from "../../lib/tauri/commands";
import { useRepoStore } from "../../state/repoStore";
import { useThemeStore } from "../../state/themeStore";
import { parseClaudeError } from "../../lib/claudeError";
import { languageForPath } from "../../lib/monacoLanguage";
import { useT } from "../../state/languageStore";

/**
 * AI-assisted resolution for a single conflicted file. On open it asks the backend to merge the
 * file's base/ours/theirs versions and shows the proposal in an editable Monaco editor (with a
 * side-by-side diff toggle against the current marker-laden working copy). Nothing touches disk
 * until the user accepts — then the edited proposal is written and the file is staged as resolved.
 */
export function ConflictResolveModal({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const t = useT();
  const repoPath = useRepoStore((s) => s.repoPath);
  const markConflictResolved = useRepoStore((s) => s.markConflictResolved);


  const [original, setOriginal] = useState("");
  const [proposal, setProposal] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const generate = async () => {
    if (!repoPath) return;
    setLoading(true);
    setError(null);
    try {
      const [current, proposed] = await Promise.all([
        readFileText(repoPath, filePath).catch(() => ""),
        resolveConflictWithAi(repoPath, filePath),
      ]);
      setOriginal(current);
      setProposal(proposed);
    } catch (e) {
      setError(parseClaudeError(String(e)).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  const busy = loading || accepting;
  const language = languageForPath(filePath);
  const theme = useThemeStore((s) => s.monacoTheme);

  const accept = async () => {
    if (!repoPath || !proposal.trim()) return;
    setAccepting(true);
    try {
      await writeFileText(repoPath, filePath, proposal);
      await markConflictResolved(filePath);
      onClose();
    } catch (e) {
      setError(parseClaudeError(String(e)).message);
      setAccepting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6" onClick={busy ? undefined : onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[85vh] w-[900px] max-w-[95vw] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] p-3">
          <Sparkles size={15} className="shrink-0 text-[var(--cf-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--cf-text)]">{t("conflicts.aiResolveTitle")}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{filePath}</span>
          {!loading && !error && (
            <button
              onClick={() => setShowDiff((v) => !v)}
              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
            >
              <Columns2 size={12} />
              {showDiff ? t("conflicts.aiEdit") : t("conflicts.aiViewDiff")}
            </button>
          )}
          {!busy && (
            <button onClick={onClose} className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={15} />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--cf-text-muted)]">
              <Loader2 size={20} className="animate-spin text-[var(--cf-accent)]" />
              {t("conflicts.aiResolving")}
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <AlertTriangle size={20} className="text-[var(--cf-danger)]" />
              <p className="max-w-[520px] text-[12px] text-[var(--cf-text)]">{error}</p>
              <button onClick={generate} className="text-[12px] text-[var(--cf-accent)] hover:underline">
                {t("sidebar.retry")}
              </button>
            </div>
          ) : showDiff ? (
            <DiffEditor
              height="100%"
              language={language}
              original={original}
              modified={proposal}
              theme={theme}
              options={{
                readOnly: true,
                fontSize: 13,
                renderSideBySide: true,
                useInlineViewWhenSpaceIsLimited: false,
                automaticLayout: true,
              }}
            />
          ) : (
            <Editor
              height="100%"
              language={language}
              value={proposal}
              theme={theme}
              onChange={(v) => setProposal(v ?? "")}
              options={{ fontSize: 13, minimap: { enabled: false }, automaticLayout: true }}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--cf-border)] p-3">
          <span className="text-[11px] text-[var(--cf-text-muted)]">{t("conflicts.aiReviewHint")}</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={accept}
              disabled={busy || error !== null || !proposal.trim()}
              className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
            >
              {accepting ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              {t("conflicts.aiAccept")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
