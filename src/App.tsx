import { useEffect, useState, type ReactElement } from "react";
import { AnimatePresence } from "framer-motion";
import { FolderGit2 } from "lucide-react";
import { useT } from "./state/languageStore";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { TabBar } from "./components/layout/TabBar";
import { StatusBar } from "./components/layout/StatusBar";
import { GraphView } from "./components/git/GraphView";
import { ChangesPanel } from "./components/git/ChangesPanel";
import { AiPanel } from "./components/ai/AiPanel";
import { EditorView } from "./components/editor/EditorView";
import { ApiView } from "./components/api/ApiView";
import { TerminalDock } from "./components/terminal/TerminalDock";
import { SettingsView } from "./components/settings/SettingsView";
import { CommandPalette } from "./components/layout/CommandPalette";
import { ShortcutsModal } from "./components/layout/ShortcutsModal";
import { BranchSwitcherModal } from "./components/layout/BranchSwitcherModal";
import { OpenPrLinkModal } from "./components/layout/OpenPrLinkModal";
import { UpdateNotesModal } from "./components/layout/UpdateNotesModal";
import { UpdateAlert } from "./components/layout/UpdateAlert";
import { EmptyState } from "./components/common/EmptyState";
import { ToastContainer } from "./components/common/Toast";
import { ConfirmModal } from "./components/common/ConfirmModal";
import { useThemeStore } from "./state/themeStore";
import { useUiStore, type MainView } from "./state/uiStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useLayoutStore } from "./state/layoutStore";
import { useRepoStore } from "./state/repoStore";
import { useApiStore } from "./state/apiStore";
import { usePreferencesStore } from "./state/preferencesStore";
import { useAiProviderStore } from "./state/aiProviderStore";
import { useLanguageStore } from "./state/languageStore";
import { useAccentStore } from "./state/accentStore";
import { useFetchTimerStore } from "./state/fetchTimerStore";
import { useUpdateStore, CHECK_INTERVAL_MS } from "./state/updateStore";
import { useNavigationStore } from "./state/navigationStore";
import { useTerminalStore } from "./state/terminalStore";
import { useShortcutsStore } from "./state/shortcutsStore";
import { useGlobalShortcuts } from "./lib/useGlobalShortcuts";
import { startWatching, stopWatching } from "./lib/tauri/commands";
import { onRepoFsChanged } from "./lib/tauri/events";

const PROJECT_VIEWS: { id: MainView; render: () => ReactElement }[] = [
  { id: "graph", render: () => <GraphView /> },
  { id: "changes", render: () => <ChangesPanel /> },
  { id: "editor", render: () => <EditorView /> },
];

/** Views that aren't about a repository, so the "no project open" empty state must not swallow
 * them — but that do belong to a workspace. The API client owns the workspace's
 * collections/environments and is expected to be usable before any repo has been added to it. */
const WORKSPACE_VIEWS: { id: MainView; render: () => ReactElement }[] = [
  { id: "api", render: () => <ApiView /> },
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
  const project = useWorkspaceStore((s) => s.activeProject());
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setRepoPath = useRepoStore((s) => s.setRepoPath);
  const autoFetchSeconds = usePreferencesStore((s) => s.autoFetchSeconds);
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const accentId = useAccentStore((s) => s.accentId);
  const activeView = useUiStore((s) => s.activeView);
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
      await Promise.all([
        initTheme(),
        initLayout(),
        initPreferences(),
        initLanguage(),
        initAccent(),
        initTerminal(),
        initAiProvider(),
        initShortcuts(),
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
  }, [project?.local_path, setRepoPath]);

  // The API client's collections, environments, history and cookies belong to the workspace, so
  // a switch has to swap them the way the repo above swaps. Only the id is passed: the store
  // owns the teardown of what the previous workspace left running (live WebSocket/MQTT
  // connections, open request tabs), so there is nothing here to keep in step with it.
  useEffect(() => {
    if (!workspaceId) return;
    void useApiStore.getState().setWorkspace(workspaceId);
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

  // Records every view/project change onto the back/forward history — TitleBar's
  // chevrons just replay entries from this stack.
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

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className="cf-ambient-bg min-h-0 flex-1 overflow-hidden">
            <MainContent />
          </div>
          <AnimatePresence initial={false}>
            {terminalPanelOpen && <TerminalDock key="terminal-dock" />}
          </AnimatePresence>
        </div>
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
      <ToastContainer />
      <ConfirmModal />
    </div>
  );
}
