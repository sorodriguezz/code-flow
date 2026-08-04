import { useMemo, useState, type ReactNode } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Info,
  Loader2,
  MapPin,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import {
  computeQualityGatePassed,
  formatFindingAsFixPrompt,
  locationLabel,
  type AnalysisFinding,
  type QualityGrades,
} from "../../lib/parseAnalysis";
import { renderInlineMarkdown } from "../../lib/markdown";
import { resolveFindingWithAi } from "../../lib/tauri/commands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { AiRunLog } from "./AiRunLog";
import { Checkbox } from "../common/Checkbox";
import { useRepoStore } from "../../state/repoStore";
import { useResolutionsStore, resolutionRunKey, type RunningResolution } from "../../state/resolutionsStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { notify } from "../../state/notificationStore";
import { useT } from "../../state/languageStore";
import { useTaskProvider } from "../../state/aiProviderStore";
import { isAgenticProvider } from "../../lib/aiProviders";

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
  /** What the fix was for, as one line for the notification centre. A fix writes to the working
   * tree and can take minutes, so it is exactly the kind of run the user walks away from — and
   * "Fix proposed" with no subject is useless once two of them are in the list. */
  label?: string,
) {
  const t = useT();
  const [localResolution, setLocalResolution] = useState<string | null>(null);
  const persisted = useResolutionsStore((s) =>
    projectId && resolutionKey ? s.byProject[projectId]?.[resolutionKey]?.text ?? null : null,
  );
  const resolution = resolutionKey ? persisted : localResolution;

  // A keyed fix tracks its run in the store, so unmounting the card (leaving the PR, switching
  // repos, closing the panel) doesn't lose the fact that it's still applying — the card picks the
  // run back up when it returns. Without a key there's no identity to find it by, so it falls back
  // to local state, exactly as the result does.
  const runKey = projectId && resolutionKey ? resolutionRunKey(projectId, resolutionKey) : null;
  const sharedRun = useResolutionsStore((s) => (runKey ? s.running[runKey] ?? null : null));
  const [localRun, setLocalRun] = useState<RunningResolution | null>(null);
  const activeRun = runKey ? sharedRun : localRun;
  const resolving = activeRun !== null;
  const runId = activeRun?.runId ?? null;
  const runStartedAt = activeRun?.startedAt ?? null;

  const markRunning = (run: RunningResolution | null) => {
    if (!runKey) return setLocalRun(run);
    if (run) useResolutionsStore.getState().startRun(runKey, run);
    else useResolutionsStore.getState().finishRun(runKey);
  };

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
          // Already confirmed just above, in terms of the finding being fixed — don't ask the
          // generic branch question on top of it.
          else await checkoutRemoteBranch(`origin/${prSourceBranch}`, true);
        } catch (e) {
          pushErrorToast(t("finding.branchSwitchFailed", { error: String(e) }));
          return;
        }
      }
    }

    if (!projectId) return;
    // A fix writes to the working tree, so it's the run that most needs to be watchable and
    // stoppable — the id ties both to this particular fix.
    const id = newRunId("fix");
    useAiRunStore.getState().start(id);
    markRunning({ runId: id, startedAt: Date.now() });
    try {
      const result = await resolveFindingWithAi(projectId, promptText, id);
      record(result);
      notify({ source: "review", titleKey: "notifications.fixDone", status: "success", detail: label });
    } catch (e) {
      // Stopping is a decision, not a failure — no error toast for it.
      if (!isCancellation(e)) {
        pushErrorToast(String(e));
        notify({ source: "review", titleKey: "notifications.fixFailed", status: "error", detail: label });
      }
    } finally {
      useAiRunStore.getState().finish(id);
      markRunning(null);
    }
  };

  return { resolving, resolution, resolve, clearResolution, runId, runStartedAt };
}

/** The button + result text for `useResolveWithAi` — identical markup in `FindingCard` and
 * `PrCommentCard`, just pulled out so the two don't drift. Once resolved the button flips to
 * "resolve again" and the outcome is shown in a persistent, dismissable "resolved" card. */
