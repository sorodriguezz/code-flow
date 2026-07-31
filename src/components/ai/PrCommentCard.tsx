import { useState } from "react";
import { CheckCheck, ChevronDown, ChevronRight, Loader2, MapPin, MessageCircle } from "lucide-react";
import type { PrCommentThread } from "../../types/domain";
import { Skeleton } from "../common/Skeleton";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { InlineMarkdown, ResolveWithAiButton, ResolvedChip, useResolveWithAi } from "./FindingCard";

/** Shimmer placeholder shown while a PR's existing comment threads are being fetched, so the
 * user gets immediate "we're looking" feedback the moment they open a PR — it stays up for the
 * whole request even when the PR turns out to have no comments at all. Mirrors the shape of a
 * collapsed {@link PrCommentCard} (icon dot + author line + comment line) so the real cards
 * don't jump the layout when they replace it. */
export function PrCommentsSkeleton({ label, rows = 2 }: { label: string; rows?: number }) {
  return (
    <div className="mb-4 space-y-2" aria-busy="true">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        <Loader2 size={11} className="animate-spin" />
        {label}
      </p>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-lg border border-[var(--cf-border)] px-3 py-2"
          style={{ borderLeft: "3px solid var(--cf-border)" }}
        >
          <Skeleton className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-2.5" style={{ width: "35%" }} />
            <Skeleton className="h-3" style={{ width: `${70 - i * 15}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function locationLabel(thread: PrCommentThread): string | null {
  if (!thread.file_path || thread.start_line === null) return null;
  const end = thread.end_line !== null && thread.end_line !== thread.start_line ? `-${thread.end_line}` : "";
  return `${thread.file_path}:${thread.start_line}${end}`;
}

function buildFixPrompt(thread: PrCommentThread): string {
  const lines = ["Comentario de revisión en el pull request:"];
  const loc = locationLabel(thread);
  if (loc) lines.push(`Ubicación: ${loc}`);
  for (const c of thread.comments) lines.push(`${c.author}: ${c.content}`);
  return lines.join("\n");
}

/** An existing PR comment thread — e.g. from a human reviewer (a tech lead leaving feedback
 * directly on Azure DevOps, not through CodeFlow) — shown alongside CodeFlow's own AI
 * findings so it can be resolved the same way, with the same "Resolve with AI" flow. */
export function PrCommentCard({
  thread,
  projectId,
  prSourceBranch,
  resolutionKey,
  onResolveThread,
}: {
  thread: PrCommentThread;
  /** Omitted for a PR reviewed from a link with no clone: there's no working copy for "resolve
   * with AI" to edit, so that action isn't offered. */
  projectId?: string;
  prSourceBranch: string;
  /** Stable id under which this comment thread's "resolve with AI" outcome is persisted. */
  resolutionKey?: string;
  /** Closes this conversation on the host (Azure "fixed" / GitHub "resolved"). Omitted where
   * there's nothing to close it on. */
  onResolveThread?: () => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { resolving, resolution, resolve, clearResolution, runId, runStartedAt } = useResolveWithAi(
    projectId,
    prSourceBranch,
    resolutionKey,
  );
  const [closingThread, setClosingThread] = useState(false);
  // The host's own "Resolve" waits for the fix: a thread closed before the code changed is a
  // conversation ended with nothing done. So where AI can apply the fix, this unlocks once it
  // has — and where it can't (no working copy), there's nothing to wait for.
  const canCloseThread = !projectId || resolution !== null;
  const closeThread = async () => {
    if (!onResolveThread) return;
    if (!(await confirmAction(t("pr.confirmResolveThread"), false))) return;
    setClosingThread(true);
    try {
      await onResolveThread();
    } finally {
      setClosingThread(false);
    }
  };
  const [first, ...rest] = thread.comments;
  const loc = locationLabel(thread);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
        style={{ borderLeft: "3px solid var(--cf-text-muted)" }}
      >
        <MessageCircle size={14} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{first.author}</p>
          <p className="mt-0.5 text-[13px] font-medium text-[var(--cf-text)]">
            <InlineMarkdown text={first.content} className="cf-markdown-inline" />
          </p>
          {loc && (
            <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
              <MapPin size={10} className="shrink-0" />
              {loc}
            </p>
          )}
        </div>
        {resolution && <ResolvedChip />}
        {open ? (
          <ChevronDown size={13} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={13} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--cf-border)] px-3 py-2.5 text-[12px]">
          {rest.map((c, i) => (
            <p key={i}>
              <span className="font-medium text-[var(--cf-text)]">{c.author}: </span>
              <InlineMarkdown text={c.content} className="cf-markdown-inline text-[var(--cf-text-muted)]" />
            </p>
          ))}
          {/* Without a working copy there's no fix to apply, but the conversation can still be
              closed on the host — so the row is rendered either way, and only the AI half of it
              depends on a project. */}
          <ResolveWithAiButton
            showAi={!!projectId}
            resolving={resolving}
            resolution={resolution}
            runId={runId}
            runStartedAt={runStartedAt}
            onClick={() => void resolve(buildFixPrompt(thread))}
            onClear={clearResolution}
            trailing={
              onResolveThread && (
                <button
                  onClick={() => void closeThread()}
                  disabled={!canCloseThread || closingThread}
                  title={canCloseThread ? t("pr.resolveThreadHint") : t("pr.resolveThreadLocked")}
                  className="flex items-center gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--cf-success)_45%,transparent)] px-2.5 py-1 text-[11px] font-medium text-[var(--cf-success)] hover:bg-[color-mix(in_oklab,var(--cf-success)_10%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {closingThread ? <Loader2 size={11} className="animate-spin" /> : <CheckCheck size={11} />}
                  {t("pr.resolveThread")}
                </button>
              )
            }
          />
          {/* The AI half is what a missing working copy removes — say so once, rather than
              leaving a button that silently does nothing. */}
          {!projectId && (
            <p className="text-[11px] text-[var(--cf-text-muted)]">{t("pr.noWorkingCopyForFix")}</p>
          )}
        </div>
      )}
    </div>
  );
}
