import { useCallback, useEffect } from "react";
import { Boxes, Download, Plus, Users, type LucideIcon } from "lucide-react";
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
import { buttonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
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
 * shortcut registry's `apiCommandStore` — including ⌘Enter and ⌘W, which used to be on a
 * listener of its own.
 *
 * There is deliberately no toolbar row of its own: the environment picker sits at the foot of the
 * explorer and every action it used to hold lives in the explorer's tool row or its overflow menu,
 * so the request builder starts at the top of the window.
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
        className={buttonClass({ variant: primary ? "primary" : "secondary", size: "md" })}
      >
        <Icon size={14} />
        {label}
      </button>
    );
  };

  // Just the buttons: no glyph, heading or paragraph over them — the tab strip, the explorer and the
  // title row already say where you are. The one sentence that earned its place — that it is *this
  // workspace* which has no collections, so an empty view straight after a workspace switch doesn't
  // read as "my collections are gone" — rides on the button that answers it.
  return (
    <div className="flex h-full min-h-0 flex-wrap content-center items-center justify-center gap-2 p-6">
      {action(t("api.newRequest"), Plus, () => useApiStore.getState().openScratchTab(), true)}
      <Tooltip
        label={t("api.newCollection")}
        description={collections.length === 0 ? t("api.noCollectionsInWorkspace") : undefined}
      >
        {action(t("api.newCollection"), Boxes, () => void newCollection())}
      </Tooltip>
      {action(t("api.import.title"), Download, () => openModal({ kind: "import" }))}
      {action(t("api.collab.importCollaborative"), Users, () => openModal({ kind: "collab" }))}
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
   * Every keyboard action this workspace has, arriving through `apiCommandStore`.
   *
   * All three used to be handled differently and two of them badly. ⌘S was a branch in a `window`
   * listener that never once ran — ⌘S is a registered shortcut, the registry's handler is bound in
   * `App` ahead of this lazily-mounted view, and its `preventDefault` made the listener bail on
   * `defaultPrevented`. ⌘Enter and ⌘W did run, from that same listener, and were therefore
   * invisible: absent from the keybindings screen and from the cheat sheet, and impossible to
   * rebind. They are ordinary registered commands now (`api.send`, `api.closeTab`), and this is the
   * one place that knows what they mean.
   */
  const apiCommand = useApiCommandStore((s) => s.request);
  useEffect(() => {
    if (!apiCommand) return;
    useApiCommandStore.getState().consume();
    // A modal covers the builder; acting here would hit the tab behind it.
    if (useApiModalStore.getState().modal !== null) return;
    const store = useApiStore.getState();
    const tabId = store.activeTabId;
    if (!tabId) return;

    if (apiCommand.command === "closeTab") {
      void closeActiveTab();
      return;
    }

    // A settings tab has no `TabActions`: its save is one store call, with none of the script
    // running and scope writing that makes a request's save worth registering — and Send means
    // nothing for one at all.
    if (store.entityTabs.some((tab) => tab.id === tabId)) {
      if (apiCommand.command === "save") void store.saveEntityTab(tabId);
      return;
    }

    if (apiCommand.command === "save") tabActions(tabId)?.save();
    else tabActions(tabId)?.send();
  }, [apiCommand, closeActiveTab]);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-surface)]">
        {/* Flush: no padding, no gaps. The explorer and the snippet inspector sit a half-step into
            the sunken tone with a hairline of their own, the builder between them is the page, and
            the only thing between two columns is that one-pixel edge — the same anatomy every
            sub-app has, so the views read as one window rather than as cards on a background. */}
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