export function ResolveWithAiButton({
  resolving,
  resolution,
  runId,
  runStartedAt,
  onClick,
  onClear,
  trailing,
  showAi = true,
}: {
  resolving: boolean;
  resolution: string | null;
  /** The in-flight (or last) run, so the live log and its stop button can be shown here. */
  runId?: string | null;
  /** When that run began — the card can be reopened long after, and the timer has to say so. */
  runStartedAt?: number | null;
  onClick: () => void;
  onClear?: () => void;
  /** An extra action sharing this row — a PR comment's "resolve the thread on the host", which
   * belongs beside the fix that earned it rather than on a line of its own. */
  trailing?: ReactNode;
  /** False where there is no working copy to fix: `trailing` still renders, the AI half doesn't. */
  showAi?: boolean;
}) {
  const t = useT();
  const [logExpanded, setLogExpanded] = useState(false);
  // "Fix with AI" needs a write-capable agentic engine — hidden entirely for local models (Ollama)
  // so there's no dead button, unless there's already a resolution to show from an earlier run.
  // Keyed on the *fix* task's provider, which routing may point somewhere other than the default.
  const providerId = useTaskProvider("fix");
  const hideAi = !showAi || (!isAgenticProvider(providerId) && !resolution);
  if (hideAi && !trailing) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {!hideAi && (
          <button
            onClick={onClick}
            disabled={resolving}
            className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
          >
            {resolving ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
            {resolving ? t("finding.resolving") : resolution ? t("finding.resolveAgain") : t("finding.resolve")}
          </button>
        )}
        {trailing}
      </div>
      {resolving && runId && (
        <AiRunLog
          runId={runId}
          running
          startedAt={runStartedAt}
          expanded={logExpanded}
          onToggle={() => setLogExpanded((v) => !v)}
        />
      )}
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

/**
 * A human ruling on one finding, read back from the run's durable memory.
 *
 * The card renders findings parsed out of the review markdown, which knows nothing about what was
 * later decided about them — so the verdict travels alongside rather than inside the finding.
 */
export interface FindingMark {
  /** `abierto` · `posteado` · `resuelto` · `falso_positivo` · `ignorado`. */
  estado: string;
  motivo?: string | null;
  /** Whether the finding was published to the PR — only then is there a thread to close. */
  posted: boolean;
}

export function isDiscarded(mark?: FindingMark | null): boolean {
  return mark?.estado === "falso_positivo" || mark?.estado === "ignorado";
}

/** What a discard does beyond the local mark, chosen per finding rather than globally: promoting
 * the ruling to every future review of the repository, and saying so on the pull request. */
export interface DiscardOptions {
  motivo: string;
  scopeRepo: boolean;
  notifyHost: boolean;
}

/**
 * "This isn't a real defect" — the control that was previously only reachable from the settings
 * screen, put where the finding is actually read.
 *
 * The reason field is the part that earns its keep: it is what the next review is told (so the
 * model stops re-deriving the same rejected finding), what the pull request is told when the
 * thread is closed, and what makes a repository-wide rule reviewable months later. It stays
 * optional, because forcing prose is how you get "n/a".
 */
function DiscardControls({
  mark,
  onDiscard,
  busy,
}: {
  mark?: FindingMark | null;
  onDiscard: (estado: string, opts: DiscardOptions) => void;
  busy: boolean;
}) {
  const t = useT();
  // Which rejection is being composed, if any — `null` is the resting state (just the two buttons).
  const [drafting, setDrafting] = useState<"falso_positivo" | "ignorado" | null>(null);
  const [motivo, setMotivo] = useState("");
  const [scopeRepo, setScopeRepo] = useState(false);
  // Defaults to on when the finding is on the PR: a rejection the author never sees leaves them
  // looking at a comment nobody intends to act on.
  const [notifyHost, setNotifyHost] = useState(true);

  if (isDiscarded(mark)) {
    const falso = mark?.estado === "falso_positivo";
    return (
      <div className="rounded-md border border-[var(--cf-border)] bg-black/[0.02] px-2.5 py-1.5 dark:bg-white/[0.03]">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {falso ? <Ban size={11} /> : <EyeOff size={11} />}
          {t(falso ? "finding.discardedFalse" : "finding.discardedIgnored")}
        </span>
        {mark?.motivo && <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--cf-text)]">{mark.motivo}</p>}
        <button
          onClick={() => onDiscard("abierto", { motivo: "", scopeRepo: false, notifyHost: false })}
          disabled={busy}
          className="mt-1 flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline disabled:opacity-50"
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : <Undo2 size={10} />}
          {t("finding.undoDiscard")}
        </button>
      </div>
    );
  }

  if (drafting === null) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <DiscardButton icon={Ban} label={t("finding.markFalsePositive")} onClick={() => setDrafting("falso_positivo")} />
        <DiscardButton icon={EyeOff} label={t("finding.markIgnored")} onClick={() => setDrafting("ignorado")} />
      </div>
    );
  }

  const close = () => {
    setDrafting(null);
    setMotivo("");
    setScopeRepo(false);
    setNotifyHost(true);
  };

  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border)] bg-black/[0.02] px-2.5 py-2 dark:bg-white/[0.03]">
      <p className="text-[11px] font-medium text-[var(--cf-text)]">
        {t(drafting === "falso_positivo" ? "finding.markFalsePositive" : "finding.markIgnored")}
      </p>
      <textarea
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        rows={2}
        autoFocus
        placeholder={t("finding.discardReasonPlaceholder")}
        className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
      />
      {/* "Ignore" is a call about this pull request ("not now"), so it never becomes a standing
          rule about the code — only a false positive does. */}
      {drafting === "falso_positivo" && (
        <label className="flex items-start gap-1.5 text-[11px] text-[var(--cf-text-muted)]" title={t("finding.discardScopeRepoHint")}>
          <span className="mt-0.5">
            <Checkbox checked={scopeRepo} onChange={setScopeRepo} />
          </span>
          {t("finding.discardScopeRepo")}
        </label>
      )}
      {mark?.posted && (
        <label className="flex items-start gap-1.5 text-[11px] text-[var(--cf-text-muted)]" title={t("finding.discardNotifyHostHint")}>
          <span className="mt-0.5">
            <Checkbox checked={notifyHost} onChange={setNotifyHost} />
          </span>
          {t("finding.discardNotifyHost")}
        </label>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            onDiscard(drafting, { motivo: motivo.trim(), scopeRepo, notifyHost });
            close();
          }}
          disabled={busy}
          className="rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t("finding.discardConfirm")}
        </button>
        <button onClick={close} className="text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function DiscardButton({ icon: Icon, label, onClick }: { icon: typeof Ban; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
    >
      <Icon size={11} />
      {label}
    </button>
  );
}

