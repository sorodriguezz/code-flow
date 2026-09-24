import { useMemo, useState, type ReactNode } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  EyeOff,
  Info,
  Lightbulb,
  Loader2,
  MapPin,
  MessageCircleQuestionMark,
  MessageSquarePlus,
  OctagonAlert,
  TriangleAlert,
  Undo2,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import { buttonClass, iconButtonClass } from "../common/Button";
import { chipClass, type ChipTone } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { textAreaClass } from "./docParts";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  computeQualityGatePassed,
  formatFindingAsFixPrompt,
  locationLabel,
  withExtraInstructions,
  type AnalysisFinding,
  type QualityGrades,
} from "../../lib/parseAnalysis";
import { renderInlineMarkdown } from "../../lib/markdown";
import { resolveFindingWithAi } from "../../lib/tauri/commands";
import { whenRepoFree, useIsQueued } from "../../lib/repoQueue";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useAiPanelStore } from "../../state/aiPanelStore";
import type { NotificationTarget } from "../../state/notificationStore";
import { AiRunLog } from "./AiRunLog";
import { Checkbox } from "../common/Checkbox";
import { useRepoStore } from "../../state/repoStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useResolutionsStore, resolutionRunKey, type RunningResolution } from "../../state/resolutionsStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { notify } from "../../state/notificationStore";
import { useT } from "../../state/languageStore";
import { useTaskProvider } from "../../state/aiProviderStore";
import { isAgenticProvider } from "../../lib/aiProviders";
import { riseDelay } from "../../lib/rise";

// Above this length a summary with no parsed findings is treated as an unparsed raw
// response (the model didn't follow the expected "### finding" format) rather than a short
// "looks fine ✅" reply, so it renders as a full markdown document instead of a centered
// one-liner. Shared by the pre-commit analysis view and the PR review view — both parse the
// same "### finding" format.
export const SHORT_SUMMARY_MAX = 160;

/**
 * Each severity as a shape, a word and a tone — never the tone alone.
 *
 * The shapes are the road-sign ones: an octagon stops you, a triangle warns, a circle informs. They
 * replace the 3px stripe down the card's left edge, which said severity with colour and nothing
 * else: indistinguishable in a monochrome theme, to a colour-blind reader, and — for `info`, which
 * wore the accent — next to a rose accent that reads as danger.
 */
export const SEVERITY_STYLE: Record<
  AnalysisFinding["severity"],
  { icon: LucideIcon; tone: ChipTone; labelKey: TranslationKey }
> = {
  critical: { icon: OctagonAlert, tone: "bad", labelKey: "analyze.critical" },
  warning: { icon: TriangleAlert, tone: "warn", labelKey: "analyze.warning" },
  info: { icon: Info, tone: "neutral", labelKey: "analyze.info" },
};

/** A severity as its chip: the shape, and the word — or, given `count`, how many of them. */
export function SeverityChip({ severity, count }: { severity: AnalysisFinding["severity"]; count?: number }) {
  const t = useT();
  const { icon: Icon, tone, labelKey } = SEVERITY_STYLE[severity];
  return (
    <span className={chipClass(tone)}>
      <Icon size={12} className="shrink-0" aria-hidden />
      {count === undefined ? <span className="capitalize">{t(labelKey)}</span> : `${count} ${t(labelKey)}`}
    </span>
  );
}

/** Inline markdown (bold, `code`, links) inside a single short field — the finding's own
 * fields are one line each, not a full document, so this renders without `marked` wrapping
 * the result in a block-level `<p>`. */
export function InlineMarkdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderInlineMarkdown(text), [text]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Where a fix's result is read: the finding it was for, inside the review or analysis it came from,
 * or — for a comment thread, which is no run of its own — the pull request.
 *
 * These notifications used to carry only the project, so following one opened the panel on
 * whatever it happened to be showing; the result was on a card nothing led back to.
 */
