import { useCallback, useEffect } from "react";
import { Download, Plus, Users, Zap, type LucideIcon } from "lucide-react";
import { ApiSidebar } from "./ApiSidebar";
import { RequestTabs } from "./RequestTabs";
import { RequestBuilder } from "./RequestBuilder";
import { CodeSnippetPanel } from "./CodeSnippetPanel";
import { EnvironmentModal } from "./EnvironmentModal";
import { ImportModal } from "./ImportModal";
import { ExportModal } from "./ExportModal";
import { RunnerModal } from "./RunnerModal";
import { ApiSettingsModal } from "./ApiSettingsModal";
import { CookieModal } from "./CookieModal";
import { CollabModal } from "./CollabModal";
import { ConflictModal } from "./ConflictModal";
import { tabActions } from "./tabActions";
import { CARD } from "./panelChrome";
import { EmptyState } from "../common/EmptyState";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useUiStore } from "../../state/uiStore";
import { useToastStore } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * The API client's shell: sidebar, tab strip, request builder, response pane and the code-snippet
 * panel. Every panel below reads `apiStore`/`apiRuntimeStore` on its own — this file only decides
 * what is on screen, owns the modals, and binds the three keyboard shortcuts.
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
      {/* `EmptyState` is `h-full`, so it needs a box with a resolved height to centre itself in;
          without one it would either collapse or eat the row the buttons live in. */}
      <div className="h-[150px] w-full">
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
  const activeTabId = useApiStore((s) => s.activeTabId);
  const activeView = useUiStore((s) => s.activeView);
  const modal = useApiModalStore((s) => s.modal);
  const closeModal = useApiModalStore((s) => s.closeApiModal);

  useEffect(() => {
    void ensureApiStoreLoaded();
  }, []);

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;

  const closeActiveTab = useCallback(async () => {
    const store = useApiStore.getState();
    const tab = store.openTabs.find((candidate) => candidate.id === store.activeTabId);
    if (!tab) return;
    if (tab.dirty) {
      const name = tab.name || t("api.untitledRequest");
      if (!(await confirmAction(t("editor.closeDirtyConfirm", { name })))) return;
    }
    useApiStore.getState().closeTab(tab.id);
  }, [t]);

  // Scoped to the view: it stays mounted once opened, so an unscoped ⌘S would save an API request
  // while the user is looking at the diff of a commit.
  useEffect(() => {
    if (activeView !== "api") return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      // A modal covers the builder, so ⌘W there would close a tab the user can't even see.
      if (useApiModalStore.getState().modal !== null) return;
      const tabId = useApiStore.getState().activeTabId;
      if (!tabId) return;
      if (e.key === "s") {
        e.preventDefault();
        tabActions(tabId)?.save();
      } else if (e.key === "Enter") {
        e.preventDefault();
        tabActions(tabId)?.send();
      } else if (e.key === "w") {
        e.preventDefault();
        void closeActiveTab();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, closeActiveTab]);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        {/* Padded and gapped so each column reads as its own card, the way the Editor view lays
            out its rail, tree and editor. The request area is the one that gains most from it:
            flush against the window it looked like a form bolted to the frame. */}
        <div className="flex min-h-0 flex-1 gap-1.5 overflow-hidden p-2">
          <ApiSidebar />

          <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${CARD}`}>
            {openTabs.length > 0 && <RequestTabs />}
            <div className="min-h-0 flex-1">
              {activeTab ? <RequestBuilder tabId={activeTab.id} /> : <ApiEmptyState />}
            </div>
          </div>

          {/* The snippet mirrors one request, so it has nothing to show without an open tab. */}
          {activeTab && <CodeSnippetPanel tabId={activeTab.id} />}
        </div>
      </div>

      {modal?.kind === "environments" && <EnvironmentModal onClose={closeModal} />}
      {modal?.kind === "import" && <ImportModal onClose={closeModal} />}
      {modal?.kind === "cookies" && <CookieModal onClose={closeModal} />}
      {modal?.kind === "settings" && <ApiSettingsModal tab={modal.tab} onClose={closeModal} />}
      {modal?.kind === "export" && (
        <ExportModal collectionId={modal.collectionId} onClose={closeModal} />
      )}
      {modal?.kind === "runner" && (
        <RunnerModal collectionId={modal.collectionId} folderId={modal.folderId} onClose={closeModal} />
      )}
      {modal?.kind === "collab" && <CollabModal onClose={closeModal} />}
      {modal?.kind === "conflicts" && <ConflictModal onClose={closeModal} />}
    </>
  );
}
