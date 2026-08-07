import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronUp,
  Copy,
  Database,
  FileCode2,
  LayoutList,
  Network,
  Plus,
  Rows3,
  Settings2,
  Table2,
  X,
} from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { EmptyState } from "../common/EmptyState";
import { DbExplorer } from "./DbExplorer";
import { SqlConsolePanel } from "./SqlConsolePanel";
import { DataTabPanel } from "./DataTabPanel";
import { DdlPanel } from "./DdlPanel";
import { DiagramPanel } from "./DiagramPanel";
import { SchemaPanel } from "./SchemaPanel";
import { ConnectionModal } from "./ConnectionModal";
import { ObjectFilterModal } from "./TableFilterModal";
import { EngineMenu, menuAnchor } from "./EngineMenu";
import { CARD, EngineBadge, nodeIcon } from "./dbChrome";
import { ensureDbStoreLoaded, pendingCount, useDbStore, type DbTab } from "../../state/dbStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useUiStore } from "../../state/uiStore";
import { confirmAction } from "../../state/confirmStore";
import { translate, useT } from "../../state/languageStore";
import { referenceLabel } from "./ResultGrid";
import { fieldFacts, recordModel } from "../../lib/db/engineModel";
import { engineInfo, type DbColumn, type DbForeignKey, type DbKind } from "../../types/database";

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

  // The backend owns the sessions and opens and closes them without asking: every command dials
  // lazily, and the idle sweep expires. `ensureDbStoreLoaded` can't re-read that — it short-circuits
  // on the workspace it already loaded — so the view asks directly whenever it comes back into
  // sight. Both directions of drift matter, and the awkward one is a live session drawn as
  // disconnected: the row's menu then offers *Connect*, and the command that would release the
  // session isn't reachable at all. (The hide/show cycle is covered separately, by the
  // `app:foreground` listener in `dbStore`.)
  useEffect(() => {
    if (activeView !== "api" || apiWorkspace !== "database") return;
    void useDbStore.getState().syncConnected();
  }, [activeView, apiWorkspace]);

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
      <div className="flex min-h-0 flex-1 overflow-hidden">
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
            ) : activeTab.kind === "diagram" ? (
              <DiagramPanel tab={activeTab} />
            ) : activeTab.kind === "schema" ? (
              <SchemaPanel tab={activeTab} />
            ) : (
              <DdlPanel tab={activeTab} />
            )}
          </div>
          <SqlLogPanel />
        </div>
      </div>

      {(modal?.kind === "newConnection" ||
        modal?.kind === "connection" ||
        modal?.kind === "connections") && (
        <ConnectionModal
          connectionId={modal.kind === "connection" ? modal.connectionId : null}
          newEngine={modal.kind === "newConnection" ? modal.engine : null}
          newGroup={modal.kind === "newConnection" ? modal.group ?? "" : ""}
          onClose={closeModal}
        />
      )}
      {modal?.kind === "objectFilter" && (
        <ObjectFilterModal
          connectionId={modal.connectionId}
          schema={modal.schema}
          onClose={closeModal}
        />
      )}
      {modal?.kind === "cell" && <CellModal modal={modal} onClose={closeModal} />}
      {modal?.kind === "records" && <RecordsModal modal={modal} onClose={closeModal} />}
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

  // Which connection a tab belongs to is only ambiguous when more than one is open — and then it
  // is the most important thing on the tab, because `MotivoTransporte` on staging and the same
  // table on production are the same six words. So the name rides along only when it disambiguates
  // something; with a single connection it would be the same label repeated on every tab.
  const manyConnections = new Set(tabs.map((tab) => tab.connectionId)).size > 1;

  // Every tab the same width, the way a browser's are, rather than each one sized to its own name.
  // Table names run from `users` to `convenio_consumos_historico_2024`, and letting them set the
  // width means the strip's geometry changes every time you open one — the tab you were aiming for
  // has moved by the time you click. A fixed width costs a little space on the short names and buys
  // a strip whose positions hold still; the full name is in the tooltip either way. Two connections
  // put a second label on every tab, so the size that fits is a strip-wide answer, not a per-tab one.
  const width = manyConnections ? "w-[220px]" : "w-[180px]";

  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--cf-border)] px-1.5 py-1">
      {tabs.map((tab) => {
        const connection = connections.find((c) => c.id === tab.connectionId);
        const engine = connection ? engineInfo(connection.kind) : null;
        const Icon =
          tab.kind === "console"
            ? FileCode2
            : tab.kind === "ddl"
              ? nodeIcon("routine")
              : tab.kind === "diagram"
                ? Network
                : tab.kind === "schema"
                  ? LayoutList
                  : Table2;
        const dirty =
          (tab.kind === "console" && tab.dirty) ||
          (tab.kind === "data" && pendingCount(tab) > 0);
        return (
          <div
            key={tab.id}
            onClick={() => store.setActiveTab(tab.id)}
            // Always in the tooltip, even when the strip has room to say it: hovering is how you
            // check "which server am I about to run this on" without moving the mouse to the
            // toolbar.
            title={connection ? `${connection.name} · ${tab.name}` : tab.name}
            onAuxClick={(e) => {
              // Middle click closes, like every other tab strip in the app.
              if (e.button === 1) void closeTabSafely(tab);
            }}
            className={`group flex ${width} shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${
              tab.id === activeTabId
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            }`}
          >
            {connection && engine && <EngineBadge kind={connection.kind} label={engine.label} />}
            <Icon size={12} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{tab.name}</span>
            {manyConnections && connection && (
              <span className="min-w-0 max-w-[80px] shrink truncate text-[10.5px] opacity-60">
                {connection.name}
              </span>
            )}
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
  // A `jsonb` column arrives as the server rendered it, which is one line however deep the document
  // is — readable as a value, unreadable as a structure. Indenting it is the whole reason to open a
  // big value in a window instead of squinting at the cell.
  const formatted = useMemo(() => prettyJson(modal.value), [modal.value]);
  const [raw, setRaw] = useState(false);
  const shown = isNull ? "NULL" : !raw && formatted ? formatted : (modal.value ?? "");

  return (
    <ApiModal
      icon={Table2}
      title={modal.column}
      subtitle={isNull ? "NULL" : t("db.charactersN", { n: String(modal.value?.length ?? 0) })}
      width="max-w-3xl"
      height="h-[78vh]"
      onClose={onClose}
      toolbar={
        // Only where there is a choice to make: on a value that isn't JSON the pair would be two
        // buttons that render the same text.
        formatted ? (
          <div className="inline-flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
            {[
              { id: false, label: t("db.formatJson") },
              { id: true, label: t("db.rawValue") },
            ].map((entry) => (
              <button
                key={String(entry.id)}
                type="button"
                onClick={() => setRaw(entry.id)}
                aria-pressed={raw === entry.id}
                className={`rounded-[6px] px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  raw === entry.id
                    ? "bg-[var(--cf-surface)] text-[var(--cf-text)] shadow-[var(--cf-shadow)]"
                    : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        ) : undefined
      }
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {/* What's on screen, not what was in the cell: having just asked for the indented form,
              being handed the one-liner back would be a surprise. */}
          <GhostButton onClick={() => void navigator.clipboard.writeText(shown)}>
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
          {shown}
        </pre>
      </div>
    </ApiModal>
  );
}

/** The indented form of a value that is JSON, or `null` for one that isn't — which is most of them,
 * so the check is a cheap look at the first character before anything is parsed. The size cap is
 * there because a `jsonb` column can hold a document far larger than anyone will read, and
 * re-serializing it would block the window to produce something nobody scrolls to the end of. */
const JSON_FORMAT_LIMIT = 2_000_000;

function prettyJson(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > JSON_FORMAT_LIMIT) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const indented = JSON.stringify(JSON.parse(trimmed), null, 2);
    // A scalar wrapped in nothing (`{}`, `[]`) comes back unchanged; offering to "format" it is an
    // offer to do nothing.
    return indented === trimmed ? null : indented;
  } catch {
    return null;
  }
}

/**
 * Rows read down the page instead of across it.
 *
 * The grid is the right shape for scanning many rows of a few columns and the wrong one for reading
 * a single row of forty — which is the case this exists for. Each record is a block of
 * `column: value` lines, and several selected rows are stacked in the order they appear in the
 * grid, so comparing two of them is scrolling rather than dragging a horizontal scrollbar twice.
 *
 * The row's own number is kept on each block: a record read here is worth much less if you can't
 * find the row it came from back in the grid.
 *
 * What is drawn beside a field name comes from the engine's own model rather than from a shared
 * idea of what a field is — see `lib/db/engineModel`. The same block therefore marks a primary key
 * on Postgres, a RowID on IRIS and `_id` on MongoDB, and offers to follow a reference only where
 * the engine has references to follow.
 */
function RecordsModal({
  modal,
  onClose,
}: {
  modal: {
    title: string;
    engine: DbKind;
    columns: DbColumn[];
    records: { index: number; values: (string | null)[] }[];
    primaryKeys?: Set<string>;
    foreignKeys?: Map<string, DbForeignKey>;
  };
  onClose: () => void;
}) {
  const t = useT();
  const model = recordModel(modal.engine);
  const copy = () => {
    const text = modal.records
      .map((record) =>
        modal.columns
          .map((column, index) => `${column.name}: ${record.values[index] ?? "NULL"}`)
          .join("\n"),
      )
      .join("\n\n");
    void navigator.clipboard.writeText(text);
  };

  return (
    <ApiModal
      icon={Rows3}
      title={modal.title}
      subtitle={t(model.countLabel, { n: String(modal.records.length) })}
      width="max-w-2xl"
      height="h-[78vh]"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GhostButton onClick={copy}>{t("db.copy")}</GhostButton>
          <GhostButton onClick={onClose}>{t("common.close")}</GhostButton>
        </div>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        {modal.records.map((record) => (
          <div
            key={record.index}
            className="overflow-hidden rounded-md border border-[var(--cf-border)]"
          >
            <p className="border-b border-[var(--cf-border)] bg-black/[0.03] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] dark:bg-white/[0.04]">
              {t(model.itemLabel, { n: String(record.index + 1) })}
            </p>
            <dl className="divide-y divide-[var(--cf-border)]">
              {modal.columns.map((column, index) => {
                const value = record.values[index] ?? null;
                const facts = fieldFacts(model, column, {
                  primaryKeys: modal.primaryKeys,
                  foreignKeys: modal.foreignKeys,
                });
                return (
                  <div key={column.name} className="grid grid-cols-[minmax(0,150px)_1fr] gap-2 px-2 py-1">
                    {/* The type under the name, as in the grid's own headers. It used to live only
                        in the `title`, which meant the one view built for reading a record whole
                        was the one view that made you hover to find out what a field is. */}
                    <dt
                      title={facts.type ? `${column.name} · ${facts.type}` : column.name}
                      className="min-w-0 text-[11.5px] text-[var(--cf-text-muted)]"
                    >
                      <span className="flex min-w-0 items-baseline gap-1">
                        <span className="min-w-0 truncate">{column.name}</span>
                        {/* The engine's own word, not "PK" everywhere: on a document `PK` would be
                            naming a concept MongoDB does not have. */}
                        {facts.identity && model.identity && (
                          <span
                            title={t(model.identity.label)}
                            className="shrink-0 text-[9px] font-bold leading-none text-[var(--cf-accent)]"
                          >
                            {model.identity.badge}
                          </span>
                        )}
                      </span>
                      {facts.type && (
                        <span
                          // Italic when the type came off a value: it describes the document that
                          // answered for this field, and the next one may well be a string where
                          // this one was an int.
                          title={facts.typeFromRecord ? t("db.typeFromRecord") : undefined}
                          className={`block truncate text-[9.5px] leading-tight opacity-70 ${
                            facts.typeFromRecord ? "italic" : ""
                          }`}
                        >
                          {facts.type}
                        </span>
                      )}
                      {/* Named, not followed. Opening the referenced table needs a tab to open it
                          in, and this modal is opened from two panels that disagree about which —
                          so it says where the field points and leaves the jump to the grid, which
                          has the arrow for it. */}
                      {facts.reference && (
                        <span
                          title={t("db.referencesField", { target: referenceLabel(facts.reference) })}
                          className="block truncate text-[9.5px] leading-tight text-[var(--cf-accent)] opacity-80"
                        >
                          → {referenceLabel(facts.reference)}
                        </span>
                      )}
                    </dt>
                    {/* Wrapped, not truncated: the whole reason to be here is to read the value
                        the grid could only show the first line of. */}
                    <dd
                      className={`min-w-0 whitespace-pre-wrap break-words font-mono text-[12px] ${
                        value === null
                          ? "italic text-[var(--cf-text-muted)]"
                          : "text-[var(--cf-text)]"
                      }`}
                    >
                      {value === null ? "NULL" : value}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>
    </ApiModal>
  );
}

/**
 * The statements the workspace ran, hidden until asked for.
 *
 * Everything in this view sends SQL nobody typed — opening a table, turning a page, sorting a
 * column, applying an edit — and until now the only trace of it was the rows that came back. This
 * is the answer to "what did that click actually run?", which is the question you ask when a grid
 * shows something you didn't expect, and the thing you copy into a ticket when it shows something
 * wrong.
 *
 * Collapsed to a single strip by default: it is a tool for the moment you doubt the UI, not
 * something to spend screen on the rest of the time. What it shows comes back *from the server
 * side of each call*, so it can't drift from what really ran.
 */
function SqlLogPanel() {
  const t = useT();
  const entries = useDbStore((s) => s.sqlLog);
  const clear = useDbStore((s) => s.clearSqlLog);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Pinned to the newest line while it is open, the way a log pane behaves.
  useEffect(() => {
    if (!open) return;
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [open, entries]);

  return (
    <div className="shrink-0 border-t border-[var(--cf-border)]">
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <ChevronUp
            size={12}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          />
          {t("db.sqlLog")}
          <span className="tabular-nums opacity-70">({entries.length})</span>
        </button>
        {open && entries.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="ml-auto text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            {t("db.clear")}
          </button>
        )}
      </div>
      {open && (
        <div ref={listRef} className="max-h-48 overflow-auto border-t border-[var(--cf-border)]">
          {entries.length === 0 ? (
            <p className="p-2 text-[11px] text-[var(--cf-text-muted)]">{t("db.sqlLogEmpty")}</p>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start gap-2 border-b border-[var(--cf-border)] px-2 py-1 last:border-b-0"
              >
                <span className="shrink-0 pt-[1px] text-[10px] tabular-nums text-[var(--cf-text-muted)]">
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
                <span className="shrink-0 pt-[1px] text-[9.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {entry.source}
                </span>
                <span
                  className={`min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11.5px] ${
                    entry.error ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"
                  }`}
                >
                  {entry.sql || t("db.sqlLogNoStatement")}
                  {entry.error && `\n${entry.error}`}
                </span>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(entry.sql)}
                  title={t("db.copy")}
                  className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                >
                  <Copy size={11} />
                </button>
                <span className="shrink-0 whitespace-nowrap pt-[1px] text-[10px] tabular-nums text-[var(--cf-text-muted)]">
                  {[
                    entry.durationMs === null ? null : `${entry.durationMs} ms`,
                    entry.rows === null ? null : t("db.rowsN", { n: String(entry.rows) }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
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
