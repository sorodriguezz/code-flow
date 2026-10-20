import { useEffect, useState } from "react";
import { FileDiff, MessageSquarePlus, RefreshCw, Send, Trash2, X } from "lucide-react";
import { InlineContent } from "../git/DiffInline";
import { buttonClass, iconButtonClass } from "../common/Button";
import { EmptyState } from "../common/EmptyState";
import { FileGlyph } from "../common/FileGlyph";
import { Tooltip } from "../common/Tooltip";
import { fieldClass, rowClass } from "../common/recipes";
import { Select } from "../common/Select";
import { reviewOf, useTaskReviewStore } from "../../state/taskReviewStore";
import { useAgentsStore } from "../../state/agentsStore";
import { useT } from "../../state/languageStore";
import { anchorOf, type ReviewComment, type ReviewSide } from "../../lib/agents/reviewNote";
import type { DiffLine } from "../../types/domain";

/**
 * Where a review goes. A task's chat by default; for a working copy whose agents run in terminals,
 * typed into one of those CLIs; and nowhere when nobody works there — then the diff is read-only,
 * because a comment that cannot be sent is a note written to no one.
 */
export type ReviewTarget =
  | { kind: "task" }
  | {
      kind: "terminal";
      /** The agents at work in the copy's terminals; the first is preselected. */
      agents: readonly { sessionId: string; label: string }[];
      /** After it went — to put that agent's terminal on screen. */
      onSent?: (sessionId: string) => void;
    }
  | { kind: "none" };

/**
 * Reviewing an agent's work where the work happened: its diff, with a comment on any line, sent
 * back as the task's next turn.
 *
 * **Why the comments go back as an ordinary message.** There is no second channel to an agent — the
 * transcript is the channel. So a review is written into it like anything else the user says, which
 * means it is in the history the next turn resumes from, it reads as what was asked, and no part of
 * the engine had to learn a new verb. `lib/agents/reviewNote` is what turns the notes into that
 * message.
 *
 * **Why it is a tab of the task and not the Changes view.** A task that runs in a worktree of its
 * own edits a folder the repository views never open, so «Revisar cambios» could only offer to
 * reveal the folder in the file manager. Reading the diff from a *path* makes the worktree case the
 * same as the ordinary one.
 */
