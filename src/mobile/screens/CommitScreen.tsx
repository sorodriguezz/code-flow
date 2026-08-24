import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, GitCommitHorizontal } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { absolute } from "../time";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Badge, ErrorState, SkeletonList } from "../ui/Feedback";
import { Card, PathText, Section } from "../ui/List";
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
  const path = pathOf(file);
  return (
    <div className="border-b border-[var(--cf-divider)] last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="cf-tap cf-press-row flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
        )}
        <PathText path={path} className="min-w-0 flex-1 text-base" />
        <Badge className="font-mono">{file.status}</Badge>
      </button>
      {open && (
        <div className="bg-[var(--cf-bg)] pb-2">
          <FileDiff diff={file} />
        </div>
      )}
    </div>
  );
}

export function CommitScreen({ repoPath, commit }: { repoPath: string; commit: CommitInfo }) {
  const [files, setFiles] = useState<FileDiffInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

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
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, commit.id, attempt]);

  return (
    <Screen
      bar={
        <PushBar
          title={commit.summary}
          subtitle={
            <>
              <span className="font-mono">{commit.short_id}</span> · {commit.author_name}
            </>
          }
        />
      }
    >
      <Card padded className="mt-3">
        <div className="flex items-start gap-2.5">
          <GitCommitHorizontal
            size={17}
            className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="cf-selectable text-base leading-snug">{commit.summary}</p>
            <p className="mt-1 text-xs text-[var(--cf-text-muted)]">
              {commit.author_name} · {absolute(commit.timestamp)}
            </p>
            {/* Which branches and tags point here. The backend already sends them and nothing drew
                them, so a commit that *is* `main` looked exactly like one three commits behind it. */}
            {commit.refs.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {commit.refs.map((ref) => (
                  <Badge key={`${ref.kind}-${ref.name}`} tone="accent">
                    {ref.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>

      {loading ? (
        <Section title={t("commits.files", { n: "…" })}>
          <SkeletonList rows={3} />
        </Section>
      ) : error ? (
        <ErrorState title={t("diff.failed")} detail={error} onRetry={reload} />
      ) : !files || files.length === 0 ? (
        // A commit that changed nothing against its first parent — an empty commit, or a merge
        // whose result matches the side it came from. Rare, real, and not a failure.
        <p className="px-6 pt-10 text-center text-base text-[var(--cf-text-muted)]">
          {t("common.empty")}
        </p>
      ) : (
        <Section title={t("commits.files", { n: files.length })}>
          <Card>
            {files.map((file, index) => (
              <FileSection key={`${pathOf(file)}-${index}`} file={file} />
            ))}
          </Card>
        </Section>
      )}
    </Screen>
  );
}
