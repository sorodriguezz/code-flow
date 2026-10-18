import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, ExternalLink, EyeOff, FileCode2, Loader2, RotateCcw, ShieldCheck, ThumbsUp } from "lucide-react";
import { AiWand } from "../common/AiGlyph";
import { Markdown } from "../common/Markdown";
import { Tooltip } from "../common/Tooltip";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { useT, useLanguageStore, type Translate } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useReviewerStore } from "../../state/reviewerStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { askInRepoChat } from "../../lib/aiPanelNav";
import { renderMarkdown } from "../../lib/markdown";
import { exportFileStem, notesToHtml, renderNotesPdf } from "../../lib/notes/exportNotes";
import { openExternalUrl, writeFileBytes } from "../../lib/tauri/commands";
import {
  reviewerChangedLines,
  reviewerHotspotReview,
  reviewerIssueDecide,
  reviewerRule,
  type ReviewerChangedLines,
  type ReviewerHotspot,
  type ReviewerIssue,
  type ReviewerIssueVerdict,
  type ReviewerRuleInfo,
  type ReviewerRunSummary,
} from "../../lib/tauri/reviewerCommands";
import { reportTitle, reviewReportMarkdown } from "./reviewerReport";

// ------------------------------------------------------------------------------------------- rules

const SECTION_LABEL: Record<string, "reviewer.rule.why" | "reviewer.rule.fix" | "reviewer.rule.resources" | "reviewer.rule.assess" | null> = {
  introduction: null,
  description: null,
  root_cause: "reviewer.rule.why",
  assess_the_problem: "reviewer.rule.assess",
  how_to_fix: "reviewer.rule.fix",
  resources: "reviewer.rule.resources",
};

/** Rules explained this session — the same rule behind fifty issues is asked for once. */
const RULE_CACHE = new Map<string, ReviewerRuleInfo>();

