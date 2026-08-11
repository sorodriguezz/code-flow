import { useEffect, useState, type ReactElement } from "react";
import { AnimatePresence } from "framer-motion";
import { FolderGit2 } from "lucide-react";
import { useT } from "./state/languageStore";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { TabBar } from "./components/layout/TabBar";
import { AppRail } from "./components/layout/AppRail";
import { StatusBar } from "./components/layout/StatusBar";
import { GraphView } from "./components/git/GraphView";
import { ChangesPanel } from "./components/git/ChangesPanel";
import { AiPanel } from "./components/ai/AiPanel";
import { EditorView } from "./components/editor/EditorView";
import { ApiView } from "./components/api/ApiView";
import { AgentsView } from "./components/agents/AgentsView";
import { StoriesView } from "./components/stories/StoriesView";
import { RemoteView } from "./components/remote/RemoteView";
import { TerminalDock } from "./components/terminal/TerminalDock";
import { SettingsView } from "./components/settings/SettingsView";
import { CommandPalette } from "./components/layout/CommandPalette";
import { ShortcutsModal } from "./components/layout/ShortcutsModal";
import { BranchSwitcherModal } from "./components/layout/BranchSwitcherModal";
import { OpenPrLinkModal } from "./components/layout/OpenPrLinkModal";
import { UpdateNotesModal } from "./components/layout/UpdateNotesModal";
import { RequirementsModal } from "./components/layout/RequirementsModal";
import { UpdateAlert } from "./components/layout/UpdateAlert";
import { EmptyState } from "./components/common/EmptyState";
import { ToastContainer } from "./components/common/Toast";
import { ConfirmModal } from "./components/common/ConfirmModal";
import { PromptModal } from "./components/common/PromptModal";
import { TourOverlay } from "./components/tour/TourOverlay";
import { useThemeStore } from "./state/themeStore";
import { useUiStore, type MainView } from "./state/uiStore";
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
import { useTourStore } from "./state/tourStore";
import { useRequirementsStore } from "./state/requirementsStore";
import { useGlobalShortcuts } from "./lib/useGlobalShortcuts";
import { startWindowBoundsTracking } from "./lib/windowControls";
import { backgroundFetch } from "./lib/backgroundFetch";
import { startWatching, stopWatching } from "./lib/tauri/commands";
import { onAppForeground, onRepoFsChanged } from "./lib/tauri/events";

const PROJECT_VIEWS: { id: MainView; render: () => ReactElement }[] = [
  { id: "graph", render: () => <GraphView /> },
  { id: "changes", render: () => <ChangesPanel /> },
  { id: "editor", render: () => <EditorView /> },
];

/** Views that aren't about a repository, so the "no project open" empty state must not swallow
 * them — but that do belong to a workspace. The API client owns the workspace's
 * collections/environments and is expected to be usable before any repo has been added to it;
 * the agent console owns the workspace's agent roster, which is likewise defined before there is
 * anything for an agent to work on. The user-stories workspace is the clearest case of all: a
 * requirement is written *before* the code that satisfies it, and often before the repo exists.
 * The Remote workspace owns the machines a workspace deploys to, which likewise don't change when
 * you click a different repository. */
const WORKSPACE_VIEWS: { id: MainView; render: () => ReactElement }[] = [
  { id: "api", render: () => <ApiView /> },
  { id: "agents", render: () => <AgentsView /> },
  { id: "stories", render: () => <StoriesView /> },
  { id: "remote", render: () => <RemoteView /> },
];

