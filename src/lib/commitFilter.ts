/**
 * The graph's scope and filters — what `list_commits_page` walks, as opposed to the filter box,
 * which narrows what is already loaded (`matchesCommit`).
 */

/** Which history: every branch and remote, the checked-out branch alone, or every branch's own
 *  line with merged-in work folded into its merge (`git log --first-parent`). */
export type CommitScope = "all" | "current" | "firstParent";

export interface CommitFilter {
  scope: CommitScope;
  /** Name or e-mail, any part, any case. */
  author: string;
  /** `YYYY-MM-DD`, both ends inclusive, in local time. Empty for open-ended. */
  since: string;
  until: string;
  /** A repository-relative file or folder. */
  path: string;
}

export const NO_COMMIT_FILTER: CommitFilter = { scope: "all", author: "", since: "", until: "", path: "" };

/** The backend's `LogFilter`. */
export interface LogFilter {
  first_parent: boolean;
  path: string | null;
  author: string | null;
  since: number | null;
  until: number | null;
}

/** Seconds since the epoch at the start (or, with `endOfDay`, the last second) of a local date. */
export function dayToSeconds(day: string, endOfDay = false): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return null;
  const date = endOfDay
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59)
    : new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

export function logFilterOf(filter: CommitFilter): LogFilter | null {
  const out: LogFilter = {
    first_parent: filter.scope === "firstParent",
    path: filter.path.trim().replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "") || null,
    author: filter.author.trim() || null,
    since: dayToSeconds(filter.since),
    until: dayToSeconds(filter.until, true),
  };
  return out.first_parent || out.path || out.author || out.since !== null || out.until !== null ? out : null;
}

/** How many of the narrowing filters are set — the badge on the filter button. The scope is not
 *  counted: it has its own control and always says what it is. */
export function narrowingCount(filter: CommitFilter): number {
  return [filter.author.trim(), filter.path.trim(), filter.since.trim() || filter.until.trim()].filter(Boolean).length;
}

/** Anything that makes the loaded history something other than the whole of it. */
export function commitFilterActive(filter: CommitFilter): boolean {
  return filter.scope !== "all" || narrowingCount(filter) > 0;
}
