import { create } from "zustand";
import type { MainView } from "./uiStore";

interface NavEntry {
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
  back: () => NavEntry | null;
  forward: () => NavEntry | null;
}

function sameEntry(a: NavEntry | undefined, b: NavEntry): boolean {
  return !!a && a.view === b.view && a.projectId === b.projectId;
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

  back: () => {
    const { history, index } = get();
    if (index <= 0) return null;
    const newIndex = index - 1;
    set({ index: newIndex, suppressPush: true, canGoBack: newIndex > 0, canGoForward: true });
    return history[newIndex];
  },

  forward: () => {
    const { history, index } = get();
    if (index >= history.length - 1) return null;
    const newIndex = index + 1;
    set({ index: newIndex, suppressPush: true, canGoBack: true, canGoForward: newIndex < history.length - 1 });
    return history[newIndex];
  },
}));
