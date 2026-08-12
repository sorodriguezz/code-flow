import { useState, type CSSProperties } from "react";
import { riseDelay } from "./rise";

/**
 * How many rows a capped list shows before its first reveal, and how many each reveal adds.
 *
 * Ten is what a sidebar section can spend without pushing the sections under it off screen, which is
 * the whole complaint this exists for: a repository with two hundred closed pull requests rendered two
 * hundred rows, and everything below Pull Requests became a scroll away. The same number for the first
 * page and for every reveal after it, so "click again" is always the same amount of list rather than a
 * page size that grows under the pointer.
 */
export const PAGE = 10;

/** What a capped list needs from this module: how far to slice, and what the control should say. */
export interface Incremental {
  /** Rows to render — `list.slice(0, shown)`. Never larger than `total`. */
  shown: number;
  /** Rows still hidden. Zero means render no control at all. */
  hidden: number;
  /** Reveals the next page. Idempotent past the end, because `shown` is clamped against `total`. */
  more: () => void;
}

/**
 * A list that arrives ten rows at a time, and stays where the user left it.
 *
 * `identity` is a separate argument and deliberately **not** the array being sliced, because in this
 * app the array is replaced constantly without its contents meaning anything new: `refreshBranches`
 * and `refreshStashes` both `set()` a freshly allocated array, and the filesystem watcher calls them on
 * every burst of writes. Resetting on the reference would collapse a list the user had opened to forty
 * rows back to ten every time a build touched a file, or every time the Pull Requests header's refresh
 * button was pressed. What makes a list a *different* list is the repository it came from, so that is
 * what gets passed — the same key `EditorView` uses to throw away the previous repo's open tabs.
 *
 * The reset happens during render rather than in an effect, for the reason `EditorView` gives for the
 * same choice: an effect runs after the paint that already used the stale count, so clicking from a
 * repository with fifty branches to one with three would show a "show 10 more" control for a frame
 * before removing it. Assigning during render costs one discarded render pass and paints once.
 *
 * A list that *shrinks* below the count is clamped, not written back. Dropping four stashes renumbers
 * the list under a count the user chose, and forgetting that choice would charge them four clicks again
 * the next time the list grows. `hidden` reaches zero on its own, so the control disappears while the
 * intent survives.
 */
export function useIncremental(total: number, identity: string | null): Incremental {
  const [state, setState] = useState({ identity, shown: PAGE });
  // Read before the write, so this render already uses the reset value; React re-runs the component
  // immediately and the intermediate result is never painted.
  const chosen = state.identity === identity ? state.shown : PAGE;
  if (state.identity !== identity) setState({ identity, shown: PAGE });

  const shown = Math.min(chosen, total);
  return {
    shown,
    hidden: Math.max(total - shown, 0),
    more: () => setState({ identity, shown: chosen + PAGE }),
  };
}

/**
 * The `cf-rise` style for the row at `at` in a list revealed a page at a time.
 *
 * `riseDelay` caps its stagger at eight steps, which is right for a list that arrives whole and wrong
 * for one that arrives in batches: every index from eight up gets the identical 360ms, so a revealed
 * batch of ten would sit invisible for 360ms after the click and then land as a single block — a
 * visible dead pause, and not a stagger. Re-basing on the row's position *within its page* gives each
 * batch the same sweep the first ten got.
 *
 * The modulo is over the absolute index, so a row's delay does not change when rows are appended after
 * it. That matters more than it looks: the delay feeds `animation-delay`, and raising it on an
 * animation that has already finished moves its effective current time back into the delay phase, where
 * the `backwards` fill pins the row at `opacity: 0` — i.e. re-indexing a visible row makes it blink.
 * Appending never re-indexes.
 */
export function pageDelay(at: number): CSSProperties {
  return riseDelay(at % PAGE);
}