function fixTarget(projectId: string, resolutionKey: string | undefined): NotificationTarget {
  const job = resolutionKey?.match(/^job:(.+):([^:]+)$/);
  if (job) return { openAiPanel: true, projectId, select: { kind: "finding", id: `${job[1]}::${job[2]}` } };
  const thread = resolutionKey?.match(/^pr:(\d+):thread:/);
  if (thread) return { openAiPanel: true, projectId, select: { kind: "pullRequest", id: `${projectId}::${thread[1]}` } };
  return { openAiPanel: true, projectId };
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
  // Which workspace this fix belongs to, resolved from the repository it edits and read *while the
  // card is on screen* rather than when the run settles. A fix that lands after the user has walked
  // into another workspace still belongs to the one holding the checkout it wrote to, and that is
  // the workspace its row in the status bar has to name and its notification has to cross back
  // into. `null` only for a link review, which has no working copy and so never reaches `resolve`.
  const workspaceId = useWorkspaceStore((s) => (projectId ? s.workspaceOfProject(projectId) : null));
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
    // The same one line the finished notification is titled with — see `label`.
    //
    // This used to carry no target, on the grounds that the proposal lands on the finding in the
    // panel the user is already looking at. That holds for exactly as long as they keep looking at
    // it — and this is the run that writes to the working tree and takes minutes, so it is the one
    // they walk away from. Leaving the repository (or the workspace) unmounts the card with the
    // only stop button and the only way back on it. Stamped with the workspace it started in and
    // pointed at the project whose files it is editing, the status-bar row can say where it lives
    // and click back to it.
    const target = fixTarget(projectId, resolutionKey);
    useAiRunStore.getState().start(id, {
      kindKey: "agents.liveKindFix",
      detail: label ?? "",
      workspaceId,
      target,
    });
    markRunning({ runId: id, startedAt: Date.now() });
    try {
      // A fix writes to the working tree, so it takes the repository's lease like a chat turn or an
      // analysis does — and waits for it instead of failing when one of those holds it.
      const result = await whenRepoFree(projectId, id, () => resolveFindingWithAi(projectId, promptText, id));
      record(result);
      // The proposal is on the finding it belongs to; the notification leads there.
      notify({
        source: "review",
        titleKey: "notifications.fixDone",
        workspaceId,
        target,
        status: "success",
        detail: label,
      });
    } catch (e) {
      // Stopping is a decision, not a failure — no error toast for it.
      if (!isCancellation(e)) {
        pushErrorToast(String(e));
        notify({
          source: "review",
          titleKey: "notifications.fixFailed",
          workspaceId,
          target,
          status: "error",
          detail: label,
        });
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
 * "resolve again" and the outcome is shown in a persistent, dismissable "resolved" card.
 *
 * Beside it is the note field: anything typed there is handed to `onClick` and appended to the
 * generated prompt (see [`withExtraInstructions`]). Collapsed until asked for, because most fixes
 * need nothing said about them — but the run writes to the working tree and takes minutes, so the
 * cheapest possible moment to correct it is before it starts. */
export function ResolveWithAiButton({
  resolving,
  resolution,
  runId,
  runStartedAt,
  onClick,
  onClear,
  trailing,
  showAi = true,
  noteKey,
}: {
  resolving: boolean;
  resolution: string | null;
  /** The in-flight (or last) run, so the live log and its stop button can be shown here. */
  runId?: string | null;
  /** When that run began — the card can be reopened long after, and the timer has to say so. */
  runStartedAt?: number | null;
  /** Receives whatever the user typed in the note field, already trimmed and `""` when empty. */
  onClick: (extraInstructions: string) => void;
  onClear?: () => void;
  /** An extra action sharing this row — a PR comment's "resolve the thread on the host", which
   * belongs beside the fix that earned it rather than on a line of its own. */
  trailing?: ReactNode;
  /** False where there is no working copy to fix: `trailing` still renders, the AI half doesn't. */
  showAi?: boolean;
  /** Where the note is kept while this card is off screen (the assistant's drafts). Without it the
   *  note lives in the card and goes when the card does. */
  noteKey?: string;
}) {
  const t = useT();
  const [logExpanded, setLogExpanded] = useState(false);
  /** Extra instructions for the fix, kept whether the field is open or shut — collapsing it is
   * "I'm done typing", not "throw that away", and a re-run usually wants the same note. Kept in the
   * assistant's drafts when the card has a key, so switching tab does not throw it away either. */
  const [localExtra, setLocalExtra] = useState("");
  const storedExtra = useAiPanelStore((s) => (noteKey ? (s.drafts[noteKey] ?? "") : ""));
  const extra = noteKey ? storedExtra : localExtra;
  const setExtra = (value: string) =>
    noteKey ? useAiPanelStore.getState().setDraft(noteKey, value) : setLocalExtra(value);
  const queued = useIsQueued(resolving ? runId : null);
  const [noteOpen, setNoteOpen] = useState(false);
  // "Fix with AI" needs a write-capable agentic engine — hidden entirely for a text-only engine so
  // there's no dead button, unless there's already a resolution to show from an earlier run.
  // Local models are no longer in that group: Cline drives them and can edit files.
  // Keyed on the *fix* task's provider, which routing may point somewhere other than the default.
  const providerId = useTaskProvider("fix");
  const hideAi = !showAi || (!isAgenticProvider(providerId) && !resolution);
  const hasNote = extra.trim().length > 0;
  if (hideAi && !trailing) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {!hideAi && (
          <>
            <button
              onClick={() => onClick(extra.trim())}
              disabled={resolving}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              {resolving ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              {queued
                ? t("assistant.queued")
                : resolving
                  ? t("finding.resolving")
                  : resolution
                    ? t("finding.resolveAgain")
                    : t("finding.resolve")}
            </button>
            <button
              onClick={() => setNoteOpen((open) => !open)}
              disabled={resolving}
              title={t("finding.addInstructionsHint")}
              aria-expanded={noteOpen}
              className={
                // Shut over a note that's been written, the button is the only thing still saying
                // the fix isn't the plain one — so it carries the accent instead of sitting quiet.
                hasNote
                  ? "inline-flex h-6 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--cf-accent-soft)] px-2 text-[12px] font-medium text-[var(--cf-accent)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:pointer-events-none disabled:opacity-45"
                  : buttonClass({ variant: "ghost", size: "sm" })
              }
            >
              <MessageSquarePlus size={13} />
              {hasNote ? t("finding.instructionsAdded") : t("finding.addInstructions")}
            </button>
          </>
        )}
        {trailing}
      </div>
      {!hideAi && noteOpen && (
        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          disabled={resolving}
          rows={3}
          autoFocus
          placeholder={t("finding.instructionsPlaceholder")}
          className={textAreaClass}
        />
      )}
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
        <div className="relative rounded-md border border-[color-mix(in_oklab,var(--cf-success)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-success)_9%,transparent)] px-2.5 py-2 pr-8">
          <span className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-success)]">
            <CircleCheck size={12} />
            {t("finding.resolved")}
          </span>
          <p className="select-text text-[12px] leading-relaxed text-[var(--cf-text)]">{resolution}</p>
          {onClear && (
            <button
              onClick={onClear}
              title={t("finding.dismissResolution")}
              aria-label={t("finding.dismissResolution")}
              className={iconButtonClass({ size: "xs", className: "absolute right-1 top-1" })}
            >
              <X size={13} />
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

/** The two ways of ruling a finding out. */
type DiscardKind = "falso_positivo" | "ignorado";

/**
 * "This isn't a real defect" — the control that was previously only reachable from the settings
 * screen, put where the finding is actually read.
 *
 * The reason field is the part that earns its keep: it is what the next review is told (so the
 * model stops re-deriving the same rejected finding), what the pull request is told when the
 * thread is closed, and what makes a repository-wide rule reviewable months later. It stays
 * optional, because forcing prose is how you get "n/a".
 *
 * Which rejection is being composed (`drafting`) is the card's, not this component's: at rest the
 * two buttons ride at the end of the fix row, so fixing and ruling out read as the two answers to
 * the finding on one line, and only the composer opens below it.
 */
function DiscardControls({
  mark,
  onDiscard,
  busy,
  draftKey,
  drafting,
  onDrafting,
}: {
  mark?: FindingMark | null;
  onDiscard: (estado: string, opts: DiscardOptions) => void;
  busy: boolean;
  /** Where the reason is kept while the card is off screen; local to the card without one. */
  draftKey?: string;
  /** Which rejection is being composed, if any — `null` is the resting state (just the two buttons). */
  drafting: DiscardKind | null;
  onDrafting: (kind: DiscardKind | null) => void;
}) {
  const t = useT();
  // The reason is prose someone took the trouble to write: kept in the assistant's drafts so moving
  // to another tab mid-sentence does not throw it away.
  const [localMotivo, setLocalMotivo] = useState("");
  const storedMotivo = useAiPanelStore((s) => (draftKey ? (s.drafts[draftKey] ?? "") : ""));
  const motivo = draftKey ? storedMotivo : localMotivo;
  const setMotivo = (value: string) =>
    draftKey ? useAiPanelStore.getState().setDraft(draftKey, value) : setLocalMotivo(value);
  const [scopeRepo, setScopeRepo] = useState(false);
  // Defaults to on when the finding is on the PR: a rejection the author never sees leaves them
  // looking at a comment nobody intends to act on.
  const [notifyHost, setNotifyHost] = useState(true);

  if (isDiscarded(mark)) {
    const falso = mark?.estado === "falso_positivo";
    return (
      <div className="rounded-md bg-[var(--cf-hover)] px-2.5 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-muted)]">
          {falso ? <Ban size={12} /> : <EyeOff size={12} />}
          {t(falso ? "finding.discardedFalse" : "finding.discardedIgnored")}
        </span>
        {mark?.motivo && <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--cf-text)]">{mark.motivo}</p>}
        <button
          onClick={() => onDiscard("abierto", { motivo: "", scopeRepo: false, notifyHost: false })}
          disabled={busy}
          className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-2 mt-1" })}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
          {t("finding.undoDiscard")}
        </button>
      </div>
    );
  }

  if (drafting === null) {
    return (
      <div className="flex justify-end">
        <DiscardButtons onPick={onDrafting} />
      </div>
    );
  }

  const close = () => {
    onDrafting(null);
    setMotivo("");
    setScopeRepo(false);
    setNotifyHost(true);
  };

  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2.5 py-2">
      <p className="text-[12px] font-medium text-[var(--cf-text)]">
        {t(drafting === "falso_positivo" ? "finding.markFalsePositive" : "finding.markIgnored")}
      </p>
      <textarea
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        rows={2}
        autoFocus
        placeholder={t("finding.discardReasonPlaceholder")}
        className={textAreaClass}
      />
      {/* "Ignore" is a call about this pull request ("not now"), so it never becomes a standing
          rule about the code — only a false positive does. */}
      {drafting === "falso_positivo" && (
        <label className="flex items-start gap-2 text-[12px] text-[var(--cf-text-muted)]" title={t("finding.discardScopeRepoHint")}>
          <span className="mt-0.5">
            <Checkbox checked={scopeRepo} onChange={setScopeRepo} />
          </span>
          {t("finding.discardScopeRepo")}
        </label>
      )}
      {mark?.posted && (
        <label className="flex items-start gap-2 text-[12px] text-[var(--cf-text-muted)]" title={t("finding.discardNotifyHostHint")}>
          <span className="mt-0.5">
            <Checkbox checked={notifyHost} onChange={setNotifyHost} />
          </span>
          {t("finding.discardNotifyHost")}
        </label>
      )}
      {/* The step's own action at the right edge, Cancel beside it — the order every bar in the
          assistant keeps. */}
      <div className="flex items-center justify-end gap-1.5">
        <button onClick={close} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("common.cancel")}
        </button>
        <button
          onClick={() => {
            onDiscard(drafting, { motivo: motivo.trim(), scopeRepo, notifyHost });
            close();
          }}
          disabled={busy}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          {t("finding.discardConfirm")}
        </button>
      </div>
    </div>
  );
}

/** "False positive" and "Ignore", at rest — the doors into the composer above. */
function DiscardButtons({ onPick }: { onPick: (kind: DiscardKind) => void }) {
  const t = useT();
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      <button onClick={() => onPick("falso_positivo")} className={buttonClass({ variant: "ghost", size: "sm" })}>
        <Ban size={13} />
        {t("finding.markFalsePositive")}
      </button>
      <button onClick={() => onPick("ignorado")} className={buttonClass({ variant: "ghost", size: "sm" })}>
        <EyeOff size={13} />
        {t("finding.markIgnored")}
      </button>
    </span>
  );
}

/** Header pill for a finding a human has ruled out — the collapsed counterpart of the reason shown
 * inside the card, so a scan down the list shows what is still standing. */
export function DiscardedChip({ estado }: { estado: string }) {
  const t = useT();
  const falso = estado === "falso_positivo";
  return (
    <span title={t(falso ? "finding.discardedFalse" : "finding.discardedIgnored")} className={chipClass("neutral")}>
      {falso ? <Ban size={12} /> : <EyeOff size={12} />}
    </span>
  );
}

/** Small green "resolved" pill shown in a collapsed finding/comment header so the user can see at
 * a glance which items have already been handled without expanding each one. */
export function ResolvedChip() {
  const t = useT();
  return (
    <span title={t("finding.resolved")} className={chipClass("ok")}>
      <Check size={12} />
    </span>
  );
}

/** Severity tally chips (`3 critical · 2 warning · …`) — a scannable summary of a findings list,
 * shown in the PR-review findings header and the pre-commit analysis header so the two read the
 * same, each with its severity's shape. Renders nothing when there are no findings. */
export function SeverityCountBadges({ findings }: { findings: AnalysisFinding[] }) {
  const items = (["critical", "warning", "info"] as const)
    .map((severity) => ({ severity, n: findings.filter((f) => f.severity === severity).length }))
    .filter((i) => i.n > 0);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((i) => (
        <SeverityChip key={i.severity} severity={i.severity} count={i.n} />
      ))}
    </div>
  );
}

