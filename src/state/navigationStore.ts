import { create } from "zustand";
import type { MainView } from "./uiStore";

export interface NavEntry {
  view: MainView;
  projectId: string | null;
}

interface NavigationState {
  history: NavEntry[];
  index: number;
  /** Set right before applying a back/forward jump so the resulting view/project change
   * doesn't get pushed onto the stack as if the user had navigated there manually. */
  suppressPush: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  push: (entry: NavEntry) => void;
  /** `accept` says which entries may be landed on — see [`historyStep`]. */
  back: (accept?: (entry: NavEntry) => boolean) => NavEntry | null;
  forward: (accept?: (entry: NavEntry) => boolean) => NavEntry | null;
}

function sameEntry(a: NavEntry | undefined, b: NavEntry): boolean {
  return !!a && a.view === b.view && a.projectId === b.projectId;
}

/**
 * Where a back/forward jump lands: the nearest entry in that direction that `accept` allows and
 * that would change something — `null` when there is none, and then nothing moves.
 *
 * Entries are skipped rather than refused because the history outlives what it names. It records
 * every workspace the window has been in, and ⌥← after switching workspace used to replay a project
 * from the previous one: `setActiveProject` took an id this workspace does not hold, the window said
 * "no project open", and the bad id was saved as where it opens next. Walking over the entries that
 * cannot be shown keeps the keys meaning "where I was *here*".
 *
 * An entry identical to the current one is skipped too: landing on it would change nothing on
 * screen, and the `suppressPush` it sets would then swallow the next real navigation instead.
 */
export function historyStep(
  history: NavEntry[],
  index: number,
  direction: "back" | "forward",
  accept: (entry: NavEntry) => boolean = () => true,
): number | null {
  const current = history[index];
  const step = direction === "back" ? -1 : 1;
  for (let at = index + step; at >= 0 && at < history.length; at += step) {
    const entry = history[at];
    if (sameEntry(current, entry)) continue;
    if (accept(entry)) return at;
  }
  return null;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  history: [],
  index: -1,
  suppressPush: false,
  canGoBack: false,
  canGoForward: false,

  push: (entry) => {
    const { history, index, suppressPush } = get();
    if (suppressPush) {
      set({ suppressPush: false });
      return;
    }
    if (sameEntry(history[index], entry)) return;
    const trimmed = history.slice(0, index + 1);
    const next = [...trimmed, entry];
    set({ history: next, index: next.length - 1, canGoBack: next.length > 1, canGoForward: false });
  },

  back: (accept) => {
    const { history, index } = get();
    const newIndex = historyStep(history, index, "back", accept);
    if (newIndex === null) return null;
    set({ index: newIndex, suppressPush: true, canGoBack: newIndex > 0, canGoForward: true });
    return history[newIndex];
  },

  forward: (accept) => {
    const { history, index } = get();
    const newIndex = historyStep(history, index, "forward", accept);
    if (newIndex === null) return null;
    set({ index: newIndex, suppressPush: true, canGoBack: true, canGoForward: newIndex < history.length - 1 });
    return history[newIndex];
  },
}));
