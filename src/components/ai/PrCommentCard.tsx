import { useState } from "react";
import { CheckCheck, ChevronDown, ChevronRight, Loader2, MapPin, MessageCircle, Wand2 } from "lucide-react";
import type { PrCommentThread, ThreadCloseOutcome } from "../../types/domain";
import { Skeleton } from "../common/Skeleton";
import { draftPrCommentReply } from "../../lib/tauri/commands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { pushErrorToast } from "../../state/toastStore";
import { notify } from "../../state/notificationStore";
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

/** The conversation as plain text, for the model drafting a reply to it. Same shape the card
 * renders, minus the markup — what was said, by whom, and where. */
function threadAsText(thread: PrCommentThread): string {
  const loc = locationLabel(thread);
  const head = loc ? `Ubicación: ${loc}\n` : "";
  return head + thread.comments.map((c) => `${c.author}: ${c.content}`).join("\n\n");
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
  /** Replies to and closes this conversation on the host (Azure "fixed"/"won't fix", GitHub
   * "resolved"). Resolves to what each half managed to do (`null` when the call itself failed), so
   * a reply the host took but a close it refused leaves the composer standing instead of looking
   * done. Omitted where there's nothing to close it on. */
  onResolveThread?: (reply: { body: string | null; wontFix: boolean }) => Promise<ThreadCloseOutcome | null>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Which conversation a notification is about. The file and line is what identifies a thread to
  // the person reading it; a thread with no location falls back to the first thing it says.
  const threadLabel = locationLabel(thread) ?? thread.comments[0]?.content.slice(0, 80);
  const { resolving, resolution, resolve, clearResolution, runId, runStartedAt } = useResolveWithAi(
    projectId,
    prSourceBranch,
    resolutionKey,
    threadLabel,
  );
  const [closingThread, setClosingThread] = useState(false);
  // Whether the "close this conversation" composer is open, and what it has in it. A comment thread
  // is often closed *without* the change being made — "es intencional", "va en otro PR" — and
  // closing it silently leaves the author reading a conversation that ended with no answer. So the
  // reply travels with the close instead of the close being a bare button.
  const [composing, setComposing] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  // Which of the two closes this is. Azure records them differently, and "corregido" on a thread
  // nobody acted on is a lie on the pull request's record — so it defaults to what actually
  // happened: fixed only when a fix was applied from here. Re-read each time the composer opens,
  // not once on mount: applying the fix and then closing the conversation is the normal order, and
  // a default frozen at mount would still say "no aplica" after the fix landed.
  const [wontFix, setWontFix] = useState(true);
  const openComposer = () => {
    setWontFix(resolution === null);
    setComposing(true);
  };
  const [drafting, setDrafting] = useState(false);

  /** Writes the reply with AI instead of by hand: the thread as context, whatever is already in the
   * box as the intent ("no aplica porque…"). The draft lands in the textarea — it is a first draft
   * to edit, never something posted straight to the pull request. */
  const draftReply = async () => {
    const id = newRunId("draft");
    useAiRunStore.getState().start(id);
    setDrafting(true);
    try {
      const text = await draftPrCommentReply(threadAsText(thread), replyBody.trim() || null, id);
      setReplyBody(text.trim());
      // The draft is sitting in this thread's reply box, inside the panel — nowhere else to go.
      // `projectId` is absent for a link review, which belongs to no repository here.
      notify({
        source: "review",
        titleKey: "notifications.draftDone",
        target: { openAiPanel: true, projectId },
        status: "success",
        detail: threadLabel,
      });
    } catch (e) {
      if (!isCancellation(e)) {
        pushErrorToast(String(e));
        notify({
          source: "review",
          titleKey: "notifications.draftFailed",
          target: { openAiPanel: true, projectId },
          status: "error",
          detail: threadLabel,
        });
      }
    } finally {
      useAiRunStore.getState().finish(id);
      setDrafting(false);
    }
  };

  // The reply landed on a previous attempt whose close then failed. Kept so retrying closes the
  // conversation without writing the same comment onto the pull request a second time.
  const [replyPosted, setReplyPosted] = useState(false);

  const closeThread = async () => {
    if (!onResolveThread) return;
    setClosingThread(true);
    try {
      const outcome = await onResolveThread({ body: replyPosted ? null : replyBody.trim() || null, wontFix });
      if (outcome?.replied) setReplyPosted(true);
      // Left open on a refused close so the text isn't lost — the panel has already said why.
      if (outcome?.resolved) setComposing(false);
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
                  onClick={() => (composing ? setComposing(false) : openComposer())}
                  disabled={closingThread}
                  title={t("pr.resolveThreadHint")}
                  className="flex items-center gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--cf-success)_45%,transparent)] px-2.5 py-1 text-[11px] font-medium text-[var(--cf-success)] hover:bg-[color-mix(in_oklab,var(--cf-success)_10%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {closingThread ? <Loader2 size={11} className="animate-spin" /> : <CheckCheck size={11} />}
                  {t("pr.resolveThread")}
                </button>
              )
            }
          />
          {composing && onResolveThread && (
            <ThreadCloseComposer
              body={replyBody}
              onBody={setReplyBody}
              wontFix={wontFix}
              onWontFix={setWontFix}
              drafting={drafting}
              onDraft={() => void draftReply()}
              busy={closingThread}
              replyPosted={replyPosted}
              onConfirm={() => void closeThread()}
              onCancel={() => setComposing(false)}
            />
          )}
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

/**
 * What the green **Resolve** opens: the answer that goes on the conversation before it is closed.
 *
 * The comment is optional but it is the point of the whole control — most conversations worth
 * closing from here are ones the reviewer's suggestion *wasn't* applied to, and a close with no
 * answer is what makes the author chase it later. Writing it by hand and having AI draft it are the
 * same field: the draft lands in the textarea and is edited like anything typed there, so nothing
 * reaches the pull request that the user didn't read.
 *
 * The outcome toggle is not cosmetic — Azure DevOps records *fixed* and *won't fix* as different
 * closes, and saying "fixed" about a change nobody made puts a false statement on the record.
 */
function ThreadCloseComposer({
  body,
  onBody,
  wontFix,
  onWontFix,
  drafting,
  onDraft,
  busy,
  replyPosted,
  onConfirm,
  onCancel,
}: {
  body: string;
  onBody: (v: string) => void;
  wontFix: boolean;
  onWontFix: (v: boolean) => void;
  drafting: boolean;
  onDraft: () => void;
  busy: boolean;
  /** The reply already reached the pull request on an attempt whose close then failed: the text is
   * frozen (it is published — editing it here would change nothing) and only the close is retried. */
  replyPosted: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const hasBody = body.trim().length > 0;
  const confirmLabel = replyPosted
    ? "pr.threadRetryClose"
    : hasBody
      ? "pr.threadReplyAndClose"
      : "pr.threadCloseWithoutReply";
  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border)] bg-black/[0.02] px-2.5 py-2 dark:bg-white/[0.03]">
      <p className="text-[11px] font-medium text-[var(--cf-text)]">{t("pr.threadCloseTitle")}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <OutcomeChip label={t("pr.threadOutcomeFixed")} active={!wontFix} onClick={() => onWontFix(false)} />
        <OutcomeChip label={t("pr.threadOutcomeWontFix")} active={wontFix} onClick={() => onWontFix(true)} />
      </div>
      <p className="text-[10px] leading-relaxed text-[var(--cf-text-muted)]">
        {t(wontFix ? "pr.threadOutcomeWontFixHint" : "pr.threadOutcomeFixedHint")}
      </p>
      <textarea
        value={body}
        onChange={(e) => onBody(e.target.value)}
        rows={3}
        autoFocus
        disabled={drafting || replyPosted}
        placeholder={t("pr.threadReplyPlaceholder")}
        className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)] disabled:opacity-60"
      />
      {replyPosted && (
        <p className="text-[10px] text-[var(--cf-text-muted)]">{t("pr.threadReplyAlreadyPosted")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onConfirm}
          disabled={busy || drafting}
          className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 size={11} className="animate-spin" />}
          {t(confirmLabel)}
        </button>
        {/* Drafting is offered with the box empty (write me something reasonable) and with a note
            already in it (say this properly) — the note is the intent, not a replacement for it. */}
        {!replyPosted && (
          <button
            onClick={onDraft}
            disabled={drafting || busy}
            title={t("pr.threadDraftHint")}
            className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
          >
            {drafting ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
            {t(drafting ? "pr.threadDrafting" : "pr.threadDraftWithAi")}
          </button>
        )}
        <button
          onClick={onCancel}
          disabled={busy}
          className="text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] disabled:opacity-50"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

/** One of the two closes, as a pill. Selected state is carried by fill rather than a radio dot —
 * the choice is between two words, and a radio group would be heavier than the decision. */
function OutcomeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? "bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      {label}
    </button>
  );
}
