import { useT } from "../../state/languageStore";

/** What a conversation row's dot is saying. */
export type ConversationStatus = "read" | "unread" | "running" | "failed";

/**
 * The mark before a conversation's engine glyph.
 *
 * One dot, always drawn, that the state fills:
 *
 * - **read** — the dot empty: a hollow ring in a faint ink. The answer has been seen.
 * - **unread** — the dot filled in the accent colour. Something landed here that has not been
 *   looked at.
 * - **running** — the fill pulsing over the empty ring. A turn is in flight, which is the other
 *   honest sense of "pending", and it resolves into `unread` on its own when the answer arrives.
 * - **failed** — a **ring** a size up, in the danger colour.
 *
 * # Why read is an empty dot and not nothing
 *
 * It used to draw nothing, on the argument that a list where every row has a dot has no signal in
 * it. The user had it changed (2026-10-02): with nothing at rest, a turn starting or finishing made a
 * dot appear out of nowhere beside the title — something popping into the row, rather than the row
 * changing state. The fill still carries the signal; the empty ring is only the place it lands, so
 * the mark changes in place instead of arriving.
 *
 * # Why failed is a ring and not just a red dot
 *
 * Because the accent is the user's to choose, and one of the ten choices is `rose`: `#fb7185` in
 * dark mode against a danger token of `#f87171`. Those are the same colour to any eye. A design
 * that separated unread from failed by hue alone would be correct in nine themes and silently wrong
 * in the tenth, which is the worst possible distribution for a mark whose entire job is to be
 * unambiguous at a glance.
 *
 * So those two differ by **fill**, which no theme can collapse: solid means "there is something
 * here", and the failed ring is hollow. It survives a rose accent, a monochrome screen and red-green
 * colour blindness. From the empty dot at rest it differs three ways at once — red rather than a
 * faint grey, a heavier stroke, two pixels larger — so the two rings are not one mark either.
 *
 * Every state but read carries a `title`, because a coloured dot is a convention the user has to
 * learn once and a tooltip is how they learn it. The empty dot says nothing worth a tooltip.
 */
export function StatusDot({ status }: { status: ConversationStatus }) {
  const t = useT();

  const title =
    status === "failed"
      ? t("chat.statusFailed")
      : status === "running"
        ? t("chat.statusRunning")
        : status === "unread"
          ? t("chat.statusUnread")
          : undefined;

  return (
    // A fixed slot, the size of the largest mark, so the glyphs after it line up in every state: a
    // list whose icons shift when a conversation changes state is a list that flickers as you use it.
    <span title={title} aria-hidden={title ? undefined : true} className="flex h-[9px] w-[9px] shrink-0 items-center justify-center">
      {status === "failed" ? (
        <span className="h-[9px] w-[9px] rounded-full border-[1.5px] border-[var(--cf-danger)]" />
      ) : (
        // The ring is an inset shadow, under the fill: a solid dot covers it whole, and while the
        // fill pulses the empty dot stays visible beneath it — it is never not there.
        <span className="relative h-[7px] w-[7px] rounded-full shadow-[inset_0_0_0_1px_var(--cf-text-faint)]">
          {status !== "read" && (
            <span
              className={`absolute inset-0 rounded-full bg-[var(--cf-accent-fill)] ${
                status === "running" ? "animate-pulse" : ""
              }`}
            />
          )}
        </span>
      )}
    </span>
  );
}
