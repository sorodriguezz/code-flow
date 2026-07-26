import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MapPin, MessageCircle } from "lucide-react";
import type { PrCommentThread } from "../../types/domain";
import { Skeleton } from "../common/Skeleton";
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
}: {
  thread: PrCommentThread;
  projectId: string;
  prSourceBranch: string;
  /** Stable id under which this comment thread's "resolve with AI" outcome is persisted. */
  resolutionKey?: string;
}) {
  const [open, setOpen] = useState(false);
  const { resolving, resolution, resolve, clearResolution, runId } = useResolveWithAi(
    projectId,
    prSourceBranch,
    resolutionKey,
  );
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
          <ResolveWithAiButton
            resolving={resolving}
            resolution={resolution}
            runId={runId}
            onClick={() => void resolve(buildFixPrompt(thread))}
            onClear={clearResolution}
          />
        </div>
      )}
    </div>
  );
}
