import { useEffect, useState } from "react";
import { Database, FileCode2, Plus, Settings2, Table2, X } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { EmptyState } from "../common/EmptyState";
import { DbExplorer } from "./DbExplorer";
import { SqlConsolePanel } from "./SqlConsolePanel";
import { DataTabPanel } from "./DataTabPanel";
import { DdlPanel } from "./DdlPanel";
import { ConnectionModal } from "./ConnectionModal";
import { EngineMenu, menuAnchor } from "./EngineMenu";
import { CARD, EngineBadge, nodeIcon } from "./dbChrome";
import { ensureDbStoreLoaded, pendingCount, useDbStore, type DbTab } from "../../state/dbStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useUiStore } from "../../state/uiStore";
import { confirmAction } from "../../state/confirmStore";
import { translate, useT } from "../../state/languageStore";
import { engineInfo } from "../../types/database";

/**
 * The database workspace's shell: explorer, tab strip, and whichever panel the active tab wants.
 *
 * It lives inside the API view rather than as a main tab of its own, because both are
 * **workspace-scoped**: a collection describes a service and a connection describes that service's
 * database, and neither changes when you click a different repository. Putting the database next to
 * Graph/Changes/Editor would imply it followed the repo — the same reason the API client isn't there
 * (see the note at the top of `TabBar`).
 */
