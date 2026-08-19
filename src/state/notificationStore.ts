import { create } from "zustand";
import { translate } from "./languageStore";
import { useUiStore, type MainView, type StoriesMode } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";
import { workspaceIdFromBucket } from "../lib/prTarget";
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
  | "editor"
  | "notes"
  | "diagrams"
  /** The SQL console's assistant. Its own source rather than being folded into `editor`: the
   *  Databases workspace is a separate place with its own workspace-scoped state, and a row that
   *  says "editor" would send the reader looking in the wrong one. */
  | "db"
  /** Something a paired phone or tablet did. Its own source rather than being filed under the
   *  feature it touched, because *where it came from* is the interesting part: a commit you made
   *  is not news, and the same commit arriving from a device in your pocket is. */
  | "remote";

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
  notes: "tabbar.notes",
  diagrams: "tabbar.diagrams",
  db: "tabbar.databases",
  remote: "remote.title",
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
  /**
   * The view to bring up — when the thing has one.
   *
   * Optional because the assistant's own work does not. Its panel is a rail over whichever view is
   * showing (see `openAiPanel`), so a finished review, a reply that landed, or a fix it proposed is
   * reached by opening the rail — naming a view as well would take the screen the user was on away
   * to give nothing back.
   */
  view?: MainView;
  /** Which sub-tab, for the stories section's three. */
  storiesMode?: StoriesMode;
  /** Opens the assistant panel alongside the view. The chat is not a view of its own — it is a
   *  rail over whichever one is showing — so "go to the answer" means opening the rail. */
  openAiPanel?: boolean;
  /**
   * The project the work belonged to, brought to the front before anything else opens.
   *
   * The assistant panel reads its chat, its Activity and its findings from whichever project is
   * *active*, so opening it for a review that ran in another repository without this lands on the
   * right rail showing the wrong project's history. Absent for work that belongs to no repository
   * here — a pull request reviewed from a link is filed under the workspace instead.
   */
  projectId?: string;
  select?: {
    kind:
      | "batch"
      | "agentTask"
      | "chain"
      | "docPage"
      | "note"
      | "diagram"
      | "reviewSession"
      | "chatConversation"
      | "job";
    id: string;
  };
}

