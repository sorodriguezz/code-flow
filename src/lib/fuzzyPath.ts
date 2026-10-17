/** The quick-open ranking, shared by the file palette and the chat's `@` mentions. */

/** Subsequence match, the way editors' quick-open works: "edvw" finds `EditorView.tsx`. Returns
 * a score (lower is better) or `null` when the query doesn't fit at all. */
export function fuzzyScore(path: string, query: string): number | null {
  if (!query) return 0;
  const haystack = path.toLowerCase();
  const name = haystack.slice(haystack.lastIndexOf("/") + 1);

  // A plain substring of the *filename* is what the user almost always means, so it outranks any
  // subsequence spread across the directories.
  const inName = name.indexOf(query);
  if (inName >= 0) return inName;
  const inPath = haystack.indexOf(query);
  if (inPath >= 0) return 100 + inPath;

  let cursor = 0;
  let gaps = 0;
  for (const char of query) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return null;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 1000 + gaps;
}

/** The best `max` of `paths` for `query`, best first — shorter paths win a tie. */
export function rankPaths(paths: readonly string[], query: string, max: number): string[] {
  const needle = query.trim().toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = fuzzyScore(path, needle);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return scored.slice(0, max).map((s) => s.path);
}
