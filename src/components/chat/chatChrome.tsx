import { useState } from "react";
import { Coins } from "lucide-react";
import { useLanguageStore } from "../../state/languageStore";

/**
 * The chat workspace's shared visual vocabulary — the counterpart of `notesChrome`,
 * `diagramsChrome` and `dbChrome`, and here for exactly their reason: the sidebar, the transcript
 * and the composer are three files that have to agree about what a row looks like, how wide the
 * reading column is and how a timestamp is spelled, and three files each deciding for themselves is
 * how those three drift apart over a release.
 *
 * The one decision worth arguing for out loud is `READING_COLUMN`. Every other surface in this app
 * is a panel that fills whatever it is given — the AI panel, the notes editor, the diff. This one is
 * a *page*: a transcript is prose, prose is read left to right, and a line of prose that runs the
 * full width of a 34" monitor is one the eye loses its place in between the right edge and the next
 * line's left. 740px at this font size lands around 90 characters, which is the upper end of the
 * range typography has agreed on for a century. The column is centred rather than left-aligned
 * against the sidebar so that widening the window makes the reading experience *unchanged* rather
 * than lopsided — which is the whole promise of a reading surface, and the thing a dense IDE panel
 * deliberately does not make.
 */
export const READING_COLUMN = "mx-auto w-full max-w-[740px]";

/** The side gutter the column keeps off the window edge, and off the sidebar's seam. Split out from
 *  `READING_COLUMN` because the composer wants the same gutter with a different vertical rhythm. */
export const COLUMN_GUTTER = "px-6";

/** A row in the conversation sidebar: hit area, hover and selection in one place, because a pinned
 *  row and an ordinary one have to read as the same list. Mirrors `notesChrome.ROW`. */
export const ROW =
  "group/row flex w-full items-center gap-2 rounded-lg px-2 py-[7px] text-left text-[13px] transition-colors";

export const ROW_IDLE = "text-[var(--cf-text)] hover:bg-[var(--cf-hover)]";

export const ROW_ACTIVE = "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]";

/** An icon button in a header or toolbar — shape and hover only, no colour of its own, so a button
 *  that carries one does not have to out-specify the muted default in the cascade. */
export const ICON_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:cursor-not-allowed disabled:opacity-30";

/** The app's own language decides how timestamps read, not the OS locale — otherwise a chat in a
 *  Spanish UI would print English dates. Lifted verbatim from `AiPanel` so the two transcripts
 *  cannot disagree about the same instant. */
export const useLocale = () => (useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US");

/**
 * How long a turn took, in the largest unit that still reads as a duration.
 *
 * Past a minute the seconds count stops being one — an agentic turn can run for ten of them, and
 * "616.7s" makes the reader do the division. Mirrors `formatElapsed` in `AiRunLog`, so the timer
 * that ran during the turn and the stamp left behind afterwards agree on how to spell the same span.
 */
export function formatResponseTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${(ms / 1000).toFixed(1)}s`;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (total < 3600) return `${Math.floor(total / 60)}:${pad(total % 60)}`;
  return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Parses a stored RFC 3339 stamp, tolerating the `undefined` of turns recorded before timestamps
 *  were kept and the (theoretical) unparseable value rather than rendering "Invalid Date". */
export function parseStamp(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Clipboard-with-a-tick, the idiom every copy button in this app uses. Lifted out of `AiPanel`
 *  rather than re-implemented, so the tick lasts the same 1.5s everywhere. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return [copied, copy];
}

/**
 * The mark on a control that spends money in a way the control's own verb does not suggest.
 *
 * Regenerate, edit-and-resend and branch all read like local edit operations — three buttons that
 * look exactly like undo. None of them is. **No CLI here can rewind a session**, so each one is
 * really "start a fresh engine session and replay the whole prefix as context": cheap to store,
 * a full re-read of the conversation to run, on a metered plan, every time. That cost is otherwise
 * completely invisible — the button is instant, the spinner looks like any other turn, and the only
 * place it shows up is the bill at the end of the month.
 *
 * So it is marked at the point of decision rather than explained in a tooltip nobody opens. A coin
 * and a count of the turns about to be re-sent, in the muted ink, is enough: it does not stop
 * anyone, it just stops the action from being free-looking when it is not.
 */
export function CostChip({ turns, title }: { turns: number; title: string }) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] leading-[15px] text-[var(--cf-text-muted)]"
    >
      <Coins size={9} />
      {turns}
    </span>
  );
}
