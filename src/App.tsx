import { Suspense, lazy, useEffect, useState, type ReactElement } from "react";
import { AnimatePresence } from "framer-motion";
import { FolderGit2 } from "lucide-react";
import { useT } from "./state/languageStore";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { TabBar } from "./components/layout/TabBar";
import { AppRail } from "./components/layout/AppRail";
import { StatusBar } from "./components/layout/StatusBar";
import { AddDependencyModal } from "./components/editor/AddDependencyModal";
import { GraphView } from "./components/git/GraphView";
import { ChangesPanel } from "./components/git/ChangesPanel";
import { AiPanel } from "./components/ai/AiPanel";
import { UpdateNotesModal } from "./components/layout/UpdateNotesModal";
import { RequirementsModal } from "./components/layout/RequirementsModal";
import { UpdateAlert } from "./components/layout/UpdateAlert";
import { EmptyState } from "./components/common/EmptyState";
import { ToastContainer } from "./components/common/Toast";
import { NotificationPopups } from "./components/layout/NotificationPopups";
import { ConfirmModal } from "./components/common/ConfirmModal";
import { PromptModal } from "./components/common/PromptModal";
import { TourOverlay } from "./components/tour/TourOverlay";
import { PaletteSkeleton, SettingsSkeleton, ViewSkeleton } from "./components/common/ViewSkeleton";
import { useThemeStore } from "./state/themeStore";
import { useUiStore, type MainView } from "./state/uiStore";
import { pipelinesAvailable, useVcsConnectionsStore } from "./state/vcsConnectionsStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useLayoutStore } from "./state/layoutStore";
import { useRepoStore } from "./state/repoStore";
import { useApiStore } from "./state/apiStore";
import { useDbStore } from "./state/dbStore";
import { useRemoteStore } from "./state/remoteStore";
import { usePreferencesStore } from "./state/preferencesStore";
import { useAiProviderStore } from "./state/aiProviderStore";
import { useLanguageStore } from "./state/languageStore";
import { useAccentStore } from "./state/accentStore";
import { useFetchTimerStore } from "./state/fetchTimerStore";
import { useUpdateStore, CHECK_INTERVAL_MS } from "./state/updateStore";
import { useNavigationStore } from "./state/navigationStore";
import { useTerminalStore } from "./state/terminalStore";
import { useShortcutsStore } from "./state/shortcutsStore";
import { useIconRulesStore } from "./state/iconRulesStore";
import { useFileNestingStore } from "./state/fileNestingStore";
import { useTourStore } from "./state/tourStore";
import { useRequirementsStore } from "./state/requirementsStore";
import { useBlameStore } from "./state/blameStore";
import { useChainStore } from "./state/chainStore";
import { useAgentsStore } from "./state/agentsStore";
import { notify } from "./state/notificationStore";
import { useJobsStore } from "./state/jobsStore";
import { useAiRunStore } from "./state/aiRunStore";
import { useChatHistoryStore } from "./state/activityStore";
import { useChatStore } from "./state/chatStore";
import type { TranslationKey } from "./lib/i18n/translations";
import { useGlobalShortcuts } from "./lib/useGlobalShortcuts";
import { startWindowBoundsTracking } from "./lib/windowControls";
import { backgroundFetch } from "./lib/backgroundFetch";
import { startWatching, stopWatching } from "./lib/tauri/commands";
import { DESKTOP_ORIGIN, onAppForeground, onRepoFsChanged, onStateInvalidate } from "./lib/tauri/events";

/**
 * Everything below is split out of the entry chunk rather than compiled into it.
 *
 * The app already knew *when* each of these first becomes visible — `visited` below, and the
 * `xxxOpen` flags at the bottom of `App` — but until now knowing that bought nothing: every one
 * of them was a static import, so xterm, noVNC, the whole settings tree and every view's worth of
 * components were parsed and evaluated before the first frame of the graph could paint, on every
 * launch, whether or not the user ever opened them.
 *
 * Monaco used to be the one this did *not* fix — `main.tsx` imported `lib/monacoSetup` for its side
 * effects and that module imports `monaco-editor` at the top level, so the editor was a static
 * dependency of the entry however lazily `EditorView` was mounted. That is fixed now, and it took
 * four cuts rather than one: `main.tsx`, `apiStore` (which is reached from this file), the split
 * pane of `DiffView` (extracted to `SplitFileDiff`, because `DiffView` itself is static here and
 * unified mode needs no editor) and `ConflictResolveModal` (lazy from `ConflictsBanner`). Any one
 * of them left in place holds the whole 4 MB chunk on the boot path, so if you find yourself
 * adding a static `@monaco-editor/react` import to something reachable from this file, that is the
 * invariant you are breaking — check `dist/index.html` for a `monaco-*.js` modulepreload.
 *
 * `React.lazy` moves that cost to the moment the thing is actually asked for. Two rules go with
 * it and neither is optional:
 *
 *  1. One `<Suspense>` per view, *inside* each view's own `<div key>`. A single boundary wrapped
 *     around `MainContent` would unmount the entire subtree while any one chunk loaded — which is
 *     precisely the teardown of live terminal sessions and API WebSocket/MQTT connections that the
 *     never-unmount policy documented in `MainContent` exists to prevent.
 *  2. Graph and Changes stay static. `uiStore` starts on "graph", so making them lazy would only
 *     buy a skeleton flash on every launch.
 */