/** Header pill for a finding a human has ruled out — the collapsed counterpart of the reason shown
 * inside the card, so a scan down the list shows what is still standing. */
export function DiscardedChip({ estado }: { estado: string }) {
  const t = useT();
  const falso = estado === "falso_positivo";
  return (
    <span
      title={t(falso ? "finding.discardedFalse" : "finding.discardedIgnored")}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--cf-text-muted)] dark:bg-white/[0.09]"
    >
      {falso ? <Ban size={10} /> : <EyeOff size={10} />}
    </span>
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
  mark,
  onDiscard,
  discarding = false,
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
  /** The human ruling already on record for this finding, from the run's memory. */
  mark?: FindingMark | null;
  /** Omit where there is nothing to record a ruling in — a pre-commit analysis, or a PR reviewed
   * from a link with no project to keep memory for. The controls are then not offered at all,
   * rather than offered and silently doing nothing. */
  onDiscard?: (estado: string, opts: DiscardOptions) => void;
  discarding?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const { icon: Icon, color } = SEVERITY_STYLE[finding.severity];
  const { resolving, resolution, resolve, clearResolution, runId, runStartedAt } = useResolveWithAi(
    projectId,
    prSourceBranch,
    resolutionKey,
    finding.subtitle,
  );
  const discarded = isDiscarded(mark);

  return (
    // Dimmed rather than hidden: a rejected finding is still part of what the review said, and
    // hiding it would make the ruling impossible to revisit from the list it was made in.
    <div className={`overflow-hidden rounded-lg border border-[var(--cf-border)] ${discarded ? "opacity-55" : ""}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
        style={{ borderLeft: `3px solid ${discarded ? "var(--cf-border)" : color}` }}
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
        {discarded && <DiscardedChip estado={mark?.estado ?? ""} />}
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

          {/* Fixing it and rejecting it are the two answers to a finding, so they sit together —
              except once rejected, where offering to fix what was just called a non-defect would
              be the panel arguing with itself. */}
          {projectId && !discarded && (
            <ResolveWithAiButton
              resolving={resolving}
              resolution={resolution}
              runId={runId}
              runStartedAt={runStartedAt}
              onClick={() => void resolve(formatFindingAsFixPrompt(finding))}
              onClear={clearResolution}
            />
          )}
          {onDiscard && <DiscardControls mark={mark} onDiscard={onDiscard} busy={discarding} />}
        </div>
      )}
    </div>
  );
}