export function DatabaseView() {
  const tabs = useDbStore((s) => s.tabs);
  const activeTabId = useDbStore((s) => s.activeTabId);
  const modal = useDbModalStore((s) => s.modal);
  const closeModal = useDbModalStore((s) => s.closeDbModal);
  const activeView = useUiStore((s) => s.activeView);
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);

  useEffect(() => {
    void ensureDbStoreLoaded();
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  // Scoped to this workspace: the API client's request builder binds the same keys, and an unscoped
  // handler would run a SQL console while the user is looking at an HTTP request.
  useEffect(() => {
    if (activeView !== "api" || apiWorkspace !== "database") return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (useDbModalStore.getState().modal !== null) return;
      const store = useDbStore.getState();
      const tab = store.tabs.find((entry) => entry.id === store.activeTabId);
      if (!tab) return;
      if (e.key === "w") {
        e.preventDefault();
        void closeTabSafely(tab);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, apiWorkspace]);

  return (
    <>
      <div className="flex min-h-0 flex-1 gap-1.5 overflow-hidden">
        <DbExplorer />

        <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${CARD}`}>
          {tabs.length > 0 && <DbTabStrip />}
          <div className="min-h-0 flex-1">
            {activeTab === null ? (
              <DbEmptyState />
            ) : activeTab.kind === "console" ? (
              <SqlConsolePanel tab={activeTab} />
            ) : activeTab.kind === "data" ? (
              <DataTabPanel tab={activeTab} />
            ) : (
              <DdlPanel tab={activeTab} />
            )}
          </div>
        </div>
      </div>

      {(modal?.kind === "newConnection" ||
        modal?.kind === "connection" ||
        modal?.kind === "connections") && (
        <ConnectionModal
          connectionId={modal.kind === "connection" ? modal.connectionId : null}
          newEngine={modal.kind === "newConnection" ? modal.engine : null}
          onClose={closeModal}
        />
      )}
      {modal?.kind === "cell" && <CellModal modal={modal} onClose={closeModal} />}
      {modal?.kind === "preview" && <PreviewModal modal={modal} onClose={closeModal} />}
    </>
  );
}

/**
 * Closes a tab, asking first when doing so would lose something.
 *
 * A module function rather than a hook, because the tab strip, the keyboard shortcut and a middle
 * click all need it — hence `translate` instead of `useT`, which is the documented use for it.
 */
async function closeTabSafely(tab: DbTab) {
  const store = useDbStore.getState();
  // Staged edits exist nowhere but this tab: closing it is the one action that can silently discard
  // work the user can see on screen.
  if (tab.kind === "data") {
    const staged = pendingCount(tab);
    if (staged > 0) {
      const confirmed = await confirmAction(
        translate("db.discardEditsOnClose", { n: String(staged), name: tab.name }),
      );
      if (!confirmed) return;
    }
  }
  if (tab.kind === "console" && tab.dirty && tab.body.trim()) {
    if (!(await confirmAction(translate("db.closeDirtyConsole", { name: tab.name })))) return;
  }
  store.closeTab(tab.id);
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

function DbTabStrip() {
  const t = useT();
  const tabs = useDbStore((s) => s.tabs);
  const activeTabId = useDbStore((s) => s.activeTabId);
  const connections = useDbStore((s) => s.connections);
  const store = useDbStore.getState();

  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--cf-border)] px-1.5 py-1">
      {tabs.map((tab) => {
        const connection = connections.find((c) => c.id === tab.connectionId);
        const engine = connection ? engineInfo(connection.kind) : null;
        const Icon =
          tab.kind === "console" ? FileCode2 : tab.kind === "ddl" ? nodeIcon("routine") : Table2;
        const dirty =
          (tab.kind === "console" && tab.dirty) ||
          (tab.kind === "data" && pendingCount(tab) > 0);
        return (
          <div
            key={tab.id}
            onClick={() => store.setActiveTab(tab.id)}
            onAuxClick={(e) => {
              // Middle click closes, like every other tab strip in the app.
              if (e.button === 1) void closeTabSafely(tab);
            }}
            className={`group flex shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${
              tab.id === activeTabId
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            }`}
          >
            {connection && engine && <EngineBadge kind={connection.kind} label={engine.label} />}
            <Icon size={12} className="shrink-0" />
            <span className="max-w-[180px] truncate">{tab.name}</span>
            {dirty && (
              <span
                title={t("db.unsaved")}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cf-warning)]"
              />
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                void closeTabSafely(tab);
              }}
              title={t("db.closeTab")}
              aria-label={t("db.closeTab")}
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function DbEmptyState() {
  const t = useT();
  const connections = useDbStore((s) => s.connections);
  const openModal = useDbModalStore((s) => s.openDbModal);
  const store = useDbStore.getState();
  const [engineMenu, setEngineMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3">
      <div className="h-[150px] w-full">
        <EmptyState
          icon={Database}
          title={t("db.title")}
          subtitle={connections.length === 0 ? t("db.noConnectionsInWorkspace") : t("db.openHint")}
        />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {connections.length === 0 ? (
          <button
            onClick={(e) => setEngineMenu(menuAnchor(e))}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
          >
            <Plus size={13} />
            {t("db.newConnection")}
          </button>
        ) : (
          <>
            <button
              onClick={() => store.newConsole(connections[0].id)}
              className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
            >
              <FileCode2 size={13} />
              {t("db.newConsole")}
            </button>
            <button
              onClick={(e) => setEngineMenu(menuAnchor(e))}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <Plus size={13} />
              {t("db.newConnection")}
            </button>
            {/* The whole set, for when the connections exist and it's one of them that needs
                changing — the same dialog the explorer's gear opens. */}
            <button
              onClick={() => openModal({ kind: "connections" })}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <Settings2 size={13} />
              {t("db.manageConnections")}
            </button>
          </>
        )}
      </div>

      {engineMenu && (
        <EngineMenu
          x={engineMenu.x}
          y={engineMenu.y}
          onPick={(engine) => openModal({ kind: "newConnection", engine })}
          onClose={() => setEngineMenu(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small modals
// ---------------------------------------------------------------------------

/**
 * One cell's whole value.
 *
 * Exists because a 26px row cannot show a JSON document, a long text column or a stack trace — and
 * truncating one in a grid is how you end up editing what you can't see. Editable when the grid is.
 */
function CellModal({
  modal,
  onClose,
}: {
  modal: { column: string; value: string | null; editable: boolean; onSave?: (value: string | null) => void };
  onClose: () => void;
}) {
  const t = useT();
  const isNull = modal.value === null;
  return (
    <ApiModal
      icon={Table2}
      title={modal.column}
      subtitle={isNull ? "NULL" : t("db.charactersN", { n: String(modal.value?.length ?? 0) })}
      width="max-w-3xl"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GhostButton onClick={() => void navigator.clipboard.writeText(modal.value ?? "")}>
            {t("db.copy")}
          </GhostButton>
          <GhostButton onClick={onClose}>{t("common.close")}</GhostButton>
        </div>
      }
    >
      {/* `ApiModal`'s body brings no padding or scroll of its own — see the note in
          `ConnectionModal`. Here the `<pre>` is the scroll container. */}
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <pre className="h-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] p-2 font-mono text-[12px] text-[var(--cf-text)]">
          {isNull ? "NULL" : modal.value}
        </pre>
      </div>
    </ApiModal>
  );
}

/**
 * What a batch of staged edits is about to do, before it does it.
 *
 * This is the step that makes the data editor trustworthy: the grid can be misread, a click can land
 * on the wrong row, and the only defence is showing the operations in words and asking. The backend
 * returns the statements it actually ran afterwards, so the two can be compared.
 */
function PreviewModal({
  modal,
  onClose,
}: {
  modal: { title: string; statements: string[]; onConfirm: () => void };
  onClose: () => void;
}) {
  const t = useT();
  return (
    <ApiModal
      icon={Database}
      title={modal.title}
      subtitle={t("db.applySubtitle")}
      width="max-w-xl"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <button
            onClick={() => {
              modal.onConfirm();
              onClose();
            }}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
          >
            {t("db.apply")}
          </button>
        </div>
      }
    >
      <ul className="min-h-0 flex-1 space-y-1 overflow-auto p-4">
        {modal.statements.map((statement, index) => (
          <li
            key={index}
            className="rounded-md border border-[var(--cf-border)] px-2 py-1.5 font-mono text-[12px] text-[var(--cf-text)]"
          >
            {statement}
          </li>
        ))}
      </ul>
    </ApiModal>
  );
}
