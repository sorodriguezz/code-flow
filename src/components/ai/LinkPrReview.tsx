import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Loader2, Sparkles, Square } from "lucide-react";
import { postPrLinkReviewComment, reviewPrFromLink } from "../../lib/tauri/commands";
import { renderMarkdown } from "../../lib/markdown";
import { parseClaudeError, type ClaudeErrorInfo } from "../../lib/claudeError";
import {
  buildFixpack,
  formatFindingAsComment,
  formatSummaryComment,
  parseAnalysis,
} from "../../lib/parseAnalysis";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { usePrStore } from "../../state/prStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { AiErrorBanner } from "./AiErrorBanner";
import { AiRunLog } from "./AiRunLog";
import { FindingCard, QualityGateBadges, SeverityCountBadges, SHORT_SUMMARY_MAX } from "./FindingCard";
import { ReviewLevelSelector } from "./ReviewLevelSelector";
import type { PullRequestSummary } from "../../types/domain";

/**
 * A pull-request review that never touches a working copy: the diff is read from the host's API,
 * so this runs for any PR the user's token can see, whether or not the repository exists on this
 * machine.
 *
 * What it gives up is real and is stated to the user rather than hidden: the model can't read the
 * rest of the codebase (so a finding that depends on unseen code is flagged as such instead of
 * asserted), findings have no "apply the fix" button (there's nothing to apply it to), and the run
 * isn't kept in history — `job_history` rows belong to a project, and this has none. Publishing to
 * the PR still works, since that only ever needed the API.
 */
export function LinkPrReview({ url, pr, workspaceId }: { url: string; pr: PullRequestSummary; workspaceId: string }) {
  const t = useT();
  const reviewLevel = usePrStore((s) => s.reviewLevel);
  const setReviewLevel = usePrStore((s) => s.setReviewLevel);

  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<ClaudeErrorInfo | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [postSummary, setPostSummary] = useState(true);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => (text ? parseAnalysis(text) : null), [text]);
  const findings = parsed?.findings ?? [];
  const summary = parsed?.summary ?? "";

  // Every finding is selected by default whenever a new result lands, matching the panel review.
  useEffect(() => {
    setSelectedIds(new Set(findings.map((f) => f.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const run = async () => {
    const id = newRunId("pr-link");
    setRunId(id);
    setRunning(true);
    setError(null);
    setCancelled(false);
    setText(null);
    setPosted(false);
    // Registering the run here (not just in the backend) is what wires up the live log's lines
    // and its stop button, exactly as `jobsStore.run` does for a project-backed review.
    useAiRunStore.getState().start(id);
    try {
      setText(await reviewPrFromLink(url, id, reviewLevel, workspaceId));
    } catch (e) {
      if (isCancellation(e)) setCancelled(true);
      else setError(parseClaudeError(String(e)));
    } finally {
      useAiRunStore.getState().finish(id);
      setRunning(false);
    }
  };

  // Reaching this panel is already the "review it" click, so it starts on its own. Guarded
  // against React's double-invoked effects in dev, which would otherwise fire two runs.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const publish = async () => {
    if (!parsed) return;
    const chosen = findings.filter((f) => selectedIds.has(f.id));
    if (chosen.length === 0 && !postSummary) return;
    const confirmKey = pr.provider === "github" ? "chat.confirmPostGithub" : "chat.confirmPost";
    if (!(await confirmAction(t(confirmKey, { id: pr.id, n: chosen.length }), false))) return;
    setPosting(true);
    try {
      await postPrLinkReviewComment(
        url,
        chosen.map((f) => ({
          file: f.location?.file ?? null,
          category: f.category,
          content: formatFindingAsComment(f),
          location: f.location,
        })),
        postSummary,
        // `chosen`, not every finding: the summary describes what actually gets posted.
        postSummary ? formatSummaryComment(parsed, new Date().toISOString().slice(0, 10), chosen) : null,
      );
      setPosted(true);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setPosting(false);
    }
  };

  const copyFixpack = () => {
    if (!parsed) return;
    void navigator.clipboard.writeText(buildFixpack(parsed, pr.id));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const publishLabel = posted
    ? pr.provider === "github"
      ? t("chat.postedGithub")
      : t("chat.posted")
    : posting
      ? t("chat.posting")
      : t("chat.postToPr");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        <p className="rounded-lg border border-dashed border-[var(--cf-border)] px-2.5 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
          {t("prLink.quickNote")}
        </p>

        {running && (
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-3 text-[12px] text-[var(--cf-text-muted)]">
              <ThinkingOrb size="sm" />
              {t("ai.working")}
            </div>
            {runId && (
              <AiRunLog runId={runId} running expanded={logExpanded} onToggle={() => setLogExpanded((v) => !v)} />
            )}
          </div>
        )}

        {cancelled && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--cf-border)] p-3 text-[12px] text-[var(--cf-text-muted)]">
            <Square size={11} className="fill-current" />
            {t("ai.runStopped")}
          </div>
        )}

        {!running && error && <AiErrorBanner error={error} compact />}

        {!running && parsed && (
          <>
            <QualityGateBadges grades={parsed.grades} findings={findings} />
            {summary &&
              (findings.length > 0 || summary.length > SHORT_SUMMARY_MAX ? (
                <div
                  className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3.5 py-2.5"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
                />
              ) : (
                <p className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 text-[12px] leading-relaxed">
                  {summary}
                </p>
              ))}

            {findings.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2 border-t border-[var(--cf-border)] pt-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                    <Sparkles size={11} className="text-[var(--cf-accent)]" />
                    {t("pr.findingsHeader", { n: findings.length })}
                  </p>
                  <SeverityCountBadges findings={findings} />
                </div>
                <div className="space-y-2">
                  {findings.map((finding) => (
                    <div key={finding.id} className="flex items-start gap-2">
                      <span className="mt-2 shrink-0" title={t("pr.selectToPost")}>
                        <Checkbox checked={selectedIds.has(finding.id)} onChange={() => toggleSelected(finding.id)} />
                      </span>
                      <div className="min-w-0 flex-1">
                        {/* No `projectId`: there is no working copy, so the "apply this fix"
                            affordance would have nowhere to land. */}
                        <FindingCard finding={finding} defaultOpen={false} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-3 shrink-0 space-y-2 border-t border-[var(--cf-border)] pt-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <ReviewLevelSelector value={reviewLevel} onChange={setReviewLevel} disabled={running} />
          {parsed && findings.length > 0 && !running && (
            <>
              <button
                onClick={copyFixpack}
                title={t("pr.fixpackHint")}
                className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {t("pr.fixpack")}
              </button>
              <label
                className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]"
                title={t("pr.postSummaryHint")}
              >
                <Checkbox checked={postSummary} onChange={setPostSummary} />
                {t("pr.postSummary")}
              </label>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {parsed && !running && (
            <button
              onClick={publish}
              disabled={posting || posted}
              title={publishLabel}
              className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] font-medium hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
            >
              {posting ? (
                <Loader2 size={12} className="shrink-0 animate-spin" />
              ) : posted ? (
                <Check size={12} className="shrink-0 text-[var(--cf-success)]" />
              ) : null}
              <span className="truncate">{publishLabel}</span>
            </button>
          )}
          <button
            onClick={() => void run()}
            disabled={running}
            className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {running ? (
              <Loader2 size={12} className="shrink-0 animate-spin" />
            ) : (
              <Sparkles size={12} className="shrink-0" />
            )}
            <span className="truncate">{running ? t("chat.reviewing") : t("pr.reviewAgain")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
