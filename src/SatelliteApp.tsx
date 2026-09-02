import { Suspense, lazy, useEffect, useState, type ReactElement } from "react";
import { AnimatePresence } from "framer-motion";
import { FolderGit2, Unlink } from "lucide-react";
import { EmptyState } from "./components/common/EmptyState";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { SatelliteTitleBar } from "./components/layout/SatelliteTitleBar";
import { ToastContainer } from "./components/common/Toast";
import { ConfirmModal } from "./components/common/ConfirmModal";
import { PromptModal } from "./components/common/PromptModal";
import { ViewSkeleton } from "./components/common/ViewSkeleton";
import { useAccentStore } from "./state/accentStore";
import { useFileNestingStore } from "./state/fileNestingStore";
import { useIconRulesStore } from "./state/iconRulesStore";
import { useLanguageStore, useT } from "./state/languageStore";
import { useLayoutStore } from "./state/layoutStore";
import { usePreferencesStore } from "./state/preferencesStore";
import { useRepoStore } from "./state/repoStore";
import { useTerminalStore } from "./state/terminalStore";
import { useThemeStore } from "./state/themeStore";
import { useUiStore, type ApiWorkspace, type MainView } from "./state/uiStore";
import { useWindowStore } from "./state/windowStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useShortcutsStore } from "./state/shortcutsStore";
import { useAiProviderStore } from "./state/aiProviderStore";
import { onWindowMessage } from "./lib/windowBus";
import { WINDOW } from "./lib/windowIdentity";
import { startWindowBoundsTracking } from "./lib/windowControls";

/**
 * The whole of a satellite window.
 *
 * # What is deliberately not here
 *
 * No sidebar, no app rail, no tab bar, no settings, no command palette, no guided tour, no
 * notification centre, no update checker. Not as an economy — as the definition: a satellite holds
 * one thing, and every one of those is a way to make it hold something else. They are also the
 * heaviest part of the shell, so leaving them out is what makes a second window cost tens of
 * megabytes rather than the whole app again. `window.html` is a separate Vite entry so this is
 * enforced by the bundle rather than by discipline (see `vite.config.ts`).
 *
 * # What it follows
 *
 * The workspace the **main window** is showing, always. That answers the question this design was
 * argued over: an app window still displaying the collections of a workspace the user has left is
 * the one behaviour ruled out, because it is the one where what is on screen is quietly about
 * something else. The main window broadcasts every switch (`lib/windowBus`), and a window opened
 * later picks up the same answer from the setting the main window keeps current.
 *
 * A **repository** window is the case that needs more than "follow": a repository lives in exactly
 * one workspace, so when the main window moves elsewhere there is nothing here to show. It says so
 * and waits, rather than closing — closing would take a window off the desk for a trip to another
 * workspace and back — and comes back on its own.
 */

const ApiView = lazy(() => import("./components/api/ApiView").then((m) => ({ default: m.ApiView })));
const AgentsView = lazy(() => import("./components/agents/AgentsView").then((m) => ({ default: m.AgentsView })));
const StoriesView = lazy(() => import("./components/stories/StoriesView").then((m) => ({ default: m.StoriesView })));
const RemoteView = lazy(() => import("./components/remote/RemoteView").then((m) => ({ default: m.RemoteView })));
const NotesView = lazy(() => import("./components/notes/NotesView").then((m) => ({ default: m.NotesView })));
const VaultView = lazy(() => import("./components/vault/VaultView").then((m) => ({ default: m.VaultView })));
const DiagramsView = lazy(() =>
  import("./components/diagrams/DiagramsView").then((m) => ({ default: m.DiagramsView })),
);
const GraphView = lazy(() => import("./components/git/GraphView").then((m) => ({ default: m.GraphView })));
const ChangesPanel = lazy(() => import("./components/git/ChangesPanel").then((m) => ({ default: m.ChangesPanel })));
const EditorView = lazy(() => import("./components/editor/EditorView").then((m) => ({ default: m.EditorView })));
const PipelinesView = lazy(() =>
  import("./components/pipelines/PipelinesView").then((m) => ({ default: m.PipelinesView })),
);
// The same bottom panel the main window has, minus its services half — a satellite may not start
// processes. See `ServicesDock`.
const ServicesDock = lazy(() =>
  import("./components/services/ServicesDock").then((m) => ({ default: m.ServicesDock })),
);

