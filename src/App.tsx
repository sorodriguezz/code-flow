import { useEffect, useState, type ReactElement } from "react";
import { FolderGit2 } from "lucide-react";
import { useT } from "./state/languageStore";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { TabBar } from "./components/layout/TabBar";
import { StatusBar } from "./components/layout/StatusBar";
import { GraphView } from "./components/git/GraphView";
import { ChangesPanel } from "./components/git/ChangesPanel";
import { ChatPanel } from "./components/chat/ChatPanel";
import { EditorView } from "./components/editor/EditorView";
import { TerminalView } from "./components/terminal/TerminalView";
import { SettingsView } from "./components/settings/SettingsView";
import { EmptyState } from "./components/common/EmptyState";
import { ToastContainer } from "./components/common/Toast";
import { useThemeStore } from "./state/themeStore";
import { useUiStore, type MainView } from "./state/uiStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useLayoutStore } from "./state/layoutStore";
import { useRepoStore } from "./state/repoStore";
import { usePreferencesStore } from "./state/preferencesStore";
import { useLanguageStore } from "./state/languageStore";
import { useAccentStore } from "./state/accentStore";
import { useFetchTimerStore } from "./state/fetchTimerStore";
import { useNavigationStore } from "./state/navigationStore";
import { startWatching, stopWatching } from "./lib/tauri/commands";
import { onRepoFsChanged } from "./lib/tauri/events";

const PROJECT_VIEWS: { id: MainView; render: () => ReactElement }[] = [
  { id: "graph", render: () => <GraphView /> },
  { id: "changes", render: () => <ChangesPanel /> },
  { id: "editor", render: () => <EditorView /> },
  { id: "terminal", render: () => <TerminalView /> },
  { id: "chat", render: () => <ChatPanel /> },
];

function MainContent() {
  const activeView = useUiStore((s) => s.activeView);
  const project = useWorkspaceStore((s) => s.activeProject());
  const [visited, setVisited] = useState<Set<MainView>>(new Set());
  const t = useT();

  useEffect(() => {
    setVisited((prev) => (prev.has(activeView) ? prev : new Set(prev).add(activeView)));
  }, [activeView]);

  if (!project) {
    return (
      <EmptyState icon={FolderGit2} title={t("common.noProjectOpen")} subtitle={t("common.openProjectHint")} />
    );
  }

  // Once a project view has been opened it stays mounted (just hidden) so switching
  // tabs doesn't kill in-progress state — most importantly the Terminal's shell
  // session, which would otherwise restart every time you tabbed away from it. Views
  // never opened yet aren't mounted at all, so e.g. no shell process spawns for a
  // project until the user actually opens the Terminal tab.
  return (
    <>
      {PROJECT_VIEWS.filter(({ id }) => visited.has(id)).map(({ id, render }) => (
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
  const project = useWorkspaceStore((s) => s.activeProject());
  const setRepoPath = useRepoStore((s) => s.setRepoPath);
  const autoFetchSeconds = usePreferencesStore((s) => s.autoFetchSeconds);
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const accentId = useAccentStore((s) => s.accentId);
  const activeView = useUiStore((s) => s.activeView);

  useEffect(() => {
    (async () => {
      await Promise.all([initTheme(), initLayout(), initPreferences(), initLanguage(), initAccent()]);
      useAccentStore.getState().apply(useThemeStore.getState().resolved);
    })();
  }, [initTheme, initLayout, initPreferences, initLanguage, initAccent]);

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
      void useRepoStore.getState().refreshStatus();
      void useRepoStore.getState().refreshCommits();
      void useRepoStore.getState().refreshUnpushedCommits();
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
          <div className="min-h-0 flex-1 overflow-hidden">
            <MainContent />
          </div>
        </div>
      </div>
      <StatusBar />
      <SettingsView />
      <ToastContainer />
    </div>
  );
}