export interface AppNotification {
  id: string;
  source: NotificationSource;
  /**
   * The workspace the work belonged to.
   *
   * Stamped at push time from whatever was active. The panel lists every workspace's entries and
   * names this one on each row, rather than hiding the ones that aren't the active workspace's: a
   * generation the user walked away from is worth knowing about whichever workspace they came back
   * to, and a notification you can only find by guessing which workspace to switch to first is one
   * that arrives after it mattered. Following the row crosses back over — see
   * [`followNotification`]. `null` only for work that started before a workspace was chosen.
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

/**
 * What a caller supplies; the store stamps the rest — except the workspace, which it no longer can.
 *
 * `workspaceId` used to be optional and default to "wherever the user is now". That default was
 * right for work that finishes while they are still standing there, and wrong for every piece of
 * work that outlives it — which is the only kind this panel exists for. Nine callers passed it and
 * twenty-one did not, so twenty-one kinds of finished work were filed under whichever workspace the
 * user happened to have wandered into.
 *
 * Required now, and still nullable: `null` is the honest answer for work that belongs to no
 * workspace, and the panel renders it as such. What is no longer possible is *forgetting*.
 */
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
        // No fallback to the active workspace. It used to be here, and it was the single line that
        // turned every forgotten stamp into a row filed under the wrong workspace — silently, and
        // exactly for the work that had outlived the screen it was started from. See
        // `NotificationInput`: the field is required now, so there is nothing left to default.
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
 * Brings the notification's workspace — and, when the work belonged to one, its repository — to the
 * front, with the data behind it already loaded.
 *
 * The owning store is loaded *before* the sidebar flips, which is the opposite of the obvious order
 * and the only one that works. Every `setWorkspace` returns the instant its id already matches, and
 * several of them are already following the active workspace on their own — `chainStore` and
 * `docsStore` subscribe to it at module scope, and the agent and story views reload on theirs. Call
 * after the switch and you get an instant return from a load somebody else started and nobody can
 * await, so `select` runs against a list that is still empty and silently selects nothing. Loading
 * first makes every one of those later calls the no-op it looks like.
 *
 * The cost is a beat where the view still on screen is showing the destination workspace's data
 * while the sidebar still names the current one. It reads as loading, it is bounded by the fetch,
 * and it ends consistent — which is more than the other order can say.
 */
async function enterWorkspace(stampedWorkspaceId: string | null, target: NotificationTarget): Promise<void> {
  const workspaces = useWorkspaceStore.getState();
  // A project knows which workspace it is in, and that outranks the one stamped on the row: the
  // stamp is "wherever the user was standing when this finished", which for work that outlives the
  // screen it was started from is somewhere else entirely — and a right project under a wrong
  // workspace selects an id that resolves to nothing, landing the panel on no project at all.
  //
  // A **chain** is the exception, and it is the one destination where the project cannot answer.
  // A chain is filed under its *primary* repository's workspace — that is the join
  // `list_agent_chains` uses, and `chainStore.refresh` refuses a chain that list does not hold —
  // while `target.projectId` names the repository of the step it is on, which on a multi-repo plan
  // is a different one and, after that repository is moved between workspaces, a different
  // *workspace*. Resolving through the project would then cross into a workspace the chain cannot
  // be opened in and land on an empty pane. The caller's stamp is the authoritative answer there:
  // it comes from the same join the list does. The project is still focused below, which is
  // correct — it is where the work is about to happen, and it is inside this workspace whenever the
  // two agree.
  const chainTarget = target.select?.kind === "chain";
  const ownWorkspaceId =
    !chainTarget && target.projectId ? workspaces.workspaceOfProject(target.projectId) : null;
  const workspaceId = ownWorkspaceId ?? stampedWorkspaceId;
  if (!workspaceId) return;
  const crossing = workspaceId !== workspaces.activeWorkspaceId;
  // A workspace deleted since the run finished. The panel hides the button in that case, so this
  // is the unreachable path — it throws rather than carrying on, because carrying on would open
  // the destination view in the *current* workspace and look like it worked.
  if (crossing && !workspaces.workspaces.some((w) => w.id === workspaceId)) {
    throw new Error(translate("notifications.workspaceGone"));
  }

  if (crossing) {
    switch (target.select?.kind) {
      case "batch": {
        const { useStoriesStore } = await import("./storiesStore");
        await useStoriesStore.getState().setWorkspace(workspaceId);
        break;
      }
      case "agentTask": {
        const { useAgentsStore } = await import("./agentsStore");
        await useAgentsStore.getState().setWorkspace(workspaceId);
        break;
      }
      case "chain": {
        const { useChainStore } = await import("./chainStore");
        await useChainStore.getState().setWorkspace(workspaceId);
        break;
      }
      case "docPage": {
        const { useDocsStore } = await import("./docsStore");
        await useDocsStore.getState().setWorkspace(workspaceId);
        break;
      }
      case "note": {
        const { useNotesStore } = await import("./notesStore");
        await useNotesStore.getState().setWorkspace(workspaceId);
        break;
      }
      case "diagram": {
        const { useDiagramsStore } = await import("./diagramsStore");
        await useDiagramsStore.getState().setWorkspace(workspaceId);
        break;
      }
      // `reviewSession` is absent on purpose. Every case above belongs to a store with a
      // `setWorkspace` that can be pre-loaded, which is what the note above is about. The review
      // store has none — it follows the workspace through a subscription, and its `loadHistory`
      // reads whichever workspace is *active*. Pre-loading here would list the old one; `openById`
      // does its own load, after the switch below, which is the only order that works.
      //
      // `chatConversation` and `job` are absent for the opposite reason: neither is filed per
      // workspace. The chat loads its own conversation on demand and the job list holds every
      // bucket this session touched, so there is nothing to pre-load for either.
    }
  }

  // The project comes last, and through `focusProject` rather than the pair of calls it looks like:
  // it is the one that *awaits* the destination's project list before selecting out of it, where
  // `setActiveWorkspace` fires that load and moves on. Selecting a project the list hasn't got yet
  // sets an id nothing resolves, and the panel this was opening lands on no project at all.
  if (target.projectId) {
    await workspaces.focusProject(workspaceId, target.projectId);
  } else if (crossing) {
    workspaces.setActiveWorkspace(workspaceId);
  }
}

/**
 * Puts a finished assistant run back on screen: the pull request it reviewed, the link session it
 * ran without a repository, or the analysis it produced.
 *
 * This is the same landing the panel's own Activity list performs when the run is clicked there —
 * arrived at from the other end. The job is looked up across every bucket rather than asked for by
 * one: a run filed under a project and one filed under a workspace (a PR reviewed from a link,
 * which belongs to no repository here) are the same row to the user, and the id is unique either
 * way, so carrying the bucket through the notification would only be a second thing to keep true.
 */
async function showJobInAiPanel(jobId: string): Promise<void> {
  const [{ useJobsStore }, { usePrStore }, { useAnalyzeUiStore }] = await Promise.all([
    import("./jobsStore"),
    import("./prStore"),
    import("./analyzeUiStore"),
  ]);
  const job = Object.values(useJobsStore.getState().byProject)
    .flat()
    .find((j) => j.id === jobId);
  // Deleted from Activity since it finished. The panel is open on the right project either way,
  // which is most of where the user was going.
  if (!job) return;

  const linkWorkspaceId = workspaceIdFromBucket(job.projectId);
  if (linkWorkspaceId) {
    useAnalyzeUiStore.getState().hide();
    usePrStore.getState().openLinkPrFromMeta(job.meta, linkWorkspaceId);
    return;
  }
  if (job.kind === "analyze-changes") {
    usePrStore.getState().selectPr(null);
    useAnalyzeUiStore.getState().showJob(job.id);
    return;
  }
  const prId = job.meta.prId;
  if (typeof prId !== "number") return;
  // Fetched rather than read off whatever the sidebar last loaded: the pull request this reviewed
  // may not be in that list at all, and a review reached from a notification has to open either way.
  const pr = await usePrStore.getState().ensureProjectPr(job.projectId, prId);
  if (!pr) return;
  useAnalyzeUiStore.getState().hide();
  // The job's own repository, named rather than left to `selectPr`'s fallback. That fallback reads
  // the *active* project, and this line runs after a host round trip that the user is free to walk
  // away from — so a review followed from the bell could arrive stamped against whichever
  // repository they had wandered into, which is the mis-owned selection `selectedPrProjectId` was
  // introduced to make impossible. `job.projectId` is a real project here: the workspace-bucket
  // case returned above.
  usePrStore.getState().selectPr(pr, job.projectId);
}

/**
 * Follows a notification to the thing it is about, crossing into its workspace when it belongs to
 * another one.
 *
 * Opens the workspace, the view, the sub-tab under it, and then the row itself — four steps because
 * "where the wiki page finished" is not a place until all of them have happened, and landing on the
 * right tab with nothing selected is landing the user in front of the list they were trying to skip.
 *
 * The selection is delegated to the store that owns it, and imported where it is used rather than
 * at the top of the file: `storiesStore` and the rest already depend on this module for `notify`,
 * and importing them back at module scope would close the cycle.
 */
export async function followNotification(notification: AppNotification): Promise<void> {
  const { target } = notification;
  if (!target) return;
  await followTarget(notification.workspaceId, target);
}

/**
 * The same landing, addressed directly rather than through a notification.
 *
 * Split out because "go to where this is" is not only something a *finished* run asks for: the
 * status bar's live-agent list wants it for work that is still running, and building a fake
 * notification to reach it would mean pushing a row into the notification centre as a side effect
 * of clicking one.
 *
 * `workspaceId` is where the work belongs, and may be `null` for something that was started before
 * a workspace was chosen — a target naming a `projectId` recovers it either way, since a project
 * knows which workspace it is in.
 */
export async function followTarget(
  workspaceId: string | null,
  target: NotificationTarget,
): Promise<void> {
  await enterWorkspace(workspaceId, target);

  const ui = useUiStore.getState();
  // No view is a destination in itself for the assistant's own work — see `NotificationTarget.view`.
  if (target.view === "stories") ui.openStories(target.storiesMode ?? "batches");
  else if (target.view) ui.setActiveView(target.view);
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
    // Awaited, because `select` now persists the document being left before it opens another one.
    // Firing it and moving on would let this function resolve — and the view re-render onto the new
    // document — with the previous one's save still in flight, which is the same lost-keystroke
    // race the save was added to close.
    await useDocsStore.getState().select(id);
  } else if (kind === "note") {
    // The load is awaited first even though `openNote` fetches its own body, and that is not
    // belt-and-braces: `NotesView`'s mount effect runs the same load, and a first load clears
    // `activeId` before it fills the tree (see `setWorkspace`) — so opening the note before that
    // finished would have it blanked a beat later by the view arriving. It is the same in-flight
    // promise either way, so awaiting it here costs nothing and lands after the reset instead of
    // under it.
    const { ensureNotesStoreLoaded, useNotesStore } = await import("./notesStore");
    await ensureNotesStoreLoaded();
    // `openNote` rather than a plain id write: the tree holds metadata only, so the body has to be
    // fetched before the editor has anything to show. Deleted since the run finished is its own
    // case there — it drops the row and lands on the gallery instead of on an empty editor.
    await useNotesStore.getState().openNote(id);
  } else if (kind === "diagram") {
    // This branch is the one that was missing. `"diagram"` has been a legal `select.kind` since the
    // Diagrams AI panel started filing notifications with it, and every one of them opened the
    // gallery with nothing selected — the target was accepted by the type and then quietly ignored
    // here, which is the failure mode a closed union is supposed to prevent and does not, because
    // an `if/else` chain has no exhaustiveness check.
    const { ensureDiagramsStoreLoaded, useDiagramsStore } = await import("./diagramsStore");
    // Same ordering as notes: the view's own mount effect loads the tree and a first load clears
    // `activeId` on its way through, so opening the diagram before that settles would have it
    // blanked a beat later by the view arriving.
    await ensureDiagramsStoreLoaded();
    await useDiagramsStore.getState().openDiagram(id);
  } else if (kind === "reviewSession") {
    const { useWorkItemReviewStore } = await import("./workItemReviewStore");
    await useWorkItemReviewStore.getState().openById(id);
  } else if (kind === "chatConversation") {
    // Addressed by project — the rail reads its conversation from whichever one is active — so
    // without one there is no chat to open, only the panel that was already opened above.
    if (!target.projectId) return;
    const [{ useChatStore }, { usePrStore }, { useAnalyzeUiStore }] = await Promise.all([
      import("./chatStore"),
      import("./prStore"),
      import("./analyzeUiStore"),
    ]);
    // The panel shows one thing at a time and the chat is the last in line: a pull request left
    // selected, or an analysis left open, would sit on top of the answer this notification is
    // about. The same clearing the Activity list does before opening a chat row.
    usePrStore.getState().selectPr(null);
    usePrStore.getState().closeLinkPr();
    useAnalyzeUiStore.getState().hide();
    await useChatStore.getState().switchTo(target.projectId, id);
  } else if (kind === "job") {
    await showJobInAiPanel(id);
  } else {
    // The exhaustiveness check this chain did not have.
    //
    // `"diagram"` sat in the union for the whole life of the Diagrams AI panel with no branch to
    // match it, and nothing said so: an `if/else` chain over a closed union falls off the end in
    // silence, and the only symptom was a notification that opened the gallery and selected
    // nothing. Assigning the narrowed `kind` to `never` turns the next such omission into a
    // compile error at the moment the union grows.
    const unhandled: never = kind;
    void unhandled;
  }
}