/** The rule behind a finding, in SonarQube's own words: why it matters and how to fix it. */
export function RuleExplanation({ ruleKey }: { ruleKey: string }) {
  const t = useT();
  const [rule, setRule] = useState<ReviewerRuleInfo | null>(RULE_CACHE.get(ruleKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (RULE_CACHE.has(ruleKey)) {
      setRule(RULE_CACHE.get(ruleKey) ?? null);
      return;
    }
    let live = true;
    setRule(null);
    setError(null);
    reviewerRule(ruleKey)
      .then((found) => {
        RULE_CACHE.set(ruleKey, found);
        if (live) setRule(found);
      })
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [ruleKey]);
  if (error) return <p className="text-[12px] text-[var(--cf-danger)]">{error}</p>;
  if (!rule) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
        <Loader2 size={12} className="animate-spin" />
        {t("reviewer.rule.loading")}
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <p className="text-[12.5px] font-semibold text-[var(--cf-text)]">
        {rule.name} <span className="font-mono text-[11px] font-normal text-[var(--cf-text-muted)]">{rule.key}</span>
      </p>
      {rule.sections.map((section) => {
        const label = SECTION_LABEL[section.key];
        return (
          <div key={section.key} className="mt-2">
            {label && <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-faint)]">{t(label)}</p>}
            <Markdown source={section.html} className="cf-markdown-preview select-text text-[12.5px]" />
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ issues

/** What can be done about one issue, under it when it is opened: read the rule, mark it, fix it. */
export function IssueDetail({ issue, projectId, projectKey }: { issue: ReviewerIssue; projectId: string; projectKey: string }) {
  const t = useT();
  const [busy, setBusy] = useState<ReviewerIssueVerdict | null>(null);
  const decide = async (verdict: ReviewerIssueVerdict) => {
    setBusy(verdict);
    try {
      await reviewerIssueDecide(projectKey, issue.key, verdict, "");
      useReviewerStore.getState().patchSummary(projectId, (summary) => ({
        ...summary,
        issues: summary.issues.filter((i) => i.key !== issue.key),
        issuesTotal: Math.max(0, summary.issuesTotal - 1),
      }));
      pushSuccessToast(t(verdict === "falsePositive" ? "reviewer.markedFalsePositive" : "reviewer.markedAccepted"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };
  const fix = () => {
    const where = `${issue.path}${issue.line ? `:${issue.line}` : ""}`;
    askInRepoChat(projectId, t("reviewer.fixPrompt", { where, rule: issue.rule, message: issue.message }), { send: true });
  };
  return (
    <div className="border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))] px-3 py-2.5 pl-9">
      <RuleExplanation ruleKey={issue.rule} />
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Tooltip label={t("reviewer.fixWithAiHint")}>
          <button type="button" onClick={fix} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <AiWand size={12} />
            {t("reviewer.fixWithAi")}
          </button>
        </Tooltip>
        <Tooltip label={t("reviewer.falsePositiveHint")}>
          <button type="button" disabled={busy !== null} onClick={() => void decide("falsePositive")} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {busy === "falsePositive" ? <Loader2 size={12} className="animate-spin" /> : <EyeOff size={12} />}
            {t("reviewer.falsePositive")}
          </button>
        </Tooltip>
        <Tooltip label={t("reviewer.acceptHint")}>
          <button type="button" disabled={busy !== null} onClick={() => void decide("accepted")} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {busy === "accepted" ? <Loader2 size={12} className="animate-spin" /> : <ThumbsUp size={12} />}
            {t("reviewer.accept")}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------- new code

/** Whether a finding sits on code changed against the base: a new file, or a line in a changed run. */
export function onNewCode(changed: ReviewerChangedLines, path: string, line: number | null): boolean {
  if (changed.added.includes(path)) return true;
  const runs = changed.files[path];
  if (!runs) return false;
  // A finding on the whole file (no line) counts when the file changed at all.
  if (line == null) return true;
  return runs.some(([first, last]) => line >= first && line <= last);
}

/** The changed lines against `base` while `enabled`, re-read when the report changes. */
export function useChangedLines(repoPath: string, enabled: boolean, base: string, runId: string | undefined) {
  const [state, setState] = useState<{ key: string; changed: ReviewerChangedLines | null; error: string | null } | null>(null);
  const key = `${repoPath}\n${base}\n${runId ?? ""}`;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    reviewerChangedLines(repoPath, base)
      .then((changed) => live && setState({ key, changed, error: null }))
      .catch((e: unknown) => live && setState({ key, changed: null, error: String(e) }));
    return () => {
      live = false;
    };
  }, [enabled, key, repoPath, base]);
  return enabled && state?.key === key ? state : null;
}

// ---------------------------------------------------------------------------------------- hotspots

const PROBABILITY_TONE: Record<string, Parameters<typeof chipClass>[0]> = { HIGH: "bad", MEDIUM: "warn", LOW: "neutral" };

/**
 * The security hotspots: code that touches something sensitive — a query built from input, a
 * cookie, a weak hash — that a person has to look at and call safe, fixed or acknowledged. Not
 * issues: SonarQube cannot tell whether they are vulnerabilities, which is why they are reviewed.
 */
export function HotspotsPanel({ summary, projectId, serverUrl }: { summary: ReviewerRunSummary | null; projectId: string; serverUrl: string | null }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const hotspots = summary?.hotspots ?? [];
  const toReview = hotspots.filter((h) => h.status === "TO_REVIEW");
  const shown = showReviewed ? hotspots : toReview;
  if (!summary) return null;
  if (!summary.hotspots) return <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("reviewer.hotspotsOldReport")}</p>;

  const review = async (hotspot: ReviewerHotspot, resolution: string | null) => {
    setBusy(hotspot.key);
    try {
      await reviewerHotspotReview(summary.projectKey, hotspot.key, resolution, "");
      useReviewerStore.getState().patchSummary(projectId, (current) => ({
        ...current,
        hotspots: (current.hotspots ?? []).map((h) =>
          h.key === hotspot.key ? { ...h, status: resolution ? "REVIEWED" : "TO_REVIEW", resolution: resolution as ReviewerHotspot["resolution"] } : h,
        ),
      }));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2 text-[11px] text-[var(--cf-text-muted)]">
        <span className="min-w-0 flex-1">{t("reviewer.hotspotsSummary", { toReview: toReview.length, total: hotspots.length })}</span>
        {hotspots.length > toReview.length && (
          <button type="button" onClick={() => setShowReviewed((v) => !v)} className="text-[var(--cf-accent)] hover:underline">
            {showReviewed ? t("reviewer.hotspotsHideReviewed") : t("reviewer.hotspotsShowReviewed")}
          </button>
        )}
      </div>
      {shown.length === 0 && <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("reviewer.hotspotsNone")}</p>}
      {shown.map((hotspot) => (
        <div key={hotspot.key}>
          <div className="group flex min-w-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-3 py-1.5 hover:bg-[var(--cf-hover)]">
            {hotspot.status === "TO_REVIEW" ? (
              <span className={chipClass(PROBABILITY_TONE[hotspot.probability] ?? "neutral", "w-[4.5rem] justify-center")}>{t(`reviewer.probability.${hotspot.probability === "HIGH" ? "high" : hotspot.probability === "MEDIUM" ? "medium" : "low"}`)}</span>
            ) : (
              <span className={chipClass("ok", "w-[4.5rem] justify-center")}>{hotspotResolution(t, hotspot.resolution)}</span>
            )}
            <button type="button" onClick={() => setOpen(open === hotspot.key ? null : hotspot.key)} className="flex min-w-0 flex-1 flex-col text-left">
              <span className="truncate text-[13px] text-[var(--cf-text)]">{hotspot.message}</span>
              <span className="truncate text-[11px] text-[var(--cf-text-muted)]">
                <span className="font-mono">
                  {hotspot.path}
                  {hotspot.line ? `:${hotspot.line}` : ""}
                </span>
                {" · "}
                {hotspot.category} · {hotspot.rule}
              </span>
            </button>
            {serverUrl && (
              <Tooltip label={t("reviewer.openInSonar")}>
                <button
                  type="button"
                  onClick={() =>
                    void openExternalUrl(`${serverUrl}/security_hotspots?id=${encodeURIComponent(summary.projectKey)}&hotspots=${encodeURIComponent(hotspot.key)}`).catch(
                      (e: unknown) => pushErrorToast(String(e)),
                    )
                  }
                  className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] opacity-0 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] group-hover:opacity-100"
                  aria-label={t("reviewer.openInSonar")}
                >
                  <ExternalLink size={12} />
                </button>
              </Tooltip>
            )}
            <button
              type="button"
              onClick={() => useUiStore.getState().openInEditor(hotspot.path, hotspot.line ?? undefined)}
              className={buttonClass({ variant: "ghost", size: "sm" })}
            >
              <FileCode2 size={12} />
              {t("reviewer.openFile")}
            </button>
          </div>
          {open === hotspot.key && (
            <div className="border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))] px-3 py-2.5 pl-9">
              <RuleExplanation ruleKey={hotspot.rule} />
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {hotspot.status === "TO_REVIEW" ? (
                  <>
                    {(["SAFE", "FIXED", "ACKNOWLEDGED"] as const).map((resolution) => (
                      <Tooltip key={resolution} label={t(`reviewer.hotspot${resolution === "SAFE" ? "Safe" : resolution === "FIXED" ? "Fixed" : "Acknowledged"}Hint`)}>
                        <button
                          type="button"
                          disabled={busy === hotspot.key}
                          onClick={() => void review(hotspot, resolution)}
                          className={buttonClass({ variant: resolution === "SAFE" ? "secondary" : "ghost", size: "sm" })}
                        >
                          {resolution === "SAFE" ? <ShieldCheck size={12} /> : <CheckCircle2 size={12} />}
                          {hotspotResolution(t, resolution)}
                        </button>
                      </Tooltip>
                    ))}
                  </>
                ) : (
                  <button type="button" disabled={busy === hotspot.key} onClick={() => void review(hotspot, null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                    <RotateCcw size={12} />
                    {t("reviewer.hotspotReopen")}
                  </button>
                )}
                {busy === hotspot.key && <Loader2 size={12} className="animate-spin text-[var(--cf-text-muted)]" />}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function hotspotResolution(t: Translate, resolution: string | null): string {
  if (resolution === "SAFE") return t("reviewer.hotspotSafe");
  if (resolution === "FIXED") return t("reviewer.hotspotFixed");
  if (resolution === "ACKNOWLEDGED") return t("reviewer.hotspotAcknowledged");
  return t("reviewer.hotspotToReview");
}

// ------------------------------------------------------------------------------------------ export

/** The report as an HTML page or a PDF, where the user says. */
export async function exportReviewReport(t: Translate, summary: ReviewerRunSummary, projectName: string, format: "html" | "pdf"): Promise<void> {
  const title = reportTitle(t, projectName);
  const path = await save({
    defaultPath: `${exportFileStem(title, "report")}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  }).catch(() => null);
  if (!path) return;
  try {
    const note = { id: summary.runId, title, content: reviewReportMarkdown(t, summary) };
    const bytes =
      format === "html"
        ? new TextEncoder().encode(notesToHtml([note], { title, lang: useLanguageStore.getState().language, untitled: title, render: renderMarkdown }))
        : await renderNotesPdf([note], { title, untitled: title });
    await writeFileBytes(path, bytes);
    pushSuccessToast(t("reviewer.report.exported"));
  } catch (e) {
    pushErrorToast(String(e));
  }
}

/** The hotspots still to review — what the tab's count shows. */
export function useHotspotsToReview(summary: ReviewerRunSummary | null): number {
  return useMemo(() => (summary?.hotspots ?? []).filter((h) => h.status === "TO_REVIEW").length, [summary]);
}
