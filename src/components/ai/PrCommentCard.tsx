import { useState } from "react";
import { ChevronDown, ChevronRight, MapPin, MessageCircle } from "lucide-react";
import type { PrCommentThread } from "../../types/domain";
import { InlineMarkdown, ResolveWithAiButton, useResolveWithAi } from "./FindingCard";

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
}: {
  thread: PrCommentThread;
  projectId: string;
  prSourceBranch: string;
}) {
  const [open, setOpen] = useState(false);
  const { resolving, resolution, resolve } = useResolveWithAi(projectId, prSourceBranch);
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
          <ResolveWithAiButton resolving={resolving} resolution={resolution} onClick={() => void resolve(buildFixPrompt(thread))} />
        </div>
      )}
    </div>
  );
}