const EditorView = lazy(() => import("./components/editor/EditorView").then((m) => ({ default: m.EditorView })));
const PipelinesView = lazy(() =>
  import("./components/pipelines/PipelinesView").then((m) => ({ default: m.PipelinesView })),
);
const ApiView = lazy(() => import("./components/api/ApiView").then((m) => ({ default: m.ApiView })));
const AgentsView = lazy(() => import("./components/agents/AgentsView").then((m) => ({ default: m.AgentsView })));
const StoriesView = lazy(() => import("./components/stories/StoriesView").then((m) => ({ default: m.StoriesView })));
const RemoteView = lazy(() => import("./components/remote/RemoteView").then((m) => ({ default: m.RemoteView })));
const NotesView = lazy(() => import("./components/notes/NotesView").then((m) => ({ default: m.NotesView })));
const VaultView = lazy(() => import("./components/vault/VaultView").then((m) => ({ default: m.VaultView })));
const DiagramsView = lazy(() =>
  import("./components/diagrams/DiagramsView").then((m) => ({ default: m.DiagramsView })),
);

const loadTerminalDock = () =>
  import("./components/terminal/TerminalDock").then((m) => ({ default: m.TerminalDock }));
const loadSettingsView = () =>
  import("./components/settings/SettingsView").then((m) => ({ default: m.SettingsView }));
const loadCommandPalette = () =>
  import("./components/layout/CommandPalette").then((m) => ({ default: m.CommandPalette }));
const loadShortcutsModal = () =>
  import("./components/layout/ShortcutsModal").then((m) => ({ default: m.ShortcutsModal }));
const loadBranchSwitcherModal = () =>
  import("./components/layout/BranchSwitcherModal").then((m) => ({ default: m.BranchSwitcherModal }));
const loadOpenPrLinkModal = () =>
  import("./components/layout/OpenPrLinkModal").then((m) => ({ default: m.OpenPrLinkModal }));

const TerminalDock = lazy(loadTerminalDock);
const SettingsView = lazy(loadSettingsView);
const CommandPalette = lazy(loadCommandPalette);
const ShortcutsModal = lazy(loadShortcutsModal);
const BranchSwitcherModal = lazy(loadBranchSwitcherModal);
const OpenPrLinkModal = lazy(loadOpenPrLinkModal);

/**
 * The chunks above that open from a keystroke, warmed once the app has finished starting.
 *
 * These six are the ones where a Suspense fallback would actually be *noticed*: Ctrl+K and the
 * terminal toggle are reflexes, and a skeleton between the key and the panel would read as the
 * app being slower than it was. Fetching them on an idle callback after boot costs nothing the
 * user can feel — the main thread is already free by then — and means the fallback is only ever
 * reached in the pathological case where the key is pressed inside the first idle window.
 *
 * The heavy views are deliberately *not* in this list. Monaco alone is hundreds of milliseconds
 * of parse; doing that speculatively is how an idle callback turns into a dropped keystroke. They
 * pay for themselves on first open, behind a skeleton, which is strictly better than the
 * synchronous freeze they used to cause at launch.
 */
const WARM_CHUNKS = [
  loadTerminalDock,
  loadSettingsView,
  loadCommandPalette,
  loadShortcutsModal,
  loadBranchSwitcherModal,
  loadOpenPrLinkModal,
];

/**
 * How long the filesystem watcher has to go quiet before the working tree is re-read, and before
 * the rest of the repository is.
 *
 * Trailing edge, both of them, and never leading. `src-tauri/src/watcher.rs` carries the scar:
 * a plain leading-edge throttle there emitted the first event of a burst and dropped the rest,
 * which lost every file but the first when an agent's Edit tool wrote several in a row, and left
 * the app showing a state that had never existed. A trailing edge can be late but it cannot be
 * wrong — the timer only ever fires after the last event, so what it reads is the final state.
 */
/**
 * The `remote.action.*` keys the backend is allowed to name.
 *
 * A payload from `remotectl` is the one place a `TranslationKey` arrives from outside this
 * codebase, and a newer desktop paired with an older one — or the reverse — can send a key this
 * build has no string for. Checking against the list here means an unknown one is dropped rather
 * than rendered as its own raw key in the notification centre, which is what `translate` would do
 * with it.
 *
 * Kept in step with `announce_for` in `src-tauri/src/remotectl/dispatch.rs`.
 */
const REMOTE_ACTION_KEYS = new Set<string>([
  "remote.action.commit",
  "remote.action.push",
  "remote.action.pull",
  "remote.action.fetch",
  "remote.action.checkout",
  "remote.action.branch",
  "remote.action.gateApproved",
  "remote.action.stepSkipped",
  "remote.action.chainAborted",
  "remote.action.chainResumed",
  "remote.action.stepRetried",
  "remote.action.runCancelled",
  "remote.action.prReviewed",
  "remote.action.prActed",
  "remote.action.prCommented",
  "remote.action.threadResolved",
  "remote.action.findingDiscarded",
  "remote.action.analyzed",
  "remote.action.chat",
  "remote.action.terminalOpened",
  "remote.action.terminalClosed",
]);

function isRemoteActionKey(key: string): key is TranslationKey {
  return REMOTE_ACTION_KEYS.has(key);
}

const FS_NEAR_WAIT_MS = 600;
const FS_FAR_WAIT_MS = 3000;
/**
 * ...and the ceiling on each, because the watcher does not always go quiet. It emits at most once
 * per 400ms for as long as files keep landing, so a checkout or an `npm install` that runs for ten
 * seconds would reset a 600ms timer twenty-five times in a row and refresh nothing at all until it
 * finished — a regression on the old behaviour, not an optimisation of it. Past the ceiling the
 * refresh happens whether or not the burst has stopped, and the trailing timer is re-armed after
 * it, so the last event is still read once things do settle.
 */
