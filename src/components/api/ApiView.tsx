import { useCallback, useEffect } from "react";
import { Download, Plus, Users, Zap, type LucideIcon } from "lucide-react";
import { ApiSidebar } from "./ApiSidebar";
import { DatabaseView } from "../db/DatabaseView";
import { RequestTabs } from "./RequestTabs";
import { RequestBuilder } from "./RequestBuilder";
import { EntitySettingsView } from "./EntitySettingsView";
import { CodeSnippetPanel } from "./CodeSnippetPanel";
import { EnvironmentModal } from "./EnvironmentModal";
import { ImportModal } from "./ImportModal";
import { ExportModal } from "./ExportModal";
import { DocsModal } from "./DocsModal";
import { RunnerModal } from "./RunnerModal";
import { CookieModal } from "./CookieModal";
import { CollabModal } from "./CollabModal";
import { ConflictModal } from "./ConflictModal";
import { tabActions } from "./tabActions";
import { CARD } from "./panelChrome";
import { EmptyState } from "../common/EmptyState";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { useApiCommandStore } from "../../state/apiCommandStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useUiStore } from "../../state/uiStore";
import { useToastStore } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * The API client's shell: sidebar, tab strip, request builder, response pane and the code-snippet
 * panel. Every panel below reads `apiStore`/`apiRuntimeStore` on its own — this file only decides
 * what is on screen, owns the modals, and answers the three keyboard shortcuts: ⌘S through the
 * shortcut registry's `apiCommandStore`, ⌘Enter and ⌘W on its own listener.
 *
 * There is deliberately no toolbar row of its own: the environment picker sits at the foot of the
 * sidebar and every action it used to hold lives in the sidebar header or its overflow menu, so
 * the request builder starts at the top of the window.
 */

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function ApiEmptyState() {
  const t = useT();
  const openModal = useApiModalStore((s) => s.openApiModal);
  const collections = useApiStore((s) => s.collections);
  const pushToast = useToastStore((s) => s.pushToast);

  const newCollection = async () => {
    const created = await useApiStore.getState().createCollection(t("api.untitledCollection"));
    if (created) pushToast(t("api.toast.collectionCreated", { name: created.name }), "success");
  };

  const action = (label: string, icon: LucideIcon, onClick: () => void, primary = false) => {
    const Icon = icon;
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium ${
          primary
            ? "bg-[var(--cf-accent)] text-white hover:brightness-110"
            : "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        }`}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3">
      {/* No fixed height. `EmptyState` is `h-full`, and a percentage height against a content-sized
          parent resolves to `auto` — so it sizes to its own content and its internal centring is
          simply a no-op, which is right here because the column outside already centres the whole
          group. The 150px this used to carry was a guess that a two-line subtitle overflowed. */}
      <div className="w-full">
        {/* The subtitle says "this workspace" rather than just "no collections": an empty API view
            straight after a workspace switch otherwise reads as "my collections are gone". */}
        <EmptyState
          icon={Zap}
          title={t("api.title")}
          subtitle={collections.length === 0 ? t("api.noCollectionsInWorkspace") : undefined}
        />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {action(t("api.newRequest"), Plus, () => useApiStore.getState().openScratchTab(), true)}
        {action(t("api.newCollection"), Plus, () => void newCollection())}
        {action(t("api.import.title"), Download, () => openModal({ kind: "import" }))}
        {action(t("api.collab.importCollaborative"), Users, () => openModal({ kind: "collab" }))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ApiView() {
  const t = useT();
  const openTabs = useApiStore((s) => s.openTabs);
  const entityTabs = useApiStore((s) => s.entityTabs);
  const tabOrder = useApiStore((s) => s.tabOrder);
  const activeTabId = useApiStore((s) => s.activeTabId);
  const activeView = useUiStore((s) => s.activeView);
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);
  const modal = useApiModalStore((s) => s.modal);
  const closeModal = useApiModalStore((s) => s.closeApiModal);

  useEffect(() => {
    void ensureApiStoreLoaded();
  }, []);

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeEntity = entityTabs.find((tab) => tab.id === activeTabId) ?? null;

  const closeActiveTab = useCallback(async () => {
    const store = useApiStore.getState();
    const tab =
      store.openTabs.find((candidate) => candidate.id === store.activeTabId) ??
      store.entityTabs.find((candidate) => candidate.id === store.activeTabId);
    if (!tab) return;
    if (tab.dirty) {
      const name = tab.name || t("api.untitledRequest");
      if (!(await confirmAction(t("editor.closeDirtyConfirm", { name })))) return;
    }
    useApiStore.getState().closeTab(tab.id);
  }, [t]);

  /**
   * ⌘S, arriving through `apiCommandStore` rather than through the listener below.
   *
   * It used to be a branch in that listener and it never once ran: ⌘S is a registered shortcut, the
   * registry's handler is bound in `App` — ahead of a view that mounts lazily on first visit — and
   * its `preventDefault` meant everything here bailed on `defaultPrevented`. The chord is offered to
   * this workspace first now, so the save happens where the logic already lives.
   */
  const apiCommand = useApiCommandStore((s) => s.request);
  useEffect(() => {
    if (!apiCommand) return;
    useApiCommandStore.getState().consume();
    // A modal covers the builder; ⌘S there would save the request behind it.
    if (useApiModalStore.getState().modal !== null) return;
    const store = useApiStore.getState();
    const tabId = store.activeTabId;
    if (!tabId) return;
    // A settings tab has no `TabActions` — its save is one store call, with none of the script
    // running and scope writing that makes a request's save worth registering.
    if (store.entityTabs.some((tab) => tab.id === tabId)) {
      void store.saveEntityTab(tabId);
      return;
    }
    tabActions(tabId)?.save();
  }, [apiCommand]);

  // Scoped to the view: it stays mounted once opened, so an unscoped ⌘W would close a request tab
  // while the user is looking at the diff of a commit.
  useEffect(() => {
    // Also scoped to the requests side: the database workspace binds ⌘W to its own tab strip, and
    // both handlers firing would close a request tab the user can't see.
    if (activeView !== "api" || apiWorkspace !== "requests") return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      // A modal covers the builder, so ⌘W there would close a tab the user can't even see.
      if (useApiModalStore.getState().modal !== null) return;
      const tabId = useApiStore.getState().activeTabId;
      if (!tabId) return;
      // A settings tab has no `TabActions`: Send means nothing for one, so ⌘W is all it takes.
      const entity = useApiStore.getState().entityTabs.some((tab) => tab.id === tabId);
      if (entity) {
        if (e.key === "w") {
          e.preventDefault();
          void closeActiveTab();
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        tabActions(tabId)?.send();
      } else if (e.key === "w") {
        e.preventDefault();
        void closeActiveTab();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, apiWorkspace, closeActiveTab]);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        {/* Flush: no padding, no gaps. Each column is a plain surface and the only thing between two
            of them is the `ResizeHandle`'s one-pixel seam — the same everywhere in the app, so the
            five views read as one window rather than as cards floating on a background. */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Both workspaces stay mounted once visited, so switching back doesn't re-fetch a tree or
              throw away a result grid — the same reason `App` keeps its views mounted.

              Which one is on screen is switched from the workspace menu at the right of the tab bar,
              where the two sit as sibling rows — the same control that opens this tab in the first
              place, so there is no second switcher to keep in step with it. */}
          <div
            className={`flex min-w-0 flex-1 overflow-hidden ${
              apiWorkspace === "requests" ? "" : "hidden"
            }`}
          >
            <ApiSidebar />

            <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${CARD}`}>
              {tabOrder.length > 0 && <RequestTabs />}
              <div className="min-h-0 flex-1">
                {activeTab ? (
                  <RequestBuilder tabId={activeTab.id} />
                ) : activeEntity ? (
                  <EntitySettingsView tabId={activeEntity.id} />
                ) : (
                  <ApiEmptyState />
                )}
              </div>
            </div>

            {/* The snippet mirrors one request, so it has nothing to show without an open tab. */}
            {activeTab && <CodeSnippetPanel tabId={activeTab.id} />}
          </div>

          {apiWorkspace === "database" && <DatabaseView />}
        </div>
      </div>

      {modal?.kind === "environments" && <EnvironmentModal onClose={closeModal} />}
      {modal?.kind === "import" && <ImportModal onClose={closeModal} />}
      {modal?.kind === "cookies" && <CookieModal onClose={closeModal} />}
      {modal?.kind === "export" && (
        <ExportModal collectionId={modal.collectionId} onClose={closeModal} />
      )}
      {modal?.kind === "docs" && <DocsModal collectionId={modal.collectionId} onClose={closeModal} />}
      {modal?.kind === "runner" && (
        <RunnerModal collectionId={modal.collectionId} folderId={modal.folderId} onClose={closeModal} />
      )}
      {modal?.kind === "collab" && <CollabModal onClose={closeModal} />}
      {modal?.kind === "conflicts" && <ConflictModal onClose={closeModal} />}
    </>
  );
}
