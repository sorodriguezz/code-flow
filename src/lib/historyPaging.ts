/**
 * When a walk through a paged history is finished, and when it only looks finished.
 *
 * The AI panel's history is read a page at a time and then drained to the end in the background —
 * see `jobsStore.drainHistory`. Deciding "is there more?" from a page is one line of arithmetic and
 * two ways to get it wrong, both of which end the walk early and leave older runs unreachable for
 * the rest of the session, with nothing on screen to say so.
 *
 * The two:
 *
 * 1. **A short page means the end.** Reliable, and the primary signal.
 * 2. **A full page that added nothing new.** The old rule read this as the end too. It is not: an
 *    offset walk over a table that is being written to and deleted from can hand back rows the
 *    caller already holds — delete fifty rows above the cursor and the next page *is* the previous
 *    one. Ending there is how the tail of the history silently disappears.
 *
 * So a full page keeps the walk alive whether or not it was all duplicates, and `repeats` is what
 * stops it going round forever if a backend really does keep serving one page: after
 * `MAX_REPEATS` consecutive pages that add nothing, the walk gives up. It cannot loop.
 *
 * Pulled out of the store rather than left inline because it is the part that can be wrong, it is
 * pure, and every way it fails is invisible.
 */

/** How many consecutive all-duplicate pages the walk tolerates before it concludes it is stuck. */
export const MAX_REPEATS = 3;

export interface PageOutcome {
  /** Whether to ask for another page. */
  hasMore: boolean;
  /** Consecutive pages that added nothing, carried to the next call. */
  repeats: number;
  /** Where the next page starts. */
  offset: number;
}

export function advancePage(input: {
  /** Rows the page requested. */
  pageSize: number;
  /** Rows it actually returned. */
  returned: number;
  /** How many of those the caller did not already hold. */
  fresh: number;
  /** The offset this page was read at. */
  offset: number;
  /** `repeats` from the previous call, or 0 to start. */
  repeats: number;
}): PageOutcome {
  const { pageSize, returned, fresh, offset, repeats } = input;

  // The walk always moves forward by what it was handed, even when every row was a duplicate —
  // otherwise a shifted window would re-read the same offset for ever.
  const nextOffset = offset + returned;

  // A short page is the end of the table, and it is the only answer that needs no caveat.
  if (returned < pageSize) {
    return { hasMore: false, repeats: 0, offset: nextOffset };
  }

  const nextRepeats = fresh === 0 ? repeats + 1 : 0;
  return {
    hasMore: nextRepeats < MAX_REPEATS,
    repeats: nextRepeats,
    offset: nextOffset,
  };
}
