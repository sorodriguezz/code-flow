/**
 * The smallest single replacement that turns `before` into `after`: the common prefix and suffix
 * kept, the middle swapped — as `[start, end)` offsets into `before` and the text that replaces them.
 *
 * For writing a new version of a document into an editor that is showing the old one. Replacing the
 * whole model moves the caret to the end and scrolls with it; replacing only what differs leaves
 * both where they were whenever the change is somewhere else (a box dragged rewrites one comment
 * line at the bottom, not the table being typed at the top), and it is the edit ⌘Z then takes back.
 */
export function smallestChange(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  // Never split a surrogate pair: a boundary between the halves would hand the editor half a character.
  const low = (text: string, at: number) => at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text[at]);
  while (start > 0 && (low(before, start) || low(after, start))) start -= 1;
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}
