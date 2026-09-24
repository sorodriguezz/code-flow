import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useT } from "../../state/languageStore";

/**
 * The model's reasoning, while it reasons — and folded away once it has.
 *
 * Fed by `thinking_delta`, which is a *separate* delta kind from `text_delta` on the wire precisely
 * because it is a separate thing: it is the model talking to itself, and it is not the answer. So it
 * gets its own container above the answer rather than being concatenated into it — the alternative
 * was tried by every chat UI that shipped before the distinction existed, and it produces replies
 * that begin "Okay, the user is asking about…" and never recover.
 *
 * **This is the one place in the chat that may use `ThinkingOrb`**, and it is the case the orb was
 * drawn for: it marks a model reasoning, not a network request in flight. Every other "please wait"
 * in this feature — the composer's Stop, the pending turn's activity strip — uses the run log's own
 * marks instead. If a future refactor wants a spinner somewhere else in `components/chat`, it wants
 * a different glyph.
 *
 * Open while the tokens land, shut the moment they stop. That is not a compromise between two
 * behaviours, it is the two behaviours the content actually has: live, the reasoning is the only
 * evidence anything is happening and hiding it leaves a blank screen; finished, it is a transcript
 * of a monologue nobody asked for, sitting above the answer they did. The fold flips exactly once,
 * on the transition, so a user who opened it by hand while it ran is not slammed shut under the
 * cursor — `manual` records that they took the decision back.
 */
export function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(live);
  /** Set once the user touches the fold, after which this component stops deciding for them. */
  const manual = useRef(false);
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!manual.current) setOpen(live);
  }, [live]);

  // Follow the tail the way a terminal does — reasoning arrives faster than it can be read, and a
  // box pinned to the top of a monologue shows the same four lines for thirty seconds.
  useEffect(() => {
    const el = tailRef.current;
    if (el && open) el.scrollTop = el.scrollHeight;
  }, [text, open]);

  if (!text.trim()) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]">
      <button
        type="button"
        onClick={() => {
          manual.current = true;
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        {live && <ThinkingOrb size="sm" />}
        <span className="text-[12px] text-[var(--cf-text-muted)]">
          {live ? t("chat.thinkingLive") : t("chat.thinkingDone")}
        </span>
      </button>
      {open && (
        <div
          ref={tailRef}
          // Selectable, and italic: the reasoning is quotable evidence when an answer goes wrong,
          // and the slant is what keeps it from reading as part of the reply directly beneath it.
          className="max-h-64 select-text overflow-auto border-t border-[var(--cf-border)] px-3 py-2 text-[12px] italic leading-[1.6] text-[var(--cf-text-muted)]"
        >
          <span className="whitespace-pre-wrap">{text}</span>
        </div>
      )}
    </div>
  );
}
