import { useMemo, useState } from "react";
import { AlertOctagon, AlertTriangle, ChevronDown, ChevronRight, Info, Loader2, MapPin, Wand2 } from "lucide-react";
import {
  computeQualityGatePassed,
  formatFindingAsFixPrompt,
  locationLabel,
  type AnalysisFinding,
  type QualityGrades,
} from "../../lib/parseAnalysis";
import { renderInlineMarkdown } from "../../lib/markdown";
import { resolveFindingWithAi } from "../../lib/tauri/commands";
import { useRepoStore } from "../../state/repoStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

// Above this length a summary with no parsed findings is treated as an unparsed raw
// response (the model didn't follow the expected "### finding" format) rather than a short
// "looks fine ✅" reply, so it renders as a full markdown document instead of a centered
// one-liner. Shared by the pre-commit analysis view and the PR review view — both parse the
// same "### finding" format.
export const SHORT_SUMMARY_MAX = 160;

export const SEVERITY_STYLE: Record<AnalysisFinding["severity"], { icon: typeof AlertOctagon; color: string }> = {
  critical: { icon: AlertOctagon, color: "var(--cf-danger)" },
  warning: { icon: AlertTriangle, color: "var(--cf-warning)" },
  info: { icon: Info, color: "var(--cf-accent)" },
};

/** Inline markdown (bold, `code`, links) inside a single short field — the finding's own
 * fields are one line each, not a full document, so this renders without `marked` wrapping
 * the result in a block-level `<p>`. */
export function InlineMarkdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderInlineMarkdown(text), [text]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Shared by `FindingCard` and `PrCommentCard` — applies a fix via Claude for whatever
 * instruction text `resolve()` is given. For a PR finding/comment (`prSourceBranch` set),
 * makes sure the local checkout is actually on the PR's branch first: blocks with an error if
 * there are uncommitted changes (switching branches would risk them), otherwise confirms and
 * checks out that branch (local if it already exists, remote-tracking otherwise) before
 * asking Claude to apply the fix. */
export function useResolveWithAi(projectId: string | undefined, prSourceBranch: string | undefined) {
  const t = useT();
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState<string | null>(null);

  const resolve = async (promptText: string) => {
    if (prSourceBranch) {
      const { status, branches, checkoutBranch, checkoutRemoteBranch } = useRepoStore.getState();
      if (status?.current_branch !== prSourceBranch) {
        const dirty =
          !!status &&
          (status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0 || status.conflicted.length > 0);
        if (dirty) {
          pushErrorToast(t("finding.dirtyBranchSwitch"));
          return;
        }
        if (!(await confirmAction(t("finding.confirmBranchSwitch", { branch: prSourceBranch }), false))) return;
        try {
          const hasLocal = branches.some((b) => b.name === prSourceBranch && !b.is_remote);
          if (hasLocal) await checkoutBranch(prSourceBranch);
          else await checkoutRemoteBranch(`origin/${prSourceBranch}`);
        } catch (e) {
          pushErrorToast(t("finding.branchSwitchFailed", { error: String(e) }));
          return;
        }
      }
    }

    if (!projectId) return;
    setResolving(true);
    setResolution(null);
    try {
      const result = await resolveFindingWithAi(projectId, promptText);
      setResolution(result);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setResolving(false);
    }
  };

  return { resolving, resolution, resolve };
}

/** The button + result text for `useResolveWithAi` — identical markup in `FindingCard` and
 * `PrCommentCard`, just pulled out so the two don't drift. */
export function ResolveWithAiButton({
  resolving,
  resolution,
  onClick,
}: {
  resolving: boolean;
  resolution: string | null;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onClick}
          disabled={resolving}
          className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
        >
          {resolving ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
          {resolving ? t("finding.resolving") : t("finding.resolve")}
        </button>
      </div>
      {resolution && <p className="rounded-md bg-[var(--cf-accent-soft)] px-2.5 py-1.5 text-[var(--cf-text)]">{resolution}</p>}
    </>
  );
}

