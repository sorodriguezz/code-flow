import { useT } from "../../state/languageStore";

/** What a conversation row's dot is saying. `read` draws nothing — see the note below. */
export type ConversationStatus = "read" | "unread" | "running" | "failed";

/**
 * The mark before a conversation's engine glyph.
 *
 * Three visible states and one invisible one:
 *
 * - **read** — nothing at all. The answer has been seen, and a row in its ordinary state should
 *   carry no mark: a list where every row has a dot has no signal in it, only decoration.
 * - **unread** — a solid dot in the accent colour. Something landed here that has not been looked
 *   at.
 * - **running** — the same solid dot, pulsing. A turn is in flight, which is the other honest sense
 *   of "pending", and it resolves into `unread` on its own when the answer arrives.
 * - **failed** — a **ring**, in the danger colour.
 *
 * # Why failed is a ring and not just a red dot
 *
 * Because the accent is the user's to choose, and one of the ten choices is `rose`: `#fb7185` in
 * dark mode against a danger token of `#f87171`. Those are the same colour to any eye. A design
 * that separated these two states by hue alone would be correct in nine themes and silently wrong
 * in the tenth, which is the worst possible distribution for a mark whose entire job is to be
 * unambiguous at a glance.
 *
 * So the states differ by **fill**, which no theme can collapse: solid means "there is something
 * here", hollow means "something went wrong". It survives a rose accent, a monochrome screen and
 * red-green colour blindness, and the colours are then free to reinforce it rather than carry it
 * alone. The ring is also drawn a pixel larger, so the two differ in size as well as in fill.
 *
 * Every state carries a `title`, because a coloured dot is a convention the user has to learn once
 * and a tooltip is how they learn it.
 */
export function StatusDot({ status }: { status: ConversationStatus }) {
  const t = useT();

  if (status === "read") {
    // A spacer, not nothing: the glyphs after it must line up whether or not a row is marked, and a
    // list whose icons shift left when a conversation is read is a list that flickers as you use it.
    return <span aria-hidden className="w-[9px] shrink-0" />;
  }

  if (status === "failed") {
    return (
      <span
        title={t("chat.statusFailed")}
        className="h-[9px] w-[9px] shrink-0 rounded-full border-[1.5px] border-[var(--cf-danger)]"
      />
    );
  }

  return (
    <span
      title={status === "running" ? t("chat.statusRunning") : t("chat.statusUnread")}
      className={`h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--cf-accent-fill)] ${
        status === "running" ? "animate-pulse" : ""
      }`}
    />
  );
}
