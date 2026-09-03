/**
 * "How did this file get here" — the commits that touched one path, newest first.
 *
 * The app had blame, which answers *who wrote this line*, and nothing that answered the other half.
 * They are genuinely different questions: blame shows you the last hand on each line and hides
 * every step before it, which is exactly the wrong tool when the line you are looking at is fine
 * and the file stopped working three commits ago.
 *
 * Selecting a commit here sends the graph to it, rather than opening a second diff viewer inside
 * this dialog: the graph already draws a commit and its files properly, and a smaller copy of it in
 * a modal would be a worse one.
 *
 * Renames end the history, deliberately and visibly — libgit2 has no `--follow`, and pretending
 * otherwise by guessing at similarity would produce a list that is sometimes silently wrong. This
 * is what `git log <path>` shows without `--follow` too.
 */

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { EmptyState } from "../common/EmptyState";
import { Skeleton } from "../common/Skeleton";
import { fileHistory } from "../../lib/tauri/commands";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";
import type { CommitInfo } from "../../types/domain";

/** Enough to answer the question; a file with more history than this has a different question. */
const LIMIT = 200;

export function FileHistoryModal({ path, onClose }: { path: string; onClose: () => void }) {
  const t = useT();
  const repoPath = useRepoStore((s) => s.repoPath);
  const selectCommit = useRepoStore((s) => s.selectCommit);

  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fileHistory(repoPath, path, LIMIT);
        if (!cancelled) setCommits(rows);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath, path]);

  return (
    <ApiModal
      icon={History}
      title={t("changes.menuHistory")}
      // The path, in full, as the subtitle — it is what the dialog is *about*, and the one string
      // here that identifies which file you are looking at.
      subtitle={path}
      width="max-w-2xl"
      height="h-[70vh]"
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error ? (
          <EmptyState icon={History} title={t("graph.errorTitle")} subtitle={error} />
        ) : commits === null ? (
          <div className="space-y-1.5 px-1" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : commits.length === 0 ? (
          <EmptyState
            icon={History}
            title={t("changes.historyEmpty")}
            subtitle={t("changes.historyEmptyHint")}
          />
        ) : (
          <ul className="space-y-0.5">
            {commits.map((commit) => (
              <li key={commit.id}>
                <button
                  type="button"
                  onClick={() => {
                    void selectCommit(commit.id);
                    onClose();
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                >
                  <span className="mt-[2px] shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">
                    {commit.short_id}
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* Wraps rather than truncating: a commit summary is the whole reason a row is
                        in this list, and half of one names nothing. */}
                    <span className="block break-words text-[12.5px] leading-snug text-[var(--cf-text)]">
                      {commit.summary}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
                      {commit.author_name} ·{" "}
                      {new Date(commit.timestamp * 1000).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {commits && commits.length >= LIMIT && (
          <p className="px-2 py-2 text-[11px] text-[var(--cf-text-muted)]">
            {t("changes.historyCapped", { n: LIMIT })}
          </p>
        )}
      </div>
    </ApiModal>
  );
}
