import { useMemo, useState } from "react";
import { AlertOctagon, AlertTriangle, Check, ChevronDown, ChevronRight, Info, Loader2, MapPin, Wand2, X } from "lucide-react";
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
import { useResolutionsStore } from "../../state/resolutionsStore";
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
 * asking Claude to apply the fix.
 *
 * When `resolutionKey` is given the outcome is remembered in the persistent
 * [`useResolutionsStore`] keyed by it, so it survives unmounting the card (switching repos,
 * reopening the PR, restarting). Without a key it falls back to ephemeral local state. */
export function useResolveWithAi(
  projectId: string | undefined,
  prSourceBranch: string | undefined,
  resolutionKey?: string,
) {
  const t = useT();
  const [resolving, setResolving] = useState(false);
  const [localResolution, setLocalResolution] = useState<string | null>(null);
  const persisted = useResolutionsStore((s) =>
    projectId && resolutionKey ? s.byProject[projectId]?.[resolutionKey]?.text ?? null : null,
  );
  const resolution = resolutionKey ? persisted : localResolution;

  const record = (text: string) => {
    if (projectId && resolutionKey) useResolutionsStore.getState().save(projectId, resolutionKey, text);
    else setLocalResolution(text);
  };
  const clearResolution = () => {
    if (projectId && resolutionKey) useResolutionsStore.getState().clear(projectId, resolutionKey);
    else setLocalResolution(null);
  };

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
    try {
      const result = await resolveFindingWithAi(projectId, promptText);
      record(result);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setResolving(false);
    }
  };

  return { resolving, resolution, resolve, clearResolution };
}

/** The button + result text for `useResolveWithAi` — identical markup in `FindingCard` and
 * `PrCommentCard`, just pulled out so the two don't drift. Once resolved the button flips to
 * "resolve again" and the outcome is shown in a persistent, dismissable "resolved" card. */
export function ResolveWithAiButton({
  resolving,
  resolution,
  onClick,
  onClear,
}: {
  resolving: boolean;
  resolution: string | null;
  onClick: () => void;
  onClear?: () => void;
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
          {resolving ? t("finding.resolving") : resolution ? t("finding.resolveAgain") : t("finding.resolve")}
        </button>
      </div>
      {resolution && (
        <div className="relative rounded-md border border-[color-mix(in_oklab,var(--cf-success)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-success)_9%,transparent)] px-2.5 py-1.5 pr-6">
          <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-success)]">
            <Check size={11} />
            {t("finding.resolved")}
          </span>
          <p className="text-[12px] leading-relaxed text-[var(--cf-text)]">{resolution}</p>
          {onClear && (
            <button
              onClick={onClear}
              title={t("finding.dismissResolution")}
              className="absolute right-1.5 top-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={11} />
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Small green "resolved" pill shown in a collapsed finding/comment header so the user can see at
 * a glance which items have already been handled without expanding each one. */
export function ResolvedChip() {
  const t = useT();
  return (
    <span
      title={t("finding.resolved")}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--cf-success)]"
    >
      <Check size={10} />
    </span>
  );
}

/** Severity tally pills (`3 Critical · 2 Warning · …`) — a scannable summary of a findings list,
 * shown in the PR-review findings header and the pre-commit analysis header so the two read the
 * same. Renders nothing when there are no findings. */
export function SeverityCountBadges({ findings }: { findings: AnalysisFinding[] }) {
  const t = useT();
  const items = [
    { severity: "critical" as const, label: t("analyze.critical"), color: "var(--cf-danger)" },
    { severity: "warning" as const, label: t("analyze.warning"), color: "var(--cf-warning)" },
    { severity: "info" as const, label: t("analyze.info"), color: "var(--cf-accent)" },
  ]
    .map((i) => ({ ...i, n: findings.filter((f) => f.severity === i.severity).length }))
    .filter((i) => i.n > 0);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {items.map((i) => (
        <span
          key={i.severity}
          className="rounded-full px-1.5 py-0.5 font-medium"
          style={{ background: `color-mix(in oklab, ${i.color} 16%, transparent)`, color: i.color }}
        >
          {i.n} {i.label}
        </span>
      ))}
    </div>
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
  resolutionKey,
}: {
  finding: AnalysisFinding;
  defaultOpen: boolean;
  /** Omit for a pre-commit finding (there's no PR/branch involved, no fix button shown
   * without a project to apply it to). */
  projectId?: string;
  /** Only set for a PR-review finding — the PR's source branch, so the fix flow can offer to
   * switch to it first if the local checkout doesn't already match. */
  prSourceBranch?: string;
  /** Stable id under which this finding's "resolve with AI" outcome is persisted (see
   * [`useResolveWithAi`]). Omit to keep the outcome session-only. */
  resolutionKey?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const { icon: Icon, color } = SEVERITY_STYLE[finding.severity];
  const { resolving, resolution, resolve, clearResolution } = useResolveWithAi(projectId, prSourceBranch, resolutionKey);

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
        {resolution && <ResolvedChip />}
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
              onClear={clearResolution}
            />
          )}
        </div>
      )}
    </div>
  );
}
