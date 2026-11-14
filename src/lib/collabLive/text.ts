/**
 * Text arithmetic of live documents, kept apart from Monaco and Yjs so it is tested directly.
 *
 * Offsets are UTF-16 code units, the unit both Monaco's `rangeOffset` and `Y.Text` count in.
 */

/** One replacement over a text: remove `remove` units at `index`, put `insert` there. */
export interface TextEdit {
  index: number;
  remove: number;
  insert: string;
}

/**
 * The smallest single replacement that turns `before` into `after`, by common prefix and suffix, or
 * `null` when they are equal.
 *
 * What a whole-buffer replacement (a reload from disk after an agent wrote the file, a merge of what
 * the session holds) becomes before it reaches the shared document: «delete everything, insert
 * everything» would erase whatever another person typed in the same instant, and would move every
 * remote cursor to the end. One region is not a true diff, but changes from an agent's turn or a
 * pulled file tend to be one region, and the cost of a wider region is only a wider replace.
 *
 * The cut never splits a surrogate pair, so an emoji is never half-replaced.
 */
export function minimalEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end))) end--;
  return { index: start, remove: before.length - start - end, insert: after.slice(start, after.length - end) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** A Yjs text delta, as `Y.YTextEvent.delta` gives it. */
export type Delta = { retain?: number; insert?: string | object; delete?: number }[];

/**
 * A Yjs delta as replacements over the text **before** it: every `index` counts in the old text, so
 * the whole list can go to Monaco's `applyEdits` in one call, which reads all ranges against the
 * model as it was. A delete followed by an insert at the same place is one replacement.
 */
export function deltaToEdits(delta: Delta): TextEdit[] {
  const edits: TextEdit[] = [];
  let at = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      at += op.retain;
    } else if (op.delete !== undefined) {
      const last = edits[edits.length - 1];
      if (last && last.index + last.remove === at && last.insert === "") last.remove += op.delete;
      else edits.push({ index: at, remove: op.delete, insert: "" });
      at += op.delete;
    } else if (typeof op.insert === "string") {
      const last = edits[edits.length - 1];
      if (last && last.index + last.remove === at) last.insert += op.insert;
      else edits.push({ index: at, remove: 0, insert: op.insert });
    }
  }
  return edits;
}

/** Applies edits whose offsets all count in `text` itself (what `deltaToEdits` returns). */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = "";
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.index - b.index)) {
    out += text.slice(at, edit.index) + edit.insert;
    at = edit.index + edit.remove;
  }
  return out + text.slice(at);
}

/**
 * The Yjs client id a document's first content is written under, from that content alone.
 *
 * Two people who open the same file at the same moment both find the document empty and both seed
 * it from their disk. Written under the same client id, the same text is the *same* Yjs items, which
 * merge into one copy instead of two. (Different texts get different ids, so they can never be
 * mistaken for each other's items: the worst case is both texts in the buffer, visible, instead of a
 * corrupt document.) Kept in 1..2^31-1. A person's own client id is drawn at random per document, so
 * colliding with a seed is as likely as two people colliding with each other.
 */
export function seedClientId(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 0x7ffffffe) + 1;
}