const FS_NEAR_MAX_WAIT_MS = 2000;
const FS_FAR_MAX_WAIT_MS = 10000;

type Debounced = { (): void; cancel: () => void };

/** Trailing-edge debounce with a maximum wait. See the constants above for why it is both. */
function trailingDebounce(fn: () => void, waitMs: number, maxWaitMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // When the current burst started, so the ceiling is measured from the *first* event of it and
  // not from the last — which is the whole difference between a max-wait and a longer debounce.
  let burstStartedAt = 0;
  const reset = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    burstStartedAt = 0;
  };
  return Object.assign(
    () => {
      const now = Date.now();
      if (burstStartedAt === 0) burstStartedAt = now;
      if (timer !== undefined) clearTimeout(timer);
      const remaining = burstStartedAt + maxWaitMs - now;
      timer = setTimeout(() => {
        reset();
        fn();
      }, Math.max(0, Math.min(waitMs, remaining)));
    },
    { cancel: reset },
  );
}

const PROJECT_VIEWS: { id: MainView; render: () => ReactElement }[] = [
  { id: "graph", render: () => <GraphView /> },
  { id: "changes", render: () => <ChangesPanel /> },
  { id: "editor", render: () => <EditorView /> },
  // Repository-scoped like the three above it: a run belongs to a repo, and clicking a different
  // repository reloads everything here. The tab that opens it is conditional — see `TabBar` — but
  // membership of this list is not, because the guard below has to be able to leave it.
  { id: "pipelines", render: () => <PipelinesView /> },
];

/** Views that aren't about a repository, so the "no project open" empty state must not swallow
 * them — but that do belong to a workspace. The API client owns the workspace's
 * collections/environments and is expected to be usable before any repo has been added to it;
 * the agent console owns the workspace's agent roster, which is likewise defined before there is
 * anything for an agent to work on. The user-stories workspace is the clearest case of all: a
 * requirement is written *before* the code that satisfies it, and often before the repo exists.
 * The Remote workspace owns the machines a workspace deploys to, which likewise don't change when
 * you click a different repository. And Notes is the clearest case after the stories: the decision
 * you wrote down last March is about the system, not about a checkout. Diagrams is the same case
 * one step further out: an architecture drawing describes the system, and a repository is one of
 * the boxes in it. */
const WORKSPACE_VIEWS: { id: MainView; render: () => ReactElement }[] = [
  { id: "api", render: () => <ApiView /> },
  { id: "agents", render: () => <AgentsView /> },
  { id: "stories", render: () => <StoriesView /> },
  { id: "remote", render: () => <RemoteView /> },
  { id: "notes", render: () => <NotesView /> },
  { id: "diagrams", render: () => <DiagramsView /> },
  // In this list because it renders with no project open, not because it follows the workspace —
  // the keyring is global. Membership here is what exempts a view from the "no project" empty
  // state, and the gate is `workspaceId !== null`, which is true whenever the app is usable.
  { id: "vault", render: () => <VaultView /> },
];

function MainContent() {
  const activeView = useUiStore((s) => s.activeView);
  const project = useWorkspaceStore((s) => s.activeProject());
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const connections = useVcsConnectionsStore();
  const [visited, setVisited] = useState<Set<MainView>>(new Set());
  const t = useT();

  useEffect(() => {
    setVisited((prev) => (prev.has(activeView) ? prev : new Set(prev).add(activeView)));
  }, [activeView]);

  /**
   * The way out of a tab that stopped existing.
   *
   * Pipelines is the app's first conditional view: click a repository that isn't linked to a
   * connected host and its tab is gone, but `activeView` still says `"pipelines"` — which would
   * leave the window showing a view with no tab lit and no way back except guessing.
   *
   * Written as an effect over *state* rather than as a guard inside `setActiveView`, and that
   * distinction is the point: `lib/tour/stage.ts` sets `activeView` with `useUiStore.setState`
   * directly, bypassing every action on the store. A guard in the action would not cover the tour;
   * this does, because it only reads where we ended up.
   */
  const pipelinesOpen = pipelinesAvailable(project, connections);
  useEffect(() => {
    if (activeView === "pipelines" && !pipelinesOpen) useUiStore.getState().setActiveView("graph");
  }, [activeView, pipelinesOpen]);

  const workspaceViewOpen =
    workspaceId !== null && WORKSPACE_VIEWS.some((v) => v.id === activeView);

  if (!project && !workspaceViewOpen) {
    return (
      <EmptyState icon={FolderGit2} title={t("common.noProjectOpen")} subtitle={t("common.openProjectHint")} />
    );
  }

  // Once a view has been opened it stays mounted (just hidden) so switching tabs doesn't kill
  // in-progress state — the Terminal's shell session, and now also the API client's live
  // WebSocket/MQTT connections and unsaved request drafts, all of which would otherwise be
  // torn down every time you tabbed away. Views never opened yet aren't mounted at all.
  //
  // The `<Suspense>` is *per view*, inside the per-view `<div>`, and must stay that way: one
  // boundary hoisted up here would cover every mounted view at once, so the first open of any
  // lazy view would replace all of them with a fallback — unmounting exactly the sessions and
  // sockets the paragraph above exists to keep alive.
  return (
    <>
      {project &&
        PROJECT_VIEWS.filter(({ id }) => visited.has(id)).map(({ id, render }) => (
          <div key={id} className={activeView === id ? "h-full" : "hidden"}>
            <Suspense fallback={<ViewSkeleton />}>{render()}</Suspense>
          </div>
        ))}
      {workspaceId !== null &&
        WORKSPACE_VIEWS.filter(({ id }) => visited.has(id)).map(({ id, render }) => (
          <div key={id} className={activeView === id ? "h-full" : "hidden"}>
            <Suspense fallback={<ViewSkeleton />}>{render()}</Suspense>
          </div>
        ))}
    </>
  );
}