function MainContent() {
  const activeView = useUiStore((s) => s.activeView);
  const project = useWorkspaceStore((s) => s.activeProject());
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [visited, setVisited] = useState<Set<MainView>>(new Set());
  const t = useT();

  useEffect(() => {
    setVisited((prev) => (prev.has(activeView) ? prev : new Set(prev).add(activeView)));
  }, [activeView]);

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
  return (
    <>
      {project &&
        PROJECT_VIEWS.filter(({ id }) => visited.has(id)).map(({ id, render }) => (
          <div key={id} className={activeView === id ? "h-full" : "hidden"}>
            {render()}
          </div>
        ))}
      {workspaceId !== null &&
        WORKSPACE_VIEWS.filter(({ id }) => visited.has(id)).map(({ id, render }) => (
          <div key={id} className={activeView === id ? "h-full" : "hidden"}>
            {render()}
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
  const initTour = useTourStore((s) => s.init);
  const initRequirements = useRequirementsStore((s) => s.init);
  const project = useWorkspaceStore((s) => s.activeProject());
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setRepoPath = useRepoStore((s) => s.setRepoPath);
  const autoFetchSeconds = usePreferencesStore((s) => s.autoFetchSeconds);
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const accentId = useAccentStore((s) => s.accentId);
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

  useGlobalShortcuts();

  useEffect(() => {
    (async () => {
      // Ahead of the batch, and on its own, because its answer decides one thing inside it.
      //
      // On every launch but the first of an installation this is a single settings read that
      // returns immediately — the flag is set and nothing is probed. Only on that first launch does
      // it cost a `git --version` and a file write, and only then can it come back saying the tour
      // must not open itself over the dialog it is about to show. Ordering stated rather than left
      // to a 1100 ms timer to win by being slower. See `requirementsStore`.
      const clearToTour = await initRequirements();
      await Promise.all([
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
        // Reads whether the guided tour has already been run, and — if it hasn't — arms the
        // first-launch opening. Deliberately inside this batch: the tour rearranges panels, and
        // it must not start before the layout and language it rearranges have loaded.
        initTour({ autoOpen: clearToTour }),
        // Starts before the user can reach the maximize button, so the size the window opened at is
        // already recorded as somewhere to restore to.
        startWindowBoundsTracking(),
      ]);
      useAccentStore.getState().apply(useThemeStore.getState().resolved);
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
    initTour,
    initRequirements,
  ]);

  // Re-apply the chosen accent whenever the resolved theme or the accent selection changes,
  // since the actual hex differs per theme (a lighter shade is used on dark backgrounds).
  useEffect(() => {
    useAccentStore.getState().apply(resolvedTheme);
  }, [resolvedTheme, accentId]);

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
  // connections, open request tabs), so there is nothing here to keep in step with it.
  useEffect(() => {
    if (!workspaceId) return;
    void useApiStore.getState().setWorkspace(workspaceId);
    // The database workspace is scoped the same way and swaps on the same signal: its connections,
    // saved consoles and query history belong to the workspace, and its live sessions belong to the
    // connections it is about to drop.
    void useDbStore.getState().setWorkspace(workspaceId);
    // And the Remote workspace, whose hosts belong to the workspace and whose open sessions are
    // `ssh` processes belonging to those hosts — so the switch has to close them rather than leave
    // children behind that nothing on screen names.
    void useRemoteStore.getState().setWorkspace(workspaceId);
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
    };
  }, [project?.local_path]);

  useEffect(() => {
    const unlisten = onRepoFsChanged((e) => {
      const activePath = useWorkspaceStore.getState().activeProject()?.local_path;
      if (e.repo_path !== activePath) return;
      // Full refresh, not just status/commits — an external change can just as easily be a
      // branch switch, a stash, or a merge (all of which used to go stale until something
      // else happened to trigger a refresh).
      void useRepoStore.getState().refreshAll();
    });
    return () => {
      void unlisten.then((f) => f());
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
      <div className="flex min-h-0 flex-1">
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
          <AnimatePresence initial={false}>
            {terminalPanelOpen && <TerminalDock key="terminal-dock" />}
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
      <div className="relative">
        <UpdateAlert />
        <StatusBar />
      </div>
      <SettingsView />
      {/* All four are reachable from the keyboard anywhere in the app, so they're mounted at the
          root rather than inside whichever panel happens to have a button for them. */}
      {commandPaletteOpen && <CommandPalette scope={commandPaletteScope} onClose={closeCommandPalette} />}
      {shortcutsModalOpen && <ShortcutsModal onClose={closeShortcutsModal} />}
      {branchSwitcherOpen && <BranchSwitcherModal onClose={closeBranchSwitcher} />}
      {prLinkModalOpen && <OpenPrLinkModal onClose={closePrLinkModal} />}
      {/* Owns its own open flag rather than one in uiStore: nothing but the update badge and the
          Settings panel ever opens it, and both go through the update store already. */}
      <UpdateNotesModal />
      {/* Only ever drawn on the first launch of an installation, and only if that launch found
          something broken. Silent on a clean machine and on every launch after. */}
      <RequirementsModal />
      <ToastContainer />
      <ConfirmModal />
      <PromptModal />
      {/* Last, and above everything: the guided tour dims the whole window and drives the panels
          above from its own steps, so it has to outrank every modal it walks the user through. */}
      <TourOverlay />
    </div>
  );
}