export function TaskReviewPanel({
  taskId,
  repoPath,
  sendTo = { kind: "task" },
}: {
  /** The review's key: a task's id — or, for a worktree no task owns, any stable key of its own. */
  taskId: string;
  repoPath: string;
  sendTo?: ReviewTarget;
}) {
  const t = useT();
  const review = useTaskReviewStore((s) => reviewOf(s, taskId));
  const sending = useAgentsStore((s) => s.live[taskId]?.sending ?? false);
  const canComment = sendTo.kind !== "none";
  const terminals = sendTo.kind === "terminal" ? sendTo.agents : [];
  /** The terminal agent the review goes to, when it goes to one. */
  const [pickedSession, setPickedSession] = useState("");
  const session = terminals.some((agent) => agent.sessionId === pickedSession) ? pickedSession : (terminals[0]?.sessionId ?? "");
  const [delivering, setDelivering] = useState(false);
  const load = useTaskReviewStore((s) => s.load);

  // Re-read when the panel opens and whenever the working copy under it changes — a turn that just
  // finished is the usual reason this is being looked at.
  useEffect(() => {
    void load(taskId, repoPath);
  }, [load, taskId, repoPath, sending]);

  const pending = review.comments.length + (review.general.trim() === "" ? 0 : 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <FileRail taskId={taskId} canComment={canComment} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {review.error !== "" ? (
            <EmptyState icon={FileDiff} title={t("agents.review.failed")} subtitle={review.error} />
          ) : review.selected === null ? (
            canComment ? (
              <CommentSummary taskId={taskId} />
            ) : (
              <EmptyState
                icon={FileDiff}
                title={review.files.length === 0 ? t("agents.review.noChanges") : t("agents.review.pickFile")}
                subtitle={t("agents.review.readOnlyHint")}
              />
            )
          ) : (
            <DiffPane taskId={taskId} canComment={canComment} />
          )}
        </div>
      </div>

      {/* The footer is the review's own composer: the note that belongs to no line, and the send.
          The task's normal composer is hidden while this tab is up — two boxes that both send a
          turn, one of which silently discards the comments, is the one shape worth avoiding. */}
      {canComment && (
        <div className="shrink-0 border-t border-[var(--cf-border)] px-4 py-2.5">
          <div className="flex items-end gap-2">
            <textarea
              rows={2}
              value={review.general}
              onChange={(e) => useTaskReviewStore.getState().setGeneral(taskId, e.target.value)}
              placeholder={t("agents.review.generalPlaceholder")}
              aria-label={t("agents.review.generalPlaceholder")}
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1 resize-none leading-relaxed" })}
            />
            {/* Several agents in the copy's terminals: which one reads the review. */}
            {terminals.length > 1 && (
              <div className="w-[150px] shrink-0">
                <Select
                  value={session}
                  onChange={setPickedSession}
                  options={terminals.map((agent) => ({ value: agent.sessionId, label: agent.label }))}
                  size="compact"
                  ariaLabel={t("agents.review.sendToWho")}
                />
              </div>
            )}
            <Tooltip
              label={
                pending === 0
                  ? t("agents.review.nothingToSend")
                  : sendTo.kind === "terminal"
                    ? t("agents.review.sendTerminalHint")
                    : t("agents.review.sendHint")
              }
            >
              <button
                type="button"
                disabled={pending === 0 || sending || delivering || (sendTo.kind === "terminal" && session === "")}
                onClick={() => {
                  const labels = {
                    intro: t("agents.review.intro", { n: review.comments.length }),
                    general: t("agents.review.generalHeading"),
                  };
                  if (sendTo.kind !== "terminal") {
                    useTaskReviewStore.getState().sendReview(taskId, labels);
                    return;
                  }
                  setDelivering(true);
                  void useTaskReviewStore
                    .getState()
                    .sendReviewToTerminal(taskId, labels, session)
                    .then((sent) => {
                      if (sent) sendTo.onSent?.(session);
                    })
                    .finally(() => setDelivering(false));
                }}
                className={buttonClass({ variant: "primary", size: "sm", className: "shrink-0" })}
              >
                <Send size={12} />
                {sendTo.kind === "terminal" && terminals.length === 1
                  ? t("agents.review.sendTo", { name: terminals[0].label })
                  : pending === 0
                    ? t("agents.review.send")
                    : t("agents.review.sendN", { n: pending })}
              </button>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}

/** The changed files, and the way back to the list of comments. */
function FileRail({ taskId, canComment }: { taskId: string; canComment: boolean }) {
  const t = useT();
  const review = useTaskReviewStore((s) => reviewOf(s, taskId));

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-[var(--cf-border)]">
      <div className="flex h-9 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text-muted)]">
          {t("agents.review.filesN", { n: review.files.length })}
        </span>
        <Tooltip label={t("agents.review.refresh")}>
          <button
            type="button"
            aria-label={t("agents.review.refresh")}
            onClick={() => void useTaskReviewStore.getState().load(taskId, review.repoPath)}
            className={iconButtonClass({ size: "sm" })}
          >
            <RefreshCw size={13} className={review.loading ? "animate-spin" : ""} />
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {review.files.length === 0 && !review.loading && (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--cf-text-faint)]">
            {t("agents.review.noChanges")}
          </p>
        )}
        {review.files.map((file) => {
          const notes = review.comments.filter((comment) => comment.path === file.path).length;
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => void useTaskReviewStore.getState().selectFile(taskId, file.path)}
              title={file.path}
              className={rowClass(review.selected === file.path, "w-full gap-1.5 px-2 py-1 text-left")}
            >
              <FileGlyph path={file.path} size={13} />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{file.path.split("/").pop()}</span>
              {notes > 0 && (
                <span className="shrink-0 rounded-full bg-[var(--cf-accent-fill)] px-1.5 text-[10.5px] font-semibold tabular-nums text-[var(--cf-on-accent)]">
                  {notes}
                </span>
              )}
              <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-success)]">+{file.added}</span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-danger)]">−{file.removed}</span>
            </button>
          );
        })}
      </div>

      {review.selected !== null && canComment && (
        <button
          type="button"
          onClick={() => void useTaskReviewStore.getState().selectFile(taskId, null)}
          className={buttonClass({ variant: "ghost", size: "sm", className: "m-1.5 justify-center" })}
        >
          <MessageSquarePlus size={12} />
          {t("agents.review.showComments")}
        </button>
      )}
    </aside>
  );
}