export default function App() {
  const initTheme = useThemeStore((s) => s.init);
  const initLayout = useLayoutStore((s) => s.init);
  const initPreferences = usePreferencesStore((s) => s.init);
  const initLanguage = useLanguageStore((s) => s.init);
  const initAccent = useAccentStore((s) => s.init);
  const initTerminal = useTerminalStore((s) => s.init);
  const initAiProvider = useAiProviderStore((s) => s.init);
  const initShortcuts = useShortcutsStore((s) => s.init);
  const initIconRules = useIconRulesStore((s) => s.init);
  const initFileNesting = useFileNestingStore((s) => s.init);
  const initTour = useTourStore((s) => s.init);
  const initRequirements = useRequirementsStore((s) => s.init);
  const project = useWorkspaceStore((s) => s.activeProject());
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setRepoPath = useRepoStore((s) => s.setRepoPath);
  const autoFetchSeconds = usePreferencesStore((s) => s.autoFetchSeconds);
  const activeView = useUiStore((s) => s.activeView);
  // Subscribed to for the background fetch below and nothing else: the API tab is two tools behind
  // one view, so opening the database side from the rail is an arrival that `activeView` alone
  // cannot see.
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen);
  const terminalPanelOpen = useTerminalStore((s) => s.panelOpen);
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const commandPaletteScope = useUiStore((s) => s.commandPaletteScope);
  const closeCommandPalette = useUiStore((s) => s.closeCommandPalette);
  const shortcutsModalOpen = useUiStore((s) => s.shortcutsModalOpen);
  const closeShortcutsModal = useUiStore((s) => s.closeShortcutsModal);
  const branchSwitcherOpen = useUiStore((s) => s.branchSwitcherOpen);
  const closeBranchSwitcher = useUiStore((s) => s.closeBranchSwitcher);
  const prLinkModalOpen = useUiStore((s) => s.prLinkModalOpen);
  const closePrLinkModal = useUiStore((s) => s.closePrLinkModal);
  // Read here, not only inside `SettingsView`, because the panel is a lazy chunk now and this is
  // the flag that decides whether that chunk is ever asked for. See the render below.
  const settingsOpen = useUiStore((s) => s.settingsOpen);

  useGlobalShortcuts();

  useEffect(() => {
    (async () => {
      // What `initRequirements` decides: whether the guided tour is allowed to open itself.
      //
      // It used to be awaited *ahead* of the batch, alone, purely so its answer would be in hand
      // before `initTour` ran inside it. That serialised a whole round trip in front of the entire
      // boot for a single boolean. It runs in the batch now and hands its answer to `initTour`
      // *after* the batch instead — which states the same ordering more strongly than being one of
      // ten concurrent promises ever did. On every launch but the first of an installation this is
      // a single settings read that returns immediately anyway; only on that first launch does it
      // cost a `git --version` and a file write. See `requirementsStore`.
      let clearToTour = true;
      await Promise.all([
        initRequirements().then((ok) => {
          clearToTour = ok;
        }),
        initTheme(),
        initLayout(),
        initPreferences(),
        initLanguage(),
        initAccent(),
        initTerminal(),
        initAiProvider(),
        initShortcuts(),
        // Read with the rest of the look-and-feel settings: the explorer paints its first tree
        // within a frame or two of this batch, and rules arriving after it would repaint every row.
        initIconRules(),
        // Same batch and the same argument, one step stronger: file nesting decides which rows
        // exist at a directory's own indent, so arriving late would not just recolour the first
        // tree, it would rearrange it in front of the user. Nothing per repository to go with it —
        // a pattern names filenames, not paths.
        initFileNesting(),
        // Starts before the user can reach the maximize button, so the size the window opened at is
        // already recorded as somewhere to restore to.
        startWindowBoundsTracking(),
        // Which VCS hosts are connected. In this batch because the Pipelines tab appears and
        // disappears based on the answer, and a tab that shows up a second after the window does
        // reads as a glitch. Three `get_setting` reads against the local database.
        useVcsConnectionsStore.getState().refresh(),
      ]);
      useAccentStore.getState().apply(useThemeStore.getState().resolved);
      // Reads whether the guided tour has already been run, and — if it hasn't — arms the
      // first-launch opening. Deliberately *after* the batch: the tour rearranges panels, and it
      // must not start before the layout and language it rearranges have loaded.
      void initTour({ autoOpen: clearToTour });
      // Last, and only once there is nothing left to do: pull in the chunks that open from a
      // keystroke, so the first Ctrl+K of the session doesn't have to wait for one. Idle rather
      // than immediate — this must never be what the first frame is waiting on.
      const warm = () => {
        for (const load of WARM_CHUNKS) void load().catch(() => {});
      };
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(warm, { timeout: 4000 });
      } else {
        setTimeout(warm, 2000);
      }
    })();
  }, [
    initTheme,
    initLayout,
    initPreferences,
    initLanguage,
    initAccent,
    initTerminal,
    initAiProvider,
    initShortcuts,
    initIconRules,
    initFileNesting,
    initTour,
    initRequirements,
  ]);

  // The accent used to be re-applied from here, on a `[resolved, accentId]` effect. Both writers
  // already do it themselves — `applyToDocument` in `themeStore` and `setAccent` in `accentStore`,
  // in the same synchronous block as the colours they belong to — so all this added was a *root*
  // subscription to two stores that change during a theme wipe. Every light/dark flip and every
  // accent pick therefore re-rendered the whole component tree, synchronously, inside
  // `withThemeTransition`'s `flushSync` — which is the browser's deadline for photographing the
  // new state and starting the wipe. Boot is covered by the explicit `apply` after the init batch.

  // Single source of truth for which repo the git engine points at — covers manual
  // sidebar clicks *and* the auto-selected first project on load/reload, which
  // previously left branches/commits empty until the user re-clicked it.
  useEffect(() => {
    void setRepoPath(project?.local_path ?? null);
    // Which icon profile the explorer draws this repository with. Scoped here and not to the
    // workspace because the collision profiles exist for is per checkout: the Angular app and the
    // Nest API can sit in one workspace and still disagree about what `*.service.ts` is. Only the
    // *selection* is per repo — the profiles themselves are global — so this swaps a preference
    // rather than dropping any state.
    void useIconRulesStore.getState().setRepo(project?.local_path ?? null);
  }, [project?.local_path, setRepoPath]);

  // The API client's collections, environments, history and cookies belong to the workspace, so
  // a switch has to swap them the way the repo above swaps. Only the id is passed: the store
  // owns the teardown of what the previous workspace left running (live WebSocket/MQTT
  // connections, open request tabs), so there is nothing here to keep in step with it. Same for
  // the database workspace — connections, saved consoles, query history, and the live sessions
  // belonging to the connections it is about to drop — and for Remote, whose open sessions are
  // `ssh` processes that have to be closed rather than left as children nothing on screen names.
  //
  // But a *switch* is the only thing this effect is for now. It used to fire on the very first
  // workspace too, which meant every launch paid for three full tree loads and about seventeen
  // IPC round trips in front of the first frame — for three views `MainContent` does not even
  // mount unless the user goes to them. Each of those views hydrates itself on mount already
  // (`ensureApiStoreLoaded`, `ensureDbStoreLoaded`, `ensureRemoteStoreLoaded`), so the first load
  // is simply left to whichever of them the user opens, if any.
  //
  // The guard is what keeps the teardown honest: a store that has never loaded has nothing to
  // tear down and no stale workspace to show, so calling `setWorkspace` on it would only be
  // re-introducing the eager load through the back door. `workspaceId !== null` is the store's own
  // record of having been hydrated (every `init` sets it before its first await); `loading` covers
  // the sliver where a first load is in flight but has not written it yet.
  useEffect(() => {
    if (!workspaceId) return;
    if (useApiStore.getState().workspaceId !== null || useApiStore.getState().loading) {
      void useApiStore.getState().setWorkspace(workspaceId);
    }
    if (useDbStore.getState().workspaceId !== null || useDbStore.getState().loading) {
      void useDbStore.getState().setWorkspace(workspaceId);
    }
    if (useRemoteStore.getState().workspaceId !== null || useRemoteStore.getState().loading) {
      void useRemoteStore.getState().setWorkspace(workspaceId);
    }
    // Notes and Diagrams are not here, and that is the fix rather than an omission: each keeps this
    // same guard in a `useWorkspaceStore.subscribe` at the bottom of its own store, the way
    // `docsStore` and `chainStore` already did. Diagrams is why. It was added after this effect was
    // written, never got its line here, and so kept showing — and filing — its drawings under the
    // workspace it was first opened in. A store's own file is the only place that rule cannot be
    // forgotten from.
  }, [workspaceId]);

  // Looks for a newer release: once on launch, then every hour for as long as the app is open.
  // The focus listener is the catch-up for a machine that slept through several ticks — a
  // laptop reopened on Monday would otherwise keep Friday's answer until the next hour was up.
  // Every one of these is silent unless it finds something; see `checkNow`.
  useEffect(() => {
    void useUpdateStore.getState().loadCurrentVersion();
    void useUpdateStore.getState().checkNow();
    const id = setInterval(() => void useUpdateStore.getState().checkNow(), CHECK_INTERVAL_MS);
    const onFocus = () => {
      const { lastCheckedAt } = useUpdateStore.getState();
      if (lastCheckedAt === null || Date.now() - lastCheckedAt >= CHECK_INTERVAL_MS) {
        void useUpdateStore.getState().checkNow();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Records every view/project change onto the back/forward history. `nav.back` and `nav.forward`
  // just replay entries from this stack — they were a pair of chevrons in the title bar until those
  // came out, and the stack is what the shortcuts have always been driving.
  useEffect(() => {
    useNavigationStore.getState().push({ view: activeView, projectId: project?.id ?? null });
  }, [activeView, project?.id]);

  // Watch the active project's working tree so external changes — an edit made in the
  // embedded Editor, in VS Code, from a terminal `git` command, anything — show up in
  // Changes/Graph automatically instead of only after the app's own git actions.
  useEffect(() => {
    const path = project?.local_path;
    if (!path) return;
    void startWatching(path);
    return () => {
      void stopWatching(path);
      // The blame cache holds eight files at most, so a project left behind would otherwise sit in
      // slots the project you switched to wants. Not a correctness fix — every key carries its own
      // repository path, so a stale entry can never be served to the wrong repo — which is why it
      // rides along with the watcher teardown instead of being wired up on its own.
      useBlameStore.getState().clear();
    };
  }, [project?.local_path]);

  useEffect(() => {
    // Everything the working tree changing implies, still refreshed — an external change can just
    // as easily be a branch switch, a stash or a merge, all of which used to go stale until
    // something else happened to trigger a refresh. What changed is *when*, not *whether*.
    //
    // The near timer carries what the user is looking at while files land: the status lists and
    // the merge/conflict state. The far one carries what only moves when something bigger
    // happened — the commit list, branches, stashes, remotes, and the unpushed count that hangs
    // off the commit list. Splitting them is what stops a branch switch, which touches a few
    // thousand files, from firing seven git invocations per burst tick for as long as it runs.
    const refreshNear = trailingDebounce(
      () => {
        void useRepoStore.getState().refreshStatus();
        void useRepoStore.getState().refreshMergeState();
      },
      FS_NEAR_WAIT_MS,
      FS_NEAR_MAX_WAIT_MS,
    );
    const refreshFar = trailingDebounce(
      () => {
        const repo = useRepoStore.getState();
        void repo.refreshCommits();
        void repo.refreshUnpushedCommits();
        void repo.refreshBranches();
        void repo.refreshStashes();
        void repo.refreshRemotes();
      },
      FS_FAR_WAIT_MS,
      FS_FAR_MAX_WAIT_MS,
    );
    // Attaches the run-event listeners before anything can need them.
    //
    // `aiRunStore` used to subscribe lazily, from its own `start` — fine while every run in the
    // app began with a local `start` call, and wrong the moment one could begin somewhere else. A
    // review or a chat turn launched from a paired phone reaches the same engine through the same
    // code, but this window never calls `start` for it, so with the old lazy subscription a
    // desktop that had not itself run anything was not listening: the engine banner, the live
    // output and the completion event all arrived with nobody attached. That is why a phone-started
    // review showed no working row and left no trace here.
    useAiRunStore.getState().init();

    const unlisten = onRepoFsChanged((e) => {
      const activePath = useWorkspaceStore.getState().activeProject()?.local_path;
      if (e.repo_path !== activePath) return;
      refreshNear();
      refreshFar();
    });

    // The same refreshes, for the changes no watcher can see.
    //
    // A phone driving this install (`src-tauri/src/remotectl/`) runs the same commands the buttons
    // here run, so most of its work is already covered: it moves bytes on disk and the watcher
    // above fires. What it does *not* cover is anything whose only effect is a row — approving a
    // chain gate, pinning a task — and `state:invalidate` is the backend saying so explicitly.
    //
    // `repo` deliberately reuses the two debouncers rather than refreshing directly: this effect
    // owns how often the repository views may be re-read, and a second policy for the same data
    // would be one to keep in step. The other two domains have no burst behaviour to smooth —
    // one gate approval is one event — so they reload straight away.
    const unlistenInvalidate = onStateInvalidate(async (e) => {
      // This window's own change, coming back through the global emit that carried it to the
      // phones. Acting on it would mean reloading each store on top of the write that is still
      // settling into it — a chain list re-read mid-`applyChain`, a chat history reloaded while the
      // optimistic bubble is up. The comment on `origin` claimed this filter existed long before it
      // did; adding the desktop as an emitter is what made its absence matter.
      if (e.origin === DESKTOP_ORIGIN) return;

      switch (e.domain) {
        case "repo":
          refreshNear();
          refreshFar();
          break;
        // A chain moved somewhere else — almost always a gate answered from a phone.
        //
        // **Reloading is only half of it, and it was the half that did nothing.** `approve_chain_gate`
        // is pure SQL: it clears the gate and puts the chain back to `queued`, and that is where the
        // chain sits forever unless somebody claims its next step. The claimer is `chainStore.pump`,
        // and it lives here, in this window — so a gate answered from the sofa used to redraw the
        // Agents tab with the gate gone and then leave the plan parked until the user walked back to
        // the desk. This is the line that finishes the action.
        case "chains": {
          const store = useChainStore.getState();
          // `reloadChains` reads the *loaded* workspace and discards everything else, so for a chain
          // belonging elsewhere it would be a round trip whose answer cannot contain the row that
          // moved. The id is what advances it; the list is what this window draws.
          const here = !e.workspace || e.workspace === store.workspaceId;
          // Outside the `here` guard, and that is the point of it: the gate list spans every
          // workspace, so a plan parked — or freed — by a phone working somewhere else is exactly
          // the case the status bar has to keep up with. `reloadChains` asks for this too, so the
          // `here` branch below does not repeat it.
          if (!here) void store.refreshGates();
          if (here) {
            await store.reloadChains();
            // The open chain as well as the list: the gate that was just answered is very likely
            // the one on screen, and the list carries the chain row without its steps.
            const selected = store.selectedId;
            if (selected) void store.refresh(selected);
          }
          // The chain that actually moved, `remote` because it did: somebody asked for this from
          // another device, and that is what earns the exemption from the tray guard. It is pumped
          // by id and not out of the list, which is the whole reason the frame carries one — a chain
          // in another workspace is not in any list this window holds.
          if (e.chain) void useChainStore.getState().pump(e.chain, { remote: true });
          // And anything else here that is ready to move. A phone's action can unblock a chain it
          // did not name — finishing one plan frees the repository a second was queued on — and this
          // is the same sweep `app:foreground` runs. **Not** `remote`: nobody asked about these, so
          // they keep the tray guard, and a client too old to name its chain lands here.
          if (here) {
            for (const chain of useChainStore.getState().chains) {
              if (chain.status === "queued" && chain.id !== e.chain) {
                void useChainStore.getState().pump(chain.id);
              }
            }
          }
          break;
        }
        case "tasks":
          void useAgentsStore.getState().reloadTasks();
          break;
        // A review or an analysis run from a phone. Both write a `job_history` row on the Rust
        // side exactly as the desktop's own do — `review_pull_request` and
        // `analyze_working_changes` each call `add_job_history` themselves — so the result is
        // already durable by the time this arrives. What was missing was anyone re-reading it:
        // `jobsStore` is filled from the database at load and then only ever appended to by
        // *this* window's own jobs, which a remote run is not.
        // `refresh` and not `load`: `load` runs once per bucket by design (the AI panel calls it
        // on every mount) and returns immediately for any project whose panel has been opened, so
        // it could never pick up a row written by another device. See `jobsStore.refresh`.
        //
        // Awaited, and that ordering is load-bearing: the notification below carries a target that
        // selects this job, and `showJobInAiPanel` looks it up in `byProject` and returns silently
        // when it is absent. Raising the notification first would produce a row that does nothing
        // when tapped — which is the same "it says it happened and nothing happens" in a smaller
        // shape.
        case "reviews":
          if (e.project) await useJobsStore.getState().refresh(e.project);
          break;
        // A chat turn sent from a phone. The Activity list is what gains a row — a new
        // conversation, or a newer timestamp on an existing one — and it is loaded per project
        // and then cached, so without this the panel keeps showing the list as it was when the
        // panel was opened.
        //
        // The open transcript gets the turn too, when the frame says which conversation it belongs
        // to. This used to be the Activity row alone, on the reasoning that rewriting a transcript
        // under somebody would move what they are reading — true of a *reload*, and the reason
        // `chatStore.reconcile` appends instead and refuses to touch a conversation mid-turn. What
        // the old behaviour actually produced was a chat you could hold a conversation in from your
        // phone while the desk showed only your half of it.
        case "chat":
          if (e.project) {
            void useChatHistoryStore.getState().load(e.project);
            if (e.conversation) void useChatStore.getState().reconcile(e.project, e.conversation);
          }
          break;
      }

      // Refreshing silently was not enough: work appearing on screen with no explanation reads as
      // the app doing something on its own. The backend names the actions worth surfacing (see
      // `announce_for` in `remotectl/dispatch.rs`) — the many that are not, like staging a file or
      // a keystroke in a shell, arrive with no `action` and pass through here unremarked.
      if (e.action && isRemoteActionKey(e.action)) {
        notify({
          source: "remote",
          titleKey: e.action,
          // The device is the subject of the sentence, which is why it is the detail rather than
          // part of the key: "iPhone de Sebastián" is user data and is never translated.
          detail: e.device,
          // A review or an analysis that failed still files its row and still arrives here, so the
          // row it raises has to say which of the two happened. Anything without a status is a
          // success, which is what every emitter used to mean by saying nothing.
          status: e.status === "error" ? "error" : "info",
          // Somewhere to *go*, when the action produced something to look at. Without this the
          // row is inert — which is most of what "it says it happened and nothing happens" meant.
          // The job id is the one the run filed its output under, so selecting it opens the very
          // review or analysis the phone asked for.
          target:
            e.job && e.project
              ? { openAiPanel: true, projectId: e.project, select: { kind: "job", id: e.job } }
              : undefined,
          // Whatever the frame itself says, and nothing more. Only `Invalidate::Chains` carries a
          // workspace today (see `StateInvalidateEvent.workspace`), so most of these are honestly
          // `null`: the action happened on a phone, and this window has no business deciding it
          // belongs to whichever workspace happens to be in front of it here. Where a project *is*
          // named the target carries it, which is the route the notification centre already uses to
          // recover a workspace on its own.
          workspaceId: e.workspace ?? null,
        });
      }
    });

    return () => {
      refreshNear.cancel();
      refreshFar.cancel();
      void unlisten.then((f) => f());
      void unlistenInvalidate.then((f) => f());
    };
  }, []);

  // Background auto-fetch with a live countdown, gated on a user-configured interval
  // (min 10s, 0 = off). Ticks every second so the status bar can show "next fetch in Ns".
  useEffect(() => {
    if (!autoFetchSeconds || !project?.local_path) {
      useFetchTimerStore.getState().setRemaining(null);
      return;
    }
    useFetchTimerStore.getState().setRemaining(autoFetchSeconds);
    const id = setInterval(() => {
      const remaining = useFetchTimerStore.getState().remainingSeconds;
      if (remaining === null) return;
      if (remaining <= 1) {
        void useRepoStore.getState().fetch();
        useFetchTimerStore.getState().setRemaining(autoFetchSeconds);
      } else {
        useFetchTimerStore.getState().setRemaining(remaining - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [autoFetchSeconds, project?.local_path]);

  // Arriving somewhere fetches, quietly.
  //
  // The countdown above is the same fetch on a clock; this is the same fetch on the user. Opening
  // the app, picking a repository in the sidebar, opening a tool from the rail or a tab from the
  // bar — each is a moment where an ahead/behind count is about to be read, and reading one that
  // was true ten minutes ago is how "nothing to pull" turns out to be wrong. Declared *after* the
  // effect that calls `setRepoPath`, so by the time this runs the store already points at the
  // repository being arrived at rather than the one being left.
  //
  // No interval of its own, no cleanup: `backgroundFetch` owns how often this is allowed to
  // actually reach the remote, precisely because these are clicks and clicks come in bursts.
  useEffect(() => {
    backgroundFetch();
  }, [project?.local_path, activeView, apiWorkspace]);

  // And coming back to the window, through both of the doors that has.
  //
  // `focus` is alt-tab and clicking the app after a spell in a browser. `app:foreground` is the
  // close button's other half — the window was hidden to the tray, the webview kept running and
  // never lost focus, so there is no `focus` to wait for. Either way the repository has been out
  // of sight for a while, which is exactly when it is most likely to have moved.
  useEffect(() => {
    const onFocus = () => backgroundFetch();
    window.addEventListener("focus", onFocus);
    const unlisten = onAppForeground(() => backgroundFetch());
    return () => {
      window.removeEventListener("focus", onFocus);
      void unlisten.then((f) => f());
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      {/* `overflow-hidden` is load-bearing, not tidiness.
          This row is `min-h-0` so the column inside it can shrink, but nothing was clipping that
          column's *content*. With the terminal dock dragged tall, `min-h-[120px]` on the view above
          it plus the dock's own height can exceed the row, and the excess was painted below the
          row's bottom edge — straight under the status bar, which is a later sibling and therefore
          paints on top. The symptom was the shell's last line disappearing behind the bar. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          {/* A floor, not `min-h-0`, now that the terminal dock below yields space instead of
              overflowing: without one, a dock taller than the window would win the whole column
              and leave the view it docks *into* at zero height. This is the point past which the
              dock shrinks instead. Still far below the content's own height, so the item shrinks
              freely — which is all `min-h-0` was ever here for. */}
          <div data-tour="main-content" className="cf-ambient-bg min-h-[120px] flex-1 overflow-hidden">
            <MainContent />
          </div>
          {/* The boundary sits *inside* `AnimatePresence` and keeps the dock's key, so presence is
              still tracked per-dock and the height exit animation still runs (the dock's own
              `motion.div` reads the presence context through the `Suspense`, which is just another
              component in the tree). The fallback is `null` rather than a placeholder on purpose:
              the dock animates open from zero height anyway, so "nothing yet" is what the frame
              before it looks like either way — a shimmering bar at full height would be the only
              way to make the chunk load visible. In practice it is never reached: this chunk is in
              `WARM_CHUNKS` and is fetched on the first idle callback after boot. */}
          <AnimatePresence initial={false}>
            {terminalPanelOpen && (
              <Suspense key="terminal-dock" fallback={null}>
                <TerminalDock />
              </Suspense>
            )}
          </AnimatePresence>
        </div>
        {/* Between the view and the chat, and a sibling of both: the workspace's apps are a column
            of the window, so opening or closing the AI panel slides past the rail rather than
            moving it, and the terminal dock — which lives *inside* the column above — rises
            without pushing it around either. */}
        <AppRail />
        <AnimatePresence initial={false}>{aiPanelOpen && <AiPanel key="ai-panel" />}</AnimatePresence>
      </div>
      {/* The update notice hangs off the top edge of the status bar, so it's anchored to the bar
          itself instead of to a viewport offset that would have to be kept in sync by hand. */}
      {/* `shrink-0`: the bar is a fixed 24px strip and must never be squeezed by a tall dock above
          it. As a plain flex item it had `flex-shrink: 1`, so with the column overflowing it was
          the bar that gave way — which is the other half of the last line ending up underneath it. */}
      <div className="relative shrink-0">
        <UpdateAlert />
        <StatusBar />
      </div>
      {/* Mounted at the top rather than inside the editor: the request comes from a CodeLens, which
          reaches React through a Monaco command id rather than through the component tree, and the
          dialog outlives whichever pane raised it. It draws nothing until the store holds a target. */}
      <AddDependencyModal />
      {/* Gated on `settingsOpen` here rather than mounted always and returning `null` from inside,
          which is what it used to do. The two are equivalent — a component that returns `null`
          renders no children either — and the gate is what lets the panel be a lazy chunk at all:
          rendered unconditionally it would be fetched at boot, which is the whole cost being
          avoided. Checked before moving it: the Escape handler inside `SettingsView` already
          starts with `if (!open) return`, so it never listened while closed and nothing about the
          Escape key changes. */}
      {settingsOpen && (
        <Suspense fallback={<SettingsSkeleton />}>
          <SettingsView />
        </Suspense>
      )}
      {/* All four are reachable from the keyboard anywhere in the app, so they're mounted at the
          root rather than inside whichever panel happens to have a button for them. A boundary
          each, never a shared one — a shared boundary would blank whichever of them was already
          open while another loaded. */}
      {commandPaletteOpen && (
        <Suspense fallback={<PaletteSkeleton />}>
          <CommandPalette scope={commandPaletteScope} onClose={closeCommandPalette} />
        </Suspense>
      )}
      {shortcutsModalOpen && (
        <Suspense fallback={<PaletteSkeleton />}>
          <ShortcutsModal onClose={closeShortcutsModal} />
        </Suspense>
      )}
      {branchSwitcherOpen && (
        <Suspense fallback={<PaletteSkeleton />}>
          <BranchSwitcherModal onClose={closeBranchSwitcher} />
        </Suspense>
      )}
      {prLinkModalOpen && (
        <Suspense fallback={<PaletteSkeleton />}>
          <OpenPrLinkModal onClose={closePrLinkModal} />
        </Suspense>
      )}
      {/* Owns its own open flag rather than one in uiStore: nothing but the update badge and the
          Settings panel ever opens it, and both go through the update store already. */}
      <UpdateNotesModal />
      {/* Only ever drawn on the first launch of an installation, and only if that launch found
          something broken. Silent on a clean machine and on every launch after. */}
      <RequirementsModal />
      <ToastContainer />
      {/* Watches the notification store rather than being pushed to, so every `notify` gets a card
          — including the ones a paired phone raises, which no call site here knows about. */}
      <NotificationPopups />
      <ConfirmModal />
      <PromptModal />
      {/* Last, and above everything: the guided tour dims the whole window and drives the panels
          above from its own steps, so it has to outrank every modal it walks the user through. */}
      <TourOverlay />
    </div>
  );
}
