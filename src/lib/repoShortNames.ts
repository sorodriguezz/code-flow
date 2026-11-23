/**
 * Display names for repositories in a list, shortened by the dotted prefix they share with their
 * siblings: `Dev.Agenda.Node.DataSync` next to `Dev.Agenda.Node.Core` reads «DataSync» and «Core».
 *
 * The Inbox printed the full name under every row, and in a workspace whose repositories all start
 * the same way the part that tells them apart was the last word of a long grey line (user ask,
 * 2026-11-23). The full name stays in the tooltip. An organisation path (`org/project/Name`) is
 * dropped first: a review from a link carries it, and it is the same for every row of that
 * organisation. Two names that would shorten to the same text keep one more segment each, until
 * they differ — «Node.Core» and «Agenda.Core» rather than two «Core».
 */
export function shortRepoNames(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set(names)].filter(Boolean);
  const segments = new Map(unique.map((name) => [name, (name.split("/").pop() ?? name).split(".")]));
  // How many leading segments of each name it shares with its closest sibling — never all of them.
  const cut = new Map<string, number>();
  for (const name of unique) {
    const own = segments.get(name)!;
    let best = 0;
    for (const other of unique) {
      if (other === name) continue;
      const theirs = segments.get(other)!;
      let k = 0;
      while (k < own.length && k < theirs.length && own[k] === theirs[k]) k++;
      best = Math.max(best, k);
    }
    cut.set(name, Math.min(best, own.length - 1));
  }
  const shortOf = (name: string) => segments.get(name)!.slice(cut.get(name)).join(".");
  // Widen colliding names one segment at a time; each pass widens at least one, so it ends.
  for (;;) {
    const byShort = new Map<string, string[]>();
    for (const name of unique) byShort.set(shortOf(name), [...(byShort.get(shortOf(name)) ?? []), name]);
    const clashing = [...byShort.values()].filter((group) => group.length > 1).flat().filter((name) => cut.get(name)! > 0);
    if (clashing.length === 0) break;
    for (const name of clashing) cut.set(name, cut.get(name)! - 1);
  }
  return new Map(unique.map((name) => [name, shortOf(name)]));
}