/**
 * The rail apps a window can hold, keyed by the id the rail uses.
 *
 * The same ids `AppRail` builds its buttons from, because they are what the window's identity is
 * written in — `sat-app-api_requests` is the API client's window on any machine, in any language,
 * across restarts.
 */
const APP_VIEWS: Record<string, { view: MainView; workspace?: ApiWorkspace; render: () => ReactElement }> = {
  "api:requests": { view: "api", workspace: "requests", render: () => <ApiView /> },
  "api:database": { view: "api", workspace: "database", render: () => <ApiView /> },
  agents: { view: "agents", render: () => <AgentsView /> },
  stories: { view: "stories", render: () => <StoriesView /> },
  remote: { view: "remote", render: () => <RemoteView /> },
  notes: { view: "notes", render: () => <NotesView /> },
  diagrams: { view: "diagrams", render: () => <DiagramsView /> },
  vault: { view: "vault", render: () => <VaultView /> },
};

/** The four tabs a repository window carries — the same set, and the same order, as the main
 *  window's tab bar. Pipelines is conditional there and conditional here for the same reason. */
const REPO_TABS: { id: MainView; labelKey: "tabbar.graph" | "tabbar.changes" | "tabbar.editor" | "tabbar.pipelines"; render: () => ReactElement }[] = [
  { id: "graph", labelKey: "tabbar.graph", render: () => <GraphView /> },
  { id: "changes", labelKey: "tabbar.changes", render: () => <ChangesPanel /> },
  { id: "editor", labelKey: "tabbar.editor", render: () => <EditorView /> },
  { id: "pipelines", labelKey: "tabbar.pipelines", render: () => <PipelinesView /> },
];

/** Everything a view needs to be able to read, and nothing the shell needed. */
function useSatelliteBoot(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      await Promise.all([
        useThemeStore.getState().init(),
        useLayoutStore.getState().init(),
        usePreferencesStore.getState().init(),
        useLanguageStore.getState().init(),
        useAccentStore.getState().init(),
        useTerminalStore.getState().init(),
        useAiProviderStore.getState().init(),
        useShortcutsStore.getState().init(),
        useIconRulesStore.getState().init(),
        useFileNestingStore.getState().init(),
        // The satellite draws its own title bar too, so the maximize button needs the same
        // rectangle tracking the main window's does.
        startWindowBoundsTracking(),
        useWindowStore.getState().init(),
        // Lands on whatever workspace the main window last wrote down, which is the workspace it is
        // showing right now — see `workspaceStore`'s `LAST_WORKSPACE_KEY`. No request to the main
        // window and no waiting for one: a satellite opened while main sits on "Tienda" opens on
        // "Tienda", and the bus keeps it there afterwards.
        useWorkspaceStore.getState().loadWorkspaces(),
      ]);
      useAccentStore.getState().apply(useThemeStore.getState().resolved);
      setReady(true);
    })();
  }, []);

  // Follows the main window from here on. Not a subscription to a store — the store is per-window —
  // but to the one channel that crosses the boundary.
  useEffect(
    () =>
      onWindowMessage((message) => {
        if (message.kind === "workspace") {
          void useWorkspaceStore.getState().followWorkspace(message.workspaceId);
        }
      }),
    [],
  );

  return ready;
}

/** The window that holds one app from the rail. */
function AppWindow({ refId }: { refId: string }) {
  const entry = APP_VIEWS[refId];
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const t = useT();

  // The view reads which sub-tool to show from `uiStore` — the API tab holds two — so the window's
  // identity is written there once rather than threaded through as a prop the main window never
  // passes.
  useEffect(() => {
    if (!entry) return;
    useUiStore.setState({
      activeView: entry.view,
      ...(entry.workspace ? { apiWorkspace: entry.workspace } : {}),
    });
  }, [entry]);

  if (!entry) {
    return <EmptyState icon={Unlink} title={t("windows.unknownApp")} subtitle={refId} />;
  }
  if (!workspaceId) {
    return <EmptyState icon={FolderGit2} title={t("common.noProjectOpen")} />;
  }

  return (
    <ErrorBoundary resetKey={refId}>
      <Suspense fallback={<ViewSkeleton />}>{entry.render()}</Suspense>
    </ErrorBoundary>
  );
}

