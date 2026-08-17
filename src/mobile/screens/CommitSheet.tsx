import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { FileDiff } from "./DiffView";
import type { CommitInfo, FileDiffInfo } from "../../types/domain";

/**
 * One commit, and what it changed.
 *
 * # Why the whole changeset arrives in one call
 *
 * `get_commit_diff` answers with every file's diff at once. Its per-file sibling,
 * `get_commit_file_diff`, is **not** in the remote allowlist — and asking for it to be added would
 * trade one round trip for N over a home wifi link, which is the wrong trade for a screen whose
 * whole job is "let me see what that commit was". So the cost is paid once, on open, and every file
 * is then free to expand.
 *
 * Which is also why the file list starts collapsed. A twelve-file commit expanded on arrival is
 * twelve diffs laid out before the user has said which one they came for; the header row alone
 * already answers "what did this touch".
 */

function pathOf(file: FileDiffInfo): string {
  // `new_path` for everything except a deletion, which only has the old one. Never both, because at
  // this width a rename's two paths wrap into four lines of chrome above one line of code.
  return file.new_path ?? file.old_path ?? "";
}

function FileSection({ file }: { file: FileDiffInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-[var(--cf-border)] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cf-tap flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        {/* Same `rtl` truncation as every other path in this client: the filename survives and the
            directory is what gets cut. */}
        <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ direction: "rtl" }}>
          <bdi>{pathOf(file)}</bdi>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">
          {file.status}
        </span>
      </button>
      {open && (
        <div className="pb-2">
          <FileDiff diff={file} />
        </div>
      )}
    </div>
  );
}

export function CommitSheet({
  repoPath,
  commit,
  onClose,
}: {
  repoPath: string;
  commit: CommitInfo;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<FileDiffInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void rpc<FileDiffInfo[]>("get_commit_diff", { repoPath, oid: commit.id })
      .then((result) => {
        if (!alive) return;
        setFiles(result);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, commit.id, attempt]);

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-[var(--cf-bg)]">
      <div className="cf-safe-top flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-1 py-1.5">
        <button type="button" onClick={onClose} className="cf-tap flex items-center px-2">
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{commit.summary}</span>
        <span className="mr-2 shrink-0 font-mono text-[11px] text-[var(--cf-text-muted)]">
          {commit.short_id}
        </span>
      </div>

      <div className="cf-scroll flex-1 px-3 pb-6">
        <p className="mt-2 text-[11px] text-[var(--cf-text-muted)]">
          {commit.author_name} · {new Date(commit.timestamp * 1000).toLocaleString()}
        </p>

        {loading ? (
          <Loader2 size={16} className="mx-auto mt-6 animate-spin text-[var(--cf-text-muted)]" />
        ) : error ? (
          <div className="mt-6 flex flex-col items-center gap-2 text-center">
            <p className="text-[13px] text-[var(--cf-text-muted)]">{t("diff.failed")}</p>
            <p className="break-words font-mono text-[11px] text-[var(--cf-text-muted)]">{error}</p>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="cf-tap rounded-lg border border-[var(--cf-border)] px-4 text-[13px]"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : !files || files.length === 0 ? (
          // A commit that changed nothing against its first parent — an empty commit, or a merge
          // whose result matches the side it came from. Rare, real, and not a failure.
          <p className="mt-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("common.empty")}</p>
        ) : (
          <>
            <p className="mt-3 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("commits.files", { n: files.length })}
            </p>
            <div className="mt-1 overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
              {files.map((file, index) => (
                <FileSection key={`${pathOf(file)}-${index}`} file={file} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