/** Quality Gate chip + the model's own A–E grades — shown once per review, above the
 * findings list, in both the pre-commit analysis view and the PR review view. The grades are one
 * chip of three letters; which letter is which is its tooltip, so the strip stays one line. */
export function QualityGateBadges({ grades, findings }: { grades: QualityGrades | null; findings: AnalysisFinding[] }) {
  const t = useT();
  const passed = computeQualityGatePassed(findings);
  const spelled = grades
    ? `${t("analyze.reliability")} ${grades.reliability} · ${t("analyze.security")} ${grades.security} · ${t("analyze.maintainability")} ${grades.maintainability}`
    : "";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={chipClass(passed ? "ok" : "bad")}>
        {passed ? <CircleCheck size={12} /> : <CircleX size={12} />}
        {t(passed ? "analyze.qualityGatePassed" : "analyze.qualityGateFailed")}
      </span>
      {grades && (
        <Tooltip label={spelled}>
          <span aria-label={spelled} className={chipClass("neutral", "font-mono tabular-nums")}>
            {grades.reliability} · {grades.security} · {grades.maintainability}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

export function FindingCard({
  finding,
  at = 0,
  defaultOpen,
  open: openProp,
  onToggle,
  onOpenLocation,
  highlighted = false,
  stale = false,
  projectId,
  prSourceBranch,
  resolutionKey,
  mark,
  onDiscard,
  discarding = false,
}: {
  finding: AnalysisFinding;
  /** Place in the list it arrives with, which is all the entry animation needs to stagger. */
  at?: number;
  defaultOpen: boolean;
  /** Controlled open state — the assistant keeps it per tab, so a card is still open when you come
   *  back to the review. Uncontrolled (starting at `defaultOpen`) when omitted. */
  open?: boolean;
  onToggle?: () => void;
  /** Makes the location a link: opens the file at that line. Omitted where there is no working copy
   *  to open it in (a PR reviewed from its link). */
  onOpenLocation?: (file: string, line: number) => void;
  /** Marks the card the detail column is showing, in the wide layout's list. */
  highlighted?: boolean;
  /** An earlier run's finding, shown while a new one runs — readable, visibly not current. */
  stale?: boolean;
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
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = openProp ?? localOpen;
  const toggle = onToggle ?? (() => setLocalOpen((v) => !v));
  const { resolving, resolution, resolve, clearResolution, runId, runStartedAt } = useResolveWithAi(
    projectId,
    prSourceBranch,
    resolutionKey,
    finding.subtitle,
  );
  const discarded = isDiscarded(mark);
  const [drafting, setDrafting] = useState<DiscardKind | null>(null);
  // Fixing it and rejecting it are the two answers to a finding, so at rest they share one row —
  // fix on the left, the two rulings at its far end. Once a ruling is being written, or has been
  // made, the discard controls take their own block below.
  const fixRow = Boolean(projectId) && !discarded;
  const rulingsInRow = fixRow && Boolean(onDiscard) && drafting === null;

  return (
    // Dimmed rather than hidden: a rejected finding is still part of what the review said, and
    // hiding it would make the ruling impossible to revisit from the list it was made in.
    <div
      style={riseDelay(at)}
      className={`cf-rise overflow-hidden rounded-lg border bg-[var(--cf-surface)] transition-opacity ${
        highlighted ? "border-[var(--cf-accent-line)]" : "border-[var(--cf-border)]"
      } ${discarded || stale ? "opacity-55" : ""}`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className={`flex w-full cursor-pointer items-start gap-2 px-3 py-2.5 text-left transition-colors duration-100 ${
          highlighted ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
        }`}
      >
        <div className="min-w-0 flex-1">
          {/* The severity leads the card as a chip with a shape — see `SEVERITY_STYLE` — in the
              line that says what kind of finding it is, so the title below keeps the full width
              of a narrow panel. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-[var(--cf-text-faint)]">
            <SeverityChip severity={finding.severity} />
            <span className="min-w-0 truncate">
              <span className="font-medium text-[var(--cf-text-muted)]">{finding.type}</span>
              {" · "}
              {finding.category}
              {" · "}
              <span className="font-mono">{finding.id}</span>
            </span>
          </div>
          <p className="mt-1.5 text-[13px] font-semibold leading-snug text-[var(--cf-text)]">
            <InlineMarkdown text={finding.subtitle} className="cf-markdown-inline" />
          </p>
          {finding.location &&
            (onOpenLocation ? (
              <button
                type="button"
                onClick={(e) => {
                  // The card's own toggle is the row; the location is its one link.
                  e.stopPropagation();
                  if (finding.location) onOpenLocation(finding.location.file, finding.location.startLine);
                }}
                title={t("finding.openLocation")}
                className="mt-1 flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-[var(--cf-accent)] underline decoration-[color-mix(in_oklab,var(--cf-accent)_35%,transparent)] underline-offset-2 hover:decoration-[var(--cf-accent)]"
              >
                <MapPin size={12} className="shrink-0" />
                <span className="truncate">{locationLabel(finding.location)}</span>
              </button>
            ) : (
              <p className="mt-1 flex items-center gap-1 truncate font-mono text-[11px] text-[var(--cf-text-faint)]">
                <MapPin size={12} className="shrink-0" />
                {locationLabel(finding.location)}
              </p>
            ))}
        </div>
        {discarded && <DiscardedChip estado={mark?.estado ?? ""} />}
        {resolution && <ResolvedChip />}
        {finding.confidence !== null && (
          <span className={chipClass("neutral", "tabular-nums")}>{finding.confidence}%</span>
        )}
        {open ? (
          <ChevronDown size={14} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={14} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        )}
      </div>

      {open && (
        // The substance of the finding — the reasoning, the suggestion, the example — is the part
        // worth quoting into a commit message or a reply, so the whole body is selectable rather
        // than just the fields that happen to render through the markdown class.
        <div className="select-text space-y-2 px-3 pb-3 pt-0.5 text-[12px] leading-relaxed">
          {/* Why and Suggestion are told apart by their icon as well as their word: a question
              for the reasoning, a light bulb — in the accent — for what to do about it. */}
          {finding.why && (
            <p className="flex items-start gap-2">
              <MessageCircleQuestionMark size={14} className="mt-[3px] shrink-0 text-[var(--cf-text-faint)]" />
              <span className="min-w-0">
                <span className="font-semibold text-[var(--cf-text)]">{t("analyze.why")}: </span>
                <InlineMarkdown text={finding.why} className="cf-markdown-inline text-[var(--cf-text-muted)]" />
              </span>
            </p>
          )}
          {finding.suggestion && (
            <p className="flex items-start gap-2">
              <Lightbulb size={14} className="mt-[3px] shrink-0 text-[var(--cf-accent)]" />
              <span className="min-w-0">
                <span className="font-semibold text-[var(--cf-text)]">{t("analyze.suggestion")}: </span>
                <InlineMarkdown text={finding.suggestion} className="cf-markdown-inline text-[var(--cf-text-muted)]" />
              </span>
            </p>
          )}
          {finding.exampleCode && (
            <pre className="overflow-x-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2.5 py-2 font-mono text-[11px] leading-relaxed">
              {finding.exampleCode}
            </pre>
          )}

          {/* Except once rejected, where offering to fix what was just called a non-defect would
              be the panel arguing with itself. */}
          {fixRow && (
            <ResolveWithAiButton
              resolving={resolving}
              resolution={resolution}
              runId={runId}
              runStartedAt={runStartedAt}
              onClick={(extra) => void resolve(withExtraInstructions(formatFindingAsFixPrompt(finding), extra))}
              onClear={clearResolution}
              noteKey={resolutionKey ? `note:${resolutionKey}` : undefined}
              trailing={rulingsInRow ? <DiscardButtons onPick={setDrafting} /> : undefined}
            />
          )}
          {onDiscard && !rulingsInRow && (
            <DiscardControls
              mark={mark}
              onDiscard={onDiscard}
              busy={discarding}
              draftKey={resolutionKey ? `discard:${resolutionKey}` : undefined}
              drafting={drafting}
              onDrafting={setDrafting}
            />
          )}
        </div>
      )}
    </div>
  );
}
