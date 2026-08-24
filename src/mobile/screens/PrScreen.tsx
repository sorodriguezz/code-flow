import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, GitPullRequest, ScanText, Sparkles } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { newId } from "../ids";
import { useBusy, useMobileStore } from "../store";
import { useNav } from "../nav";
import { onInvalidate } from "../invalidate";
import { navigated } from "../haptics";
import { sinceIso } from "../time";
import { toastError, toastSuccess } from "../toast";
import { RootBar } from "../ui/RootBar";
import { Screen } from "../ui/Screen";
import { Button, IconButton } from "../ui/Button";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge, EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
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
 *
 * # Failures are not empty lists
 *
 * Both reads used to end in `.catch(() => [])`, so a dropped packet, a revoked token and a host that
 * refused authentication all rendered as the calm sentence *"No hay pull requests abiertos."* — the
 * exact lie `store.ts`'s own header says was eliminated everywhere else. A project with no linked
 * host genuinely has no pull requests and genuinely errors, so the two are still folded together
 * for the PR list; what is no longer folded in is everything else.
 */

const PR_STATUS: Record<PullRequestSummary["status"], { label: string; tone: "accent" | "neutral" | "success" | "warning" }> =
  {
    open: { label: t("pr.status.open"), tone: "accent" },
    draft: { label: t("pr.status.draft"), tone: "neutral" },
    merged: { label: t("pr.status.merged"), tone: "success" },
    closed: { label: t("pr.status.closed"), tone: "warning" },
  };

/**
 * Copies a pull request's URL.
 *
 * The link beside it opens the host's own page, which on iOS in standalone mode leaves the app —
 * there is no browser chrome to come back through, so the user ends up in Safari and has to find the
 * home-screen icon again. The link is still worth having, because merging and commenting live there
 * and half-reimplementing them here would be worse than the real thing one tap away. Copying is the
 * escape hatch for the times you want it on the machine you are walking back to.
 */
async function copyUrl(url: string) {
  try {
    // `navigator.clipboard` needs a secure context and this page is plain HTTP on a LAN, so the
    // legacy path is not a fallback here — it is the one that runs. Kept in this order anyway for
    // the tablet somebody has behind a TLS proxy.
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const field = document.createElement("textarea");
      field.value = url;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      document.body.removeChild(field);
    }
    toastSuccess(t("common.copied"));
  } catch (e) {
    toastError(t("error.actionFailed"), e instanceof Error ? e.message : String(e));
  }
}

