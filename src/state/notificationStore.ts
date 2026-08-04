import { create } from "zustand";
import type { TranslationKey } from "../lib/i18n/translations";

/**
 * Where a notification came from, named as the menu the user would go to for more.
 *
 * A closed set rather than a free string: every entry has to name its origin in the panel, and a
 * new source must add its label here instead of quietly rendering a blank chip.
 */
export type NotificationSource = "git" | "stories" | "agents" | "review" | "changes" | "docs";

/**
 * The menu each source is called in the rest of the app.
 *
 * Deliberately reuses the tab bar's own keys instead of introducing parallel names: the panel says
 * "Especificación" because that is what the menu says, and renaming the menu renames this with it.
 */
export const NOTIFICATION_SOURCE_LABEL: Record<NotificationSource, TranslationKey> = {
  git: "tabbar.scopeRepository",
  stories: "tabbar.stories",
  agents: "tabbar.agents",
  review: "stories.tabReview",
  changes: "tabbar.changes",
  docs: "stories.wiki",
};

export interface AppNotification {
  id: string;
  source: NotificationSource;
  /**
   * What happened, as a key translated at render time rather than a finished string.
   *
   * Storing the rendered text would freeze each entry in whatever language was active when its run
   * finished, so a list built before a language switch would come back half in the other one.
   */
  titleKey: TranslationKey;
  /** Interpolation for `titleKey`. */
  params?: Record<string, string | number>;
  /** The thing it acted on — a branch, a batch title, a task name. User data, never translated. */
  detail?: string;
  status: "success" | "error" | "info";
  /** When the work finished, which is also when this was pushed. */
  finishedAt: number;
  /** Cleared for everything at once when the panel closes — see `markAllSeen`. */
  seen: boolean;
}

/** What a caller supplies; the store stamps the rest. */
export type NotificationInput = Omit<AppNotification, "id" | "finishedAt" | "seen">;

/** Older entries fall off the end. Nobody scrolls a notification list this far back, and the store
 * lives for the whole session — without a cap a long day of auto-fetches would grow forever. */
const MAX_ITEMS = 100;

interface NotificationState {
  /** Newest first, which is the order the panel renders. */
  items: AppNotification[];
  push: (input: NotificationInput) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Called when the panel closes rather than when it opens: while it is open, the entries that
   * were new stay marked so the user can tell which ones they hadn't read yet. */
  markAllSeen: () => void;
}

/**
 * The notification centre: background work reporting that it finished.
 *
 * This is for things the user started and then looked away from — a generation, a verification, a
 * fetch. It is not an error channel: a failure that the user is watching already gets a toast, and
 * one they aren't watching lands here *as well* so the screen they come back to can tell them.
 *
 * Session-scoped on purpose. Nothing here is persisted, so a restart starts empty — these are
 * "what happened while I was away from this screen", not an audit log. The durable record of a run
 * is its own history (`jobsStore`, the batch rows, git itself).
 */
export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],

  push: (input) =>
    set((s) => {
      const item: AppNotification = {
        ...input,
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        finishedAt: Date.now(),
        seen: false,
      };
      return { items: [item, ...s.items].slice(0, MAX_ITEMS) };
    }),

  remove: (id) => set((s) => ({ items: s.items.filter((n) => n.id !== id) })),

  clear: () => set({ items: [] }),

  markAllSeen: () =>
    set((s) => (s.items.some((n) => !n.seen) ? { items: s.items.map((n) => ({ ...n, seen: true })) } : s)),
}));

/**
 * Report finished background work, from anywhere — stores, plain modules, event handlers.
 *
 * Mirrors `pushErrorToast`: the point is that a caller deep in a store doesn't have to reach for
 * the hook or thread the store through. A toast says it *now*; this says it *later*, and most
 * completions deserve both.
 */
export function notify(input: NotificationInput): void {
  useNotificationStore.getState().push(input);
}
