import { create } from "zustand";
import { useUiStore, type MainView, type StoriesMode } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { TranslationKey } from "../lib/i18n/translations";

/**
 * Where a notification came from, named as the menu the user would go to for more.
 *
 * A closed set rather than a free string: every entry has to name its origin in the panel, and a
 * new source must add its label here instead of quietly rendering a blank chip.
 */
export type NotificationSource =
  | "git"
  | "stories"
  | "agents"
  | "review"
  | "changes"
  | "docs"
  | "chat"
  | "editor";

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
  chat: "notifications.sourceChat",
  editor: "tabbar.editor",
};

/**
 * Where a notification takes you when you follow it.
 *
 * A description of a destination rather than a callback, so the panel is the only place that knows
 * how to navigate and the twenty `notify` call sites do not each grow a copy of that knowledge.
 * `select` is the thing to open once the view is showing — the store that owns it does the
 * selecting, because only it knows how to load a row it may not be holding yet.
 */
export interface NotificationTarget {
  view: MainView;
  /** Which sub-tab, for the stories section's three. */
  storiesMode?: StoriesMode;
  /** Opens the assistant panel alongside the view. The chat is not a view of its own — it is a
   *  rail over whichever one is showing — so "go to the answer" means opening the rail. */
  openAiPanel?: boolean;
  select?: { kind: "batch" | "agentTask" | "chain" | "docPage"; id: string };
}

export interface AppNotification {
  id: string;
  source: NotificationSource;
  /**
   * The workspace the work belonged to.
   *
   * Stamped at push time from whatever was active, and the panel shows only the active one's: a
   * notification is "come back to this", and a row pointing at a batch in another workspace is a
   * row whose button cannot do what it says. `null` only for work that started before a workspace
   * was chosen, which the panel treats as belonging to none.
   */
  workspaceId: string | null;
  /** Where to go. Absent when the work has nowhere to come back to. */
  target?: NotificationTarget;
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
export type NotificationInput = Omit<AppNotification, "id" | "finishedAt" | "seen" | "workspaceId">;

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
        // Read here rather than asked of the caller: every one of them is running inside a
        // workspace already, and a parameter twenty call sites have to remember is one that
        // nineteen will pass correctly.
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
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

/**
 * Follows a notification to the thing it is about.
 *
 * Opens the view, the sub-tab under it, and then the row itself — three steps because "where the
 * wiki page finished" is not a place until all three have happened, and landing on the right tab
 * with nothing selected is landing the user in front of the list they were trying to skip.
 *
 * The selection is delegated to the store that owns it, and imported where it is used rather than
 * at the top of the file: `storiesStore` and the rest already depend on this module for `notify`,
 * and importing them back at module scope would close the cycle.
 */
export async function followNotification(target: NotificationTarget): Promise<void> {
  const ui = useUiStore.getState();
  if (target.view === "stories") ui.openStories(target.storiesMode ?? "batches");
  else ui.setActiveView(target.view);
  if (target.openAiPanel) ui.openAiPanel();

  if (!target.select) return;
  const { kind, id } = target.select;
  if (kind === "batch") {
    const { useStoriesStore } = await import("./storiesStore");
    await useStoriesStore.getState().select(id);
  } else if (kind === "agentTask") {
    const { useAgentsStore } = await import("./agentsStore");
    await useAgentsStore.getState().select(id);
  } else if (kind === "chain") {
    const { useChainStore } = await import("./chainStore");
    await useChainStore.getState().select(id);
  } else if (kind === "docPage") {
    const { useDocsStore } = await import("./docsStore");
    useDocsStore.getState().select(id);
  }
}