export function PrScreen() {
  const projectId = useMobileStore((s) => s.projectId);
  const workspaceId = useMobileStore((s) => s.workspaceId);
  const run = useMobileStore((s) => s.run);
  const push = useNav((s) => s.push);
  // `review` on its own: `review_pull_request` runs an engine and is awaited inline in the request,
  // so it holds its flag for as long as the model takes. Sharing one with the repository actions is
  // what used to freeze commit, push and every chain gate behind a review started from here.
  const busy = useBusy("review");
  const [prs, setPrs] = useState<PullRequestSummary[]>([]);
  const [runs, setRuns] = useState<ReviewRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setFailure(null);
    const [prList, runList] = await Promise.all([
      // A project with no linked host answers an error rather than an empty list, and that is not
      // a failure worth a red screen here — it just means this repository has no pull requests. The
      // *reason* is kept, so a genuine failure can still be shown under the empty state.
      rpc<PullRequestSummary[]>("list_pull_requests", { projectId }).catch((e: unknown) => {
        setFailure(e instanceof Error ? e.message : String(e));
        return [] as PullRequestSummary[];
      }),
      workspaceId
        ? rpc<ReviewRunSummary[]>("list_review_runs", { workspaceId }).catch(
            () => [] as ReviewRunSummary[],
          )
        : Promise.resolve([] as ReviewRunSummary[]),
    ]);
    // The scope may have moved while this was in flight — the guard every async load in this client
    // needs, and the one this screen did not have: two quick taps in the project picker used to
    // leave whichever request happened to land second describing the wrong repository.
    const state = useMobileStore.getState();
    if (state.projectId !== projectId || state.workspaceId !== workspaceId) return;
    setPrs(prList);
    setRuns(runList.filter((entry) => entry.project_id === projectId));
    setLoading(false);
  }, [projectId, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A review finished, was published, or had a finding dismissed — at the desk or on another
  // device. Both halves of this screen are read straight from the desktop and cached nowhere, so
  // re-reading is the whole of the reconciliation.
  useEffect(() => onInvalidate("reviews", projectId, () => void reload()), [reload, projectId]);

  if (!projectId) {
    return (
      <Screen bar={<RootBar title={t("nav.prs")} />}>
        <EmptyState
          icon={<GitPullRequest size={26} aria-hidden />}
          title={t("repo.noProject")}
          hint={t("repo.noProjectHint")}
        />
      </Screen>
    );
  }

  return (
    <Screen bar={<RootBar title={t("nav.prs")} />} onRefresh={reload}>
      <Section title={t("pr.open")}>
        {loading ? (
          <SkeletonList rows={2} />
        ) : prs.length === 0 ? (
          failure ? (
            <ErrorState title={t("pr.failed")} detail={failure} onRetry={() => void reload()} />
          ) : (
            <EmptyState
              icon={<GitPullRequest size={26} aria-hidden />}
              title={t("pr.none")}
              hint={t("pr.noneHint")}
            />
          )
        ) : (
          <Card>
            {prs.map((pr, index) => {
              const status = PR_STATUS[pr.status] ?? PR_STATUS.open;
              return (
                <div key={pr.id}>
                  {index > 0 && <Divider />}
                  <div className="px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <GitPullRequest
                        size={15}
                        className="mt-0.5 shrink-0 text-[var(--cf-accent-text)]"
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-md font-medium leading-snug">{pr.title}</p>
                        <p className="mt-0.5 truncate text-xs text-[var(--cf-text-muted)]">
                          #{pr.id} · {pr.author} · {pr.source_branch} → {pr.target_branch}
                        </p>
                        <p className="text-2xs text-[var(--cf-text-faint)]">
                          {sinceIso(pr.created_at)}
                        </p>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        full
                        size="sm"
                        variant="primary"
                        loading={reviewing === pr.id}
                        disabled={busy || reviewing !== null}
                        icon={<Sparkles size={13} />}
                        onClick={() => {
                          setReviewing(pr.id);
                          void run(
                            async () => {
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
                            },
                            "review",
                            t("toast.reviewDone"),
                          );
                        }}
                      >
                        {reviewing === pr.id ? t("pr.reviewing") : t("pr.review")}
                      </Button>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="cf-tap cf-press flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 text-sm"
                      >
                        <ExternalLink size={13} aria-hidden /> {t("pr.openInHost")}
                      </a>
                      <IconButton
                        icon={<Copy size={15} />}
                        label={t("pr.copyLink")}
                        onClick={() => void copyUrl(pr.url)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </Section>

      <Section title={t("pr.savedRuns")}>
        {loading ? (
          <SkeletonList rows={2} />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={<ScanText size={26} aria-hidden />}
            title={t("pr.noRuns")}
            hint={t("pr.noRunsHint")}
          />
        ) : (
          <Card>
            {runs.map((entry, index) => (
              <div key={entry.id}>
                {index > 0 && <Divider />}
                <Row
                  title={entry.pr_title}
                  subtitle={`#${entry.pr_id} · ${t("pr.iteration", { n: entry.iter })} · ${entry.level} · ${sinceIso(entry.created_at)}`}
                  trailing={
                    <Badge tone={entry.findings_count > 0 ? "warning" : "success"}>
                      {entry.findings_count}
                    </Badge>
                  }
                  onClick={() => {
                    navigated();
                    push({
                      k: "review",
                      projectId,
                      runId: entry.id,
                      prId: entry.pr_id,
                      iter: entry.iter,
                    });
                  }}
                />
              </div>
            ))}
          </Card>
        )}
      </Section>
    </Screen>
  );
}