/** The window that holds one repository: the same four tabs, its own terminal dock. */
function RepoWindow({ projectId }: { projectId: string }) {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projects = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? s.projectsByWorkspace[s.activeWorkspaceId] : undefined,
  );
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const setRepoPath = useRepoStore((s) => s.setRepoPath);
  const terminalPanelOpen = useTerminalStore((s) => s.panelOpen);
  const [tab, setTab] = useState<MainView>("graph");
  const t = useT();

  const project = projects?.find((p) => p.id === projectId) ?? null;

  // Points this window's own copy of `repoStore` at the repository it holds. Per-window state over
  // a process-wide git engine: two windows on two repositories are two `repoStore`s and one Rust
  // side, which is exactly the split that makes a second window cheap.
  useEffect(() => {
    if (!project) return;
    setActiveProject(project.id);
    void setRepoPath(project.local_path);
  }, [project, setActiveProject, setRepoPath]);

  // The main window has moved to a workspace this repository is not in. Nothing to show, and
  // showing the previous workspace's repository anyway is the one thing this design refuses. It
  // waits rather than closing: a trip to another workspace and back should not cost the window.
  if (workspaceId && projects && !project) {
    return (
      <EmptyState
        icon={FolderGit2}
        title={t("windows.repoElsewhereTitle")}
        subtitle={t("windows.repoElsewhereBody")}
      />
    );
  }

  if (!project) return <ViewSkeleton />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 border-b border-[var(--cf-border)] bg-[var(--cf-bg-elevated)] text-[12px]">
        {REPO_TABS.map(({ id, labelKey }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`border-r border-[var(--cf-border)] px-3 py-1.5 transition-colors ${
              tab === id
                ? "bg-[var(--cf-bg)] text-[var(--cf-text)] shadow-[inset_0_-1px_0_var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      {/* Same rule as the main window: a tab that has been opened stays mounted so switching away
          does not kill what is running in it — the editor's models, a pipeline's polling. Never
          visited, never mounted. */}
      <div className="cf-ambient-bg min-h-[120px] flex-1 overflow-hidden">
        <RepoTabs tab={tab} />
      </div>
      <AnimatePresence initial={false}>
        {terminalPanelOpen && (
          <Suspense key="terminal-dock" fallback={null}>
            <ServicesDock />
          </Suspense>
        )}
      </AnimatePresence>
    </div>
  );
}

function RepoTabs({ tab }: { tab: MainView }) {
  const [visited, setVisited] = useState<Set<MainView>>(new Set(["graph"]));
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  return (
    <>
      {REPO_TABS.filter(({ id }) => visited.has(id)).map(({ id, render }) => (
        <div key={id} className={tab === id ? "h-full" : "hidden"}>
          <ErrorBoundary resetKey={id}>
            <Suspense fallback={<ViewSkeleton />}>{render()}</Suspense>
          </ErrorBoundary>
        </div>
      ))}
    </>
  );
}

export default function SatelliteApp() {
  const ready = useSatelliteBoot();
  const spec = WINDOW.satellite;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SatelliteTitleBar />
      <div className="min-h-0 flex-1 overflow-hidden">
        {!ready || !spec ? (
          <ViewSkeleton />
        ) : spec.kind === "app" ? (
          <AppWindow refId={spec.refId} />
        ) : (
          <RepoWindow projectId={spec.refId} />
        )}
      </div>
      {/* The three the views actually reach for. Everything else the main window mounts at its root
          — the palette, the settings panel, the tour, the notification cards — belongs to the shell
          this window does not have. */}
      <ToastContainer />
      <ConfirmModal />
      <PromptModal />
    </div>
  );
}
