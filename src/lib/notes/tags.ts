/**
 * Tags, on the way in and out of the database.
 *
 * A note's tags are stored as a JSON array in one column (see the `notes` table comment for why
 * that beats a join table here), so exactly two functions in the app touch that string: the store's
 * `toNote` on the way in and its save path on the way out. Everything downstream deals in
 * `string[]`.
 */

/**
 * A tag as it is stored: trimmed, lower-cased, inner whitespace turned into a hyphen.
 *
 * Case-folded because `Deploy` and `deploy` are the same tag by any reading a user would give
 * them, and a sidebar that lists both is a sidebar reporting a typo as a category. Hyphenated for
 * the same reason `#code review` reads as two tags anywhere else that has tags.
 *
 * The leading `#` is dropped if the user typed one — that is how tags are written in prose, and
 * refusing it would be pedantry.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The stored JSON as an array. Never throws: a hand-edited row must not blank the sidebar. */
export function parseTags(json: string): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    // Filtered *and* de-duplicated here rather than trusting the writer, because this is also the
    // path a row restored from a backup or written by an older version comes in on.
    return dedupe(parsed.filter((t): t is string => typeof t === "string").map(normalizeTag));
  } catch {
    return [];
  }
}

/** The array as stored JSON, normalized and de-duplicated on the way. */
export function serializeTags(tags: string[]): string {
  return JSON.stringify(dedupe(tags.map(normalizeTag)));
}

function dedupe(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Every tag in the workspace with how many notes carry it, most-used first then alphabetical.
 *
 * Counted in the frontend rather than in SQL — see the `notes` table comment. The list is already
 * in memory for the sidebar, so this is one pass over it; the alternative was a second table and a
 * join on every read.
 */
export function tagCounts(notes: { tags: string[] }[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * A stable colour for a tag, as an OKLCH hue.
 *
 * Derived from the name rather than stored, so a tag is the same colour everywhere it appears
 * without anyone having to pick one — and so two notes sharing a tag are visibly related in a
 * gallery. Lightness and chroma are fixed and modest; only the hue moves, which is what keeps
 * fifteen chips on screen from reading as a paint chart.
 */
export function tagHue(tag: string): number {
  let hash = 0;
  for (let at = 0; at < tag.length; at++) {
    // The usual 31-shift, kept in 32-bit range so long tag names don't lose precision.
    hash = (hash * 31 + tag.charCodeAt(at)) | 0;
  }
  return Math.abs(hash) % 360;
}
