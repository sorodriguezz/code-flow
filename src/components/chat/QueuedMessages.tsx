import { Clock, Paperclip, Pause, Pencil, Play, Puzzle, X } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import type { QueueHold, QueuedChatMessage } from "../../state/chatQueueStore";
import { useT } from "../../state/languageStore";

/**
 * A conversation's queue as a composer is handed it — the same five things in both chats, so
 * the chat workspace, the quick-ask box and the assistant's panel wire it the same way.
 */
export interface ComposerQueue {
  items: QueuedChatMessage[];
  held: QueueHold | null;
  /** A turn — or a compaction — is running, so the queue is waiting on it rather than on the user. */
  busy: boolean;
  onRemove: (id: string) => void;
  /** Takes one back out of the queue; the composer puts its text and skill in the box. */
  onEdit: (id: string) => QueuedChatMessage | null;
  onResume: () => void;
}

/**
 * The messages waiting their turn, drawn directly above the box they were written in.
 *
 * # Above the composer, not in the transcript
 *
 * A queued message has not been asked yet. Drawing it as a question bubble would put a question in
 * the transcript that the model has not seen, with no answer under it and a turn number that is
 * not its own — and the first time it failed to send, the transcript would be showing something
 * that never happened. Above the box it reads as what it is: something written and not yet sent,
 * still the user's to change. It becomes a bubble the moment it is actually sent.
 *
 * # What the row offers, and what the strip does not
 *
 * Each message can be pulled back into the box (with its files and its skill) or dropped, which is
 * everything a draft can have done to it. Reordering is deliberately absent: the order is the
 * order it was written in, and anything that needs to jump the line can be pulled back and sent
 * when the conversation is free.
 *
 * The one control on the strip itself is resume, and only when nothing else is going to move the
 * queue: when it is held after a failure or a Stop, or — the safety valve — when it is sitting
 * behind nothing at all, which a turn ended in another window can leave behind.
 */
export function QueuedMessages({ queue }: { queue: ComposerQueue }) {
  const t = useT();
  const { items, held, busy } = queue;
  if (items.length === 0) return null;

  const waiting = held !== null || !busy;
  const heading = held ? t("chat.queueHeld") : t("chat.queueTitle");
  const why =
    held === "error"
      ? t("chat.queueHeldError")
      : held === "stopped"
        ? t("chat.queueHeldStopped")
        : t("chat.queueHint");

  return (
    <div className="cf-fade-in mb-1.5" role="region" aria-label={heading}>
      <div className="flex items-center gap-1.5 px-1 pb-1">
        <Tooltip label={heading} description={why}>
          <span
            className={`flex items-center gap-1 text-[11px] font-medium ${
              held ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"
            }`}
          >
            {held ? <Pause size={10} className="shrink-0" /> : <Clock size={10} className="shrink-0" />}
            {heading}
            <span className="tabular-nums opacity-70">{items.length}</span>
          </span>
        </Tooltip>
        {waiting && (
          <button
            type="button"
            onClick={queue.onResume}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--cf-accent)] transition-colors hover:bg-[var(--cf-hover)]"
          >
            <Play size={9} className="shrink-0 fill-current" />
            {t("chat.queueResume")}
          </button>
        )}
      </div>
      <ol className="flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={item.id}
            // Dashed, where a sent message and an attachment chip are solid: the one visual
            // difference between "written" and "sent" is the one this strip exists to show.
            className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-[var(--cf-border-strong)] bg-[var(--cf-surface-2)] py-1 pl-2.5 pr-1 text-[12.5px] text-[var(--cf-text)]"
          >
            <span
              title={item.text}
              className={`min-w-0 flex-1 truncate ${item.command ? "font-mono text-[12px]" : ""}`}
            >
              {item.text}
            </span>
            {item.skill && (
              <span
                title={t("chat.skillPicked")}
                className="flex max-w-[120px] shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)]"
              >
                <Puzzle size={10} className="shrink-0" />
                <span className="truncate font-mono">{item.skill.name}</span>
              </span>
            )}
            {item.attachments && item.attachments.length > 0 && (
              <span
                title={item.attachments.map((file) => file.name).join("\n")}
                className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-[var(--cf-text-muted)]"
              >
                <Paperclip size={10} className="shrink-0" />
                {item.attachments.length}
              </span>
            )}
            <button
              type="button"
              onClick={() => queue.onEdit(item.id)}
              title={t("chat.queueEdit")}
              aria-label={t("chat.queueEdit")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              onClick={() => queue.onRemove(item.id)}
              title={t("chat.queueRemove")}
              aria-label={t("chat.queueRemove")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
            >
              <X size={11} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