/** Quality Gate pill + the model's own A–E grades — shown once per review, above the
 * findings list, in both the pre-commit analysis view and the PR review view. */
export function QualityGateBadges({ grades, findings }: { grades: QualityGrades | null; findings: AnalysisFinding[] }) {
  const t = useT();
  const passed = computeQualityGatePassed(findings);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span
        className="rounded-full px-1.5 py-0.5 font-medium"
        style={{
          background: `color-mix(in oklab, ${passed ? "var(--cf-success)" : "var(--cf-danger)"} 16%, transparent)`,
          color: passed ? "var(--cf-success)" : "var(--cf-danger)",
        }}
      >
        {passed ? "✅" : "❌"} {t(passed ? "analyze.qualityGatePassed" : "analyze.qualityGateFailed")}
      </span>
      {grades && (
        <span className="text-[var(--cf-text-muted)]">
          {t("analyze.reliability")} <strong className="text-[var(--cf-text)]">{grades.reliability}</strong> ·{" "}
          {t("analyze.security")} <strong className="text-[var(--cf-text)]">{grades.security}</strong> ·{" "}
          {t("analyze.maintainability")} <strong className="text-[var(--cf-text)]">{grades.maintainability}</strong>
        </span>
      )}
    </div>
  );
}

export function FindingCard({
  finding,
  defaultOpen,
  projectId,
  prSourceBranch,
}: {
  finding: AnalysisFinding;
  defaultOpen: boolean;
  /** Omit for a pre-commit finding (there's no PR/branch involved, no fix button shown
   * without a project to apply it to). */
  projectId?: string;
  /** Only set for a PR-review finding — the PR's source branch, so the fix flow can offer to
   * switch to it first if the local checkout doesn't already match. */
  prSourceBranch?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const { icon: Icon, color } = SEVERITY_STYLE[finding.severity];
  const { resolving, resolution, resolve } = useResolveWithAi(projectId, prSourceBranch);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
        style={{ borderLeft: `3px solid ${color}` }}
      >
        <Icon size={14} className="mt-0.5 shrink-0" style={{ color }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <span className="font-semibold uppercase tracking-wide" style={{ color }}>
              {finding.type}
            </span>
            <span>·</span>
            <span>{finding.category}</span>
            <span>·</span>
            <span className="font-mono">{finding.id}</span>
          </div>
          <p className="mt-0.5 text-[13px] font-medium text-[var(--cf-text)]">
            <InlineMarkdown text={finding.subtitle} className="cf-markdown-inline" />
          </p>
          {finding.location && (
            <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
              <MapPin size={10} className="shrink-0" />
              {locationLabel(finding.location)}
            </p>
          )}
        </div>
        {finding.confidence !== null && (
          <span
            className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
          >
            {finding.confidence}%
          </span>
        )}
        {open ? (
          <ChevronDown size={13} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={13} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--cf-border)] px-3 py-2.5 text-[12px]">
          {finding.why && (
            <p>
              <span className="font-medium text-[var(--cf-text)]">💭 {t("analyze.why")}: </span>
              <InlineMarkdown text={finding.why} className="cf-markdown-inline text-[var(--cf-text-muted)]" />
            </p>
          )}
          {finding.suggestion && (
            <p>
              <span className="font-medium text-[var(--cf-text)]">💡 {t("analyze.suggestion")}: </span>
              <InlineMarkdown text={finding.suggestion} className="cf-markdown-inline text-[var(--cf-text-muted)]" />
            </p>
          )}
          {finding.exampleCode && (
            <pre className="overflow-x-auto rounded-md bg-black/[0.04] p-2 font-mono text-[11px] leading-relaxed dark:bg-white/[0.06]">
              {finding.exampleCode}
            </pre>
          )}

          {projectId && (
            <ResolveWithAiButton
              resolving={resolving}
              resolution={resolution}
              onClick={() => void resolve(formatFindingAsFixPrompt(finding))}
            />
          )}
        </div>
      )}
    </div>
  );
}
