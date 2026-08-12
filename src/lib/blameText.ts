import type { TranslationKey } from "./i18n/translations";
import type { BlameHunkInfo } from "../types/domain";

/** The component's own `t`, never `translate`. See `blameLabel`. */
type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * The longest a commit summary is allowed to be inside an annotation.
 *
 * Not a style choice — a cost one. The annotation is injected text riding the end of a code line, so
 * whatever it contains is added to that line's *measured width*: a long subject on an already-long
 * line grows the editor's horizontal scrollbar, which is the one unavoidable cost of drawing the
 * label this way. Sixty characters is roughly a conventional-commit subject, so the clamp almost
 * never fires on a well-kept history and always fires on the pasted-paragraph commit message that
 * would otherwise double the file's scroll width.
 */
const SUMMARY_MAX = 60;

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/**
 * How long ago a commit was, in words — "just now", "3 hours ago", "2 years ago".
 *
 * **Why this is not `relativeTime`** (`components/api/settingsChrome.tsx`). That one takes an **ISO
 * string** and a four-label bag, and its largest bucket is days: a line last touched two years ago
 * would render as "730d ago", which is a number nobody converts in their head. Blame is the only
 * surface in this app measuring distances in months and years, because it is the only one looking at
 * a repository's whole history rather than at something that happened during the session — every
 * existing caller of `relativeTime` (agent tasks, story batches, conflict rows, collaboration
 * presence) reports on minutes and hours. It also needs *singular* wordings, because `n === 1` is
 * reachable here and reads wrong as "1 minutes ago"; `render` does plain `{n}` substitution with no
 * plural rules (`state/languageStore.ts`), so the buckets below carry the plural rule themselves —
 * `daysAgo`, `weeksAgo` and `monthsAgo` are only ever reached with `n >= 2`, and the units where 1 is
 * reachable have their own key.
 *
 * Widening `relativeTime`'s label bag instead would change what its six existing call sites render,
 * for the benefit of one that wants a different job done. The cross-reference in both directions is
 * what should keep the two from drifting into the same thing. (There is a third, private copy in
 * `components/ai/AiPanel.tsx`; reconciling all three is a separate cleanup, not this one.)
 *
 * Epoch **seconds**, matching `BlameHunkInfo.timestamp` and `CommitInfo.timestamp`. A zero or future
 * stamp collapses to "just now" rather than to a negative distance.
 */
export function blameAge(epochSeconds: number, t: Translate): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - epochSeconds));
  if (seconds < 45) return t("blame.justNow");
  if (seconds < MINUTE * 2) return t("blame.minuteAgo");
  if (seconds < HOUR) return t("blame.minutesAgo", { n: Math.round(seconds / MINUTE) });
  if (seconds < HOUR * 2) return t("blame.hourAgo");
  if (seconds < DAY) return t("blame.hoursAgo", { n: Math.round(seconds / HOUR) });
  const days = Math.round(seconds / DAY);
  if (days <= 1) return t("blame.yesterday");
  if (days < 14) return t("blame.daysAgo", { n: days });
  if (days < 60) return t("blame.weeksAgo", { n: Math.round(days / 7) });
  if (days < 365) return t("blame.monthsAgo", { n: Math.round(days / 30) });
  const years = Math.round(days / 365);
  return years <= 1 ? t("blame.yearAgo") : t("blame.yearsAgo", { n: years });
}

/** First line only, trimmed, clamped — a commit whose subject runs long, or whose message the author
 *  wrote as one paragraph, must not become the width of the file. */
function clampSummary(summary: string): string {
  const firstLine = summary.split("\n", 1)[0].trim();
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine;
}

/**
 * `You, 3 hours ago • Fix the retry budget` — the annotation's whole text.
 *
 * `•` is literal punctuation rather than a key, the same call the two existing `{ago}` wrappers make
 * (`api.collab.connectedAgo`): a separator that is identical in both languages is not a translation,
 * and making it one invites a translator to "fix" it into something that no longer aligns column-wise
 * with the copy in the status bar.
 *
 * **Takes the live `t`, never `translate`.** `translate` reads the language store without subscribing,
 * which is right for one-shot generation and wrong for anything rendered — and this string is handed
 * to Monaco as a decoration, so nothing re-derives it on its own: a label built from `translate` would
 * sit in the editor in the previous language until the caret moved. Passing `t` in means the effect
 * that draws the decoration has the language in its dependency chain.
 */
export function blameLabel(hunk: BlameHunkInfo, t: Translate): string {
  if (hunk.uncommitted) return t("blame.uncommitted");
  const who = hunk.is_me ? t("blame.you") : hunk.author_name;
  const ago = blameAge(hunk.timestamp, t);
  const summary = clampSummary(hunk.summary);
  return summary ? `${who}, ${ago} • ${summary}` : `${who}, ${ago}`;
}

/**
 * The same thing without the summary, for the status bar.
 *
 * The bar carries the short form because it is the copy that is always on screen: the annotation sits
 * at the end of a line that can be scrolled out of view horizontally, and the bar cannot be. It is
 * also the one place in the app whose only elastic element is the branch name, so a second
 * variable-length string there has to be as short as it can be and still answer the question.
 */
export function blameStatusText(hunk: BlameHunkInfo, t: Translate): string {
  if (hunk.uncommitted) return t("blame.uncommitted");
  const who = hunk.is_me ? t("blame.you") : hunk.author_name;
  return `${who}, ${blameAge(hunk.timestamp, t)}`;
}
