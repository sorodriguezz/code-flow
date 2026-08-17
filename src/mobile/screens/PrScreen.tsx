import { useEffect, useState } from "react";
import { ExternalLink, GitPullRequest, Loader2, Sparkles } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { newId } from "../ids";
import { useBusy, useMobileStore } from "../store";
import { onInvalidate } from "../invalidate";
import { ReviewDetail } from "./ReviewDetail";
import type { PullRequestSummary, ReviewRunSummary } from "../../types/domain";

/**
 * Pull requests, and the reviews already saved against them.
 *
 * The two halves are on one screen because they answer one question between them. The PR list says
 * what is waiting; the saved runs say what has already been read and what it found. Splitting them
 * into separate tabs would mean tapping back and forth to work out whether a PR still needs
 * looking at.
 *
 * Re-reviewing is offered and *opening* a pull request is not — see the allowlist. Re-reading
 * something that exists is repeatable and bounded; publishing one is a public act, and a phone in a
 * pocket is the wrong place to take it.
 */

export function PrScreen() {
  const { projectId, workspaceId, run } = useMobileStore();
  // `review` on its own: `review_pull_request` runs an engine and is awaited inline in the request,
  // so it holds its flag for as long as the model takes. Sharing one with the repository actions is
  // what used to freeze commit, push and every chain gate behind a review started from here.
  const busy = useBusy("review");
  const [prs, setPrs] = useState<PullRequestSummary[]>([]);
  const [runs, setRuns] = useState<ReviewRunSummary[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<number | null>(null);

  const reload = async () => {
    if (!projectId) return;
    setLoading(true);
    const [prList, runList] = await Promise.all([
      // A project with no linked host answers an error rather than an empty list, and that is not
      // a failure worth a red banner here — it just means this repository has no pull requests.
      rpc<PullRequestSummary[]>("list_pull_requests", { projectId }).catch(
        () => [] as PullRequestSummary[],
      ),
      workspaceId
        ? rpc<ReviewRunSummary[]>("list_review_runs", { workspaceId }).catch(
            () => [] as ReviewRunSummary[],
          )
        : Promise.resolve([] as ReviewRunSummary[]),
    ]);
    setPrs(prList);
    setRuns(runList.filter((entry) => entry.project_id === projectId));
    setLoading(false);
  };

  useEffect(() => {
    void reload();
    // Re-reads when the scope changes. `reload` is stable enough for this use and adding it to the
    // deps would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, workspaceId]);

  // A review finished, was published, or had a finding dismissed — at the desk or on another
  // device. Both halves of this screen are read straight from the desktop and cached nowhere, so
  // re-reading is the whole of the reconciliation. Without it a review started here and finished
  // minutes later left the list showing the run count as it was when the tab was opened.
  useEffect(
    () => onInvalidate("reviews", projectId, () => void reload()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, workspaceId],
  );

  // The saved review, with the actions that finish it — vote, publish, dismiss. See
  // `ReviewDetail` for why those three are confirmed and the rest of this client's writes are not.
  if (openRun) return <ReviewDetail id={openRun} onBack={() => setOpenRun(null)} />;

  if (!projectId) {
    return <p className="p-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("repo.noProject")}</p>;
  }

  return (
    <div className="cf-scroll flex-1 px-3 pb-6">
      {loading && <Loader2 size={16} className="mx-auto mt-4 animate-spin text-[var(--cf-text-muted)]" />}

      <p className="mt-3 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("pr.open")}
      </p>
      {prs.length === 0 && !loading ? (
        <p className="mt-1.5 px-1 text-[13px] text-[var(--cf-text-muted)]">{t("pr.none")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
          {prs.map((pr) => (
            <li key={pr.id} className="px-3 py-2.5">
              <div className="flex items-start gap-2">
                <GitPullRequest size={14} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-snug">{pr.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--cf-text-muted)]">
                    #{pr.id} · {pr.author} · {pr.source_branch} → {pr.target_branch}
                  </span>
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy || reviewing !== null}
                  onClick={() => {
                    setReviewing(pr.id);
                    void run(async () => {
                      try {
                        await rpc<string>("review_pull_request", {
                          projectId,
                          prId: pr.id,
                          jobId: newId(),
                          level: "standard",
                          force: false,
                        });
                        await reload();
                      } finally {
                        setReviewing(null);
                      }
                    }, "review");
                  }}
                  className="cf-tap flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] text-[12px] disabled:opacity-40"
                >
                  {reviewing === pr.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Sparkles size={13} />
                  )}
                  {t("pr.review")}
                </button>
                {/* Opens in the phone's browser rather than in an embedded view: the host's own
                    page is where merging, approving and commenting live, and half-reimplementing
                    that here would be worse than the real thing one tap away. */}
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="cf-tap flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] text-[12px]"
                >
                  <ExternalLink size={13} /> {t("pr.openInHost")}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("pr.savedRuns")}
      </p>
      {runs.length === 0 ? (
        <p className="mt-1.5 px-1 text-[13px] text-[var(--cf-text-muted)]">{t("pr.noRuns")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
          {runs.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => setOpenRun(entry.id)}
                className="cf-tap flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{entry.pr_title}</span>
                  <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                    #{entry.pr_id} · {t("pr.iteration", { n: entry.iter })} · {entry.level}
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-[var(--cf-border)]/50 px-2 py-0.5 text-[10px]">
                  {entry.findings_count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
