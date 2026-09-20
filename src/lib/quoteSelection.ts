/**
 * Turning a selected passage into something a composer can hold.
 *
 * Selecting text and acting on it is the one gesture a transcript owes the reader that a plain
 * scroll view does not: a long answer has one paragraph in it you want to argue with, and without
 * this the only way to point at that paragraph is to retype it, or to say "the third bullet" and
 * hope.
 *
 * Two destinations, and they are quoted differently on purpose — see each function.
 */

/**
 * The passage as a Markdown quote, ready for a question to be typed under it.
 *
 * Markdown rather than any invented marker, because every engine here reads Markdown and none of
 * them reads ours. `> ` on each line is the one convention that means "this is the part I am
 * pointing at" to all six, including the small local models that ignore subtler framing entirely.
 *
 * Blank lines inside the passage keep their `>` so the quote stays one block: a bare blank line
 * would end the quote and leave the rest of the passage reading as the user's own words.
 *
 * It ends with a blank line and nothing else. No lead-in sentence is added — "sobre esto:" would be
 * this app putting words in the user's mouth, and would be wrong half the time anyway, since a
 * passage can just as easily be quoted from the user's own earlier message as from an answer.
 */
export function quoteForReply(passage: string): string {
  const body = passage.trim();
  if (!body) return "";
  return `${body
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n")}\n\n`;
}

/**
 * Adds a quote to whatever is already in the composer.
 *
 * Appended, never replacing: a user who has typed half a question and *then* goes to quote the
 * paragraph they are asking about has not asked for their draft to be thrown away. Separated by a
 * blank line, so the quote starts its own block rather than continuing the sentence in progress.
 */
export function appendQuote(draft: string, passage: string): string {
  const quote = quoteForReply(passage);
  if (!quote) return draft;
  const existing = draft.trimEnd();
  return existing ? `${existing}\n\n${quote}` : quote;
}

/**
 * The passage on its own, for a conversation that does not exist yet.
 *
 * **Not quoted**, and that is the difference from {@link quoteForReply}. A quote marks one part of
 * a message as the part being pointed at, which needs something else in the message to be pointed
 * at *from*. In a brand-new chat the passage is the whole message and there is nothing to
 * distinguish it from — so `>` would only tell the model that this text came from somewhere it
 * cannot see, which is exactly the fact that is least useful to it.
 */
export function passageForNewChat(passage: string): string {
  const body = passage.trim();
  return body ? `${body}\n\n` : "";
}