/** Everything written so far, when no file is open — the review as it will be sent. */
function CommentSummary({ taskId }: { taskId: string }) {
  const t = useT();
  const review = useTaskReviewStore((s) => reviewOf(s, taskId));

  if (review.comments.length === 0) {
    return (
      <EmptyState
        icon={MessageSquarePlus}
        title={t("agents.review.noComments")}
        subtitle={review.files.length === 0 ? t("agents.review.noChanges") : t("agents.review.noCommentsHint")}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mx-auto w-full max-w-[760px] space-y-2">
        {review.comments.map((comment) => (
          <div
            key={comment.id}
            className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void useTaskReviewStore.getState().selectFile(taskId, comment.path)}
                className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-[var(--cf-accent)]"
              >
                {anchorOf(comment)}
              </button>
              <RemoveComment taskId={taskId} commentId={comment.id} />
            </div>
            {comment.code !== "" && (
              <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[11.5px] text-[var(--cf-text-muted)]">
                {comment.code}
              </pre>
            )}
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--cf-text)]">
              {comment.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function RemoveComment({ taskId, commentId }: { taskId: string; commentId: string }) {
  const t = useT();
  return (
    <Tooltip label={t("agents.review.removeComment")}>
      <button
        type="button"
        aria-label={t("agents.review.removeComment")}
        onClick={() => useTaskReviewStore.getState().removeComment(taskId, commentId)}
        className={iconButtonClass({ size: "sm" })}
      >
        <Trash2 size={13} />
      </button>
    </Tooltip>
  );
}

/** Where a comment is being written: the line it hangs off, as the diff drew it. */
type Draft = { side: ReviewSide; lineno: number | null; code: string };

/** The open file's diff, every line of it commentable. */
function DiffPane({ taskId, canComment }: { taskId: string; canComment: boolean }) {
  const t = useT();
  const review = useTaskReviewStore((s) => reviewOf(s, taskId));
  const [draft, setDraft] = useState<Draft | null>(null);
  const path = review.selected ?? "";

  // A different file is a different set of lines: a draft left open would land its comment on a
  // line number that means something else now.
  useEffect(() => setDraft(null), [path]);

  if (review.diffLoading) return <div className="p-4 text-[12px] text-[var(--cf-text-faint)]">{t("agents.review.loading")}</div>;
  if (!review.diff) return <EmptyState icon={FileDiff} title={t("agents.review.noDiff")} />;
  if (review.diff.binary) return <EmptyState icon={FileDiff} title={t("agents.review.binary")} subtitle={path} />;

  const commentsFor = (side: ReviewSide, lineno: number | null): ReviewComment[] =>
    review.comments.filter(
      (comment) => comment.path === path && comment.side === side && comment.lineno === lineno,
    );

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-[1] flex h-8 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-bg)] px-3">
        <FileGlyph path={path} size={13} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]">{path}</span>
      </div>

      {review.diff.hunks.map((hunk, hunkAt) => (
        <div key={hunkAt}>
          <div className="bg-[var(--cf-surface)] px-3 py-0.5 font-mono text-[11px] text-[var(--cf-text-faint)]">
            {hunk.header.trim()}
          </div>
          {hunk.lines.map((line, lineAt) => {
            const side: ReviewSide = line.origin === "-" ? "old" : "new";
            const lineno = side === "old" ? line.old_lineno : line.new_lineno;
            const drafting = draft !== null && draft.side === side && draft.lineno === lineno;
            return (
              <div key={`${hunkAt}-${lineAt}`}>
                <DiffRow
                  line={line}
                  lines={hunk.lines}
                  index={lineAt}
                  onComment={
                    canComment
                      ? () => setDraft({ side, lineno, code: `${line.origin}${line.content}`.replace(/\n$/, "") })
                      : undefined
                  }
                  commentLabel={t("agents.review.commentOnLine")}
                />
                {commentsFor(side, lineno).map((comment) => (
                  <div
                    key={comment.id}
                    className="flex items-start gap-2 border-y border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-1.5"
                  >
                    <MessageSquarePlus size={13} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--cf-text)]">
                      {comment.body}
                    </p>
                    <RemoveComment taskId={taskId} commentId={comment.id} />
                  </div>
                ))}
                {drafting && draft && (
                  <CommentDraft
                    onCancel={() => setDraft(null)}
                    onSave={(body) => {
                      useTaskReviewStore.getState().addComment(taskId, {
                        path,
                        side: draft.side,
                        lineno: draft.lineno,
                        code: draft.code,
                        body,
                      });
                      setDraft(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** One line of the diff, with the button that comments on it revealed on hover. */
function DiffRow({
  line,
  lines,
  index,
  onComment,
  commentLabel,
}: {
  line: DiffLine;
  lines: DiffLine[];
  index: number;
  /** Absent where a comment has nowhere to go: the gutter keeps its width, with no button in it. */
  onComment?: () => void;
  commentLabel: string;
}) {
  const tint =
    line.origin === "+"
      ? "bg-[color-mix(in_oklab,var(--cf-success)_12%,transparent)]"
      : line.origin === "-"
        ? "bg-[color-mix(in_oklab,var(--cf-danger)_12%,transparent)]"
        : "";

  return (
    <div className={`group flex items-start font-mono text-[12px] leading-[1.5] ${tint}`}>
      <span className="w-10 shrink-0 select-none pr-1 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)]">
        {line.old_lineno ?? ""}
      </span>
      <span className="w-10 shrink-0 select-none pr-1 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)]">
        {line.new_lineno ?? ""}
      </span>
      {/* The affordance lives in the gutter rather than at the end of the line: a diff line can be
          hundreds of columns wide, and a button at its end is off screen exactly when the line is
          the interesting one. */}
      {onComment ? (
        <button
          type="button"
          onClick={onComment}
          title={commentLabel}
          aria-label={commentLabel}
          className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <MessageSquarePlus size={11} />
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <span className="w-3 shrink-0 select-none text-center text-[var(--cf-text-faint)]">{line.origin.trim()}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">
        <InlineContent line={line} lines={lines} index={index} />
      </span>
    </div>
  );
}

/** The box a comment is typed into. Enter saves, Shift+Enter breaks the line — the same contract as
 *  every composer in the app. */
function CommentDraft({ onSave, onCancel }: { onSave: (body: string) => void; onCancel: () => void }) {
  const t = useT();
  const [body, setBody] = useState("");

  return (
    <div className="border-y border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2">
      <textarea
        autoFocus
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            if (body.trim()) onSave(body.trim());
          }
        }}
        placeholder={t("agents.review.commentPlaceholder")}
        aria-label={t("agents.review.commentPlaceholder")}
        className={fieldClass({ size: "sm", className: "w-full resize-none leading-relaxed" })}
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!body.trim()}
          onClick={() => onSave(body.trim())}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          {t("agents.review.addComment")}
        </button>
        <button type="button" onClick={onCancel} className={buttonClass({ variant: "ghost", size: "sm" })}>
          <X size={12} />
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
