import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import {
  AlertTriangle,
  Braces,
  Check,
  Database,
  Download,
  Copy,
  Layers,
  Loader2,
  Play,
  Rows3,
  Save,
  Square,
  Table2,
  Waypoints,
} from "lucide-react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { installSqlCompletions } from "../../lib/db/sqlCompletion";
import { ResizeHandle } from "../common/ResizeHandle";
import { Select } from "../common/Select";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { ResultGrid } from "./ResultGrid";
import { ScopePicker } from "./ScopePicker";
import { EngineBadge, ToolbarButton, formatCount, formatDuration } from "./dbChrome";
import { nodeKey, useDbStore, type DbConsoleTab } from "../../state/dbStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useThemeStore } from "../../state/themeStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { EXPORT_EXTENSIONS, formatResult, type ExportFormat } from "../../lib/db/resultExport";
import { engineInfo, type DbNodeRef } from "../../types/database";

const EDITOR_OPTIONS: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
  ...OVERFLOW_SAFE_OPTIONS,
  minimap: { enabled: false },
  fontSize: 12.5,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  tabSize: 2,
  renderLineHighlight: "line",
  overviewRulerLanes: 0,
  padding: { top: 8, bottom: 8 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  // On by default for SQL: a console is where you type table and column names you half-remember.
  // Not inside strings or comments, where the catalog is never what you are typing — and with the
  // space trigger below, the widget would otherwise open on every word of a `WHERE note = '…'`.
  quickSuggestions: { other: true, comments: false, strings: false },
  // The provider answers synchronously (see `sqlCompletion.ts`), so there is nothing to wait for.
  quickSuggestionsDelay: 0,
  suggestOnTriggerCharacters: true,
  // Tab completes the best match without going through the list first — what you want when the
  // name is nearly typed and the point of the widget was never to be read.
  tabCompletion: "on",
  // ...and Enter stays a newline. The completion provider opens the list after a space, so the list
  // is up far more often than it used to be, and Monaco's default would spend those Enters
  // accepting `AND` instead of breaking the line — in the one editor where every line break is
  // deliberate.
  acceptSuggestionOnEnter: "off",
  // No `wordBasedSuggestions` here, and not by omission. It read as "the catalog first, words in
  // the buffer as a fallback", which is not what it does: Monaco asks completion providers in
  // priority groups and stops at the first that answers, so while the SQL provider returns anything
  // at all — it always returns keywords — the word-based one never runs. And in standalone Monaco
  // that option is not per-editor: it goes through the one global configuration service, so
  // mounting a console silently changed the setting for every other editor in the app.
};

// The provider is global to Monaco rather than per-editor, so it is installed once on import
// — the same shape as the GraphQL and script panels.
installSqlCompletions();

const ROW_LIMITS = [100, 500, 1000, 5000, 0];

/**
 * A statement, and what came back.
 *
 * The keyboard is the interface here, so three bindings are wired directly into Monaco rather than
 * left to the window handler: ⌘↵ runs, ⇧⌘↵ runs only the selection, and ⌘S saves the console. The
 * first two are different commands on purpose — "run what I highlighted" is how you work through a
 * script one statement at a time, and making it the same key as "run everything" would eventually
 * run everything by accident.
 */
export function SqlConsolePanel({ tab }: { tab: DbConsoleTab }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const height = useLayoutStore((s) => s.sizes.dbResultHeight);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const connection = useDbStore((s) => s.connections.find((c) => c.id === tab.connectionId));
  const children = useDbStore((s) => s.children);
  const loadingNodes = useDbStore((s) => s.loadingNodes);
  const nodeErrors = useDbStore((s) => s.nodeErrors);
  const store = useDbStore.getState();
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);

  const engine = connection ? engineInfo(connection.kind) : null;
  const isSql = engine?.sql ?? true;

  // What the pickers offer: the databases and schemas read for this connection. The nodes are the
  // explorer's own, so expanding the tree and opening a picker feed each other — and a picker
  // opened before the tree was ever expanded asks for them itself (`onOpen` below).
  const rootRef: DbNodeRef = { kind: "root", database: null, schema: null, name: null };
  const rootKey = nodeKey(tab.connectionId, rootRef);
  const dbRef: DbNodeRef = { kind: "database", database: tab.database, schema: null, name: null };
  const dbKey = nodeKey(tab.connectionId, dbRef);

  const databases = useMemo(
    () => (children[rootKey] ?? []).filter((node) => node.kind === "database").map((node) => node.name),
    [children, rootKey],
  );
  const schemas = useMemo(
    () =>
      tab.database
        ? (children[dbKey] ?? []).filter((node) => node.kind === "schema").map((node) => node.name)
        : [],
    [children, dbKey, tab.database],
  );

  const run = (selectionOnly: boolean) => {
    const editor = editorRef.current;
    if (selectionOnly && editor) {
      const selection = editor.getSelection();
      const text = selection ? editor.getModel()?.getValueInRange(selection) : "";
      if (text && text.trim()) {
        void store.runConsole(tab.id, text);
        return;
      }
    }
    void store.runConsole(tab.id);
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run(false));
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      () => run(true),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      void store.saveConsole(tab.id),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        {connection && <EngineBadge kind={connection.kind} label={engine?.label ?? ""} />}
        <span className="max-w-[160px] truncate text-[12px] font-medium text-[var(--cf-text)]">
          {connection?.name ?? t("db.connectionGone")}
        </span>

        <span className="mx-0.5 h-4 w-px bg-[var(--cf-border)]" />

        <ScopePicker
          label={engine?.databaseLabel ?? t("db.database")}
          icon={Database}
          value={tab.database}
          options={databases}
          loading={loadingNodes.includes(rootKey)}
          error={nodeErrors[rootKey] ?? null}
          onChange={(value) =>
            // The schema belongs to the database it was picked under, so switching database drops
            // it rather than carrying a name that doesn't exist over there.
            store.updateConsole(tab.id, { database: value, schema: "", dirty: true })
          }
          onOpen={() => {
            if (!children[rootKey]) void store.refreshNode(tab.connectionId, rootRef, rootKey);
          }}
        />

        {isSql && (
          <ScopePicker
            label={t("db.schema")}
            icon={Layers}
            value={tab.schema}
            options={schemas}
            width={140}
            loading={loadingNodes.includes(dbKey)}
            error={tab.database ? nodeErrors[dbKey] ?? null : null}
            disabled={!tab.database}
            disabledHint={t("db.pickDatabaseFirst")}
            onChange={(value) => store.updateConsole(tab.id, { schema: value, dirty: true })}
            onOpen={() => {
              if (tab.database && !children[dbKey]) void store.refreshNode(tab.connectionId, dbRef, dbKey);
            }}
          />
        )}

        <span className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("db.limit")}
          </span>
          <Select
            size="sm"
            className="w-[92px]"
            ariaLabel={t("db.limit")}
            value={String(tab.maxRows)}
            onChange={(value) => store.updateConsole(tab.id, { maxRows: Number(value) })}
            options={ROW_LIMITS.map((limit) => ({
              value: String(limit),
              label: limit === 0 ? t("db.noLimit") : formatCount(limit),
            }))}
          />
        </span>

        <div className="ml-auto flex items-center gap-1">
          {tab.running ? (
            <button
              onClick={() => void store.cancelRun(tab.id)}
              className="flex items-center gap-1 rounded-md border border-[var(--cf-danger)] px-2 py-[3px] text-[12px] font-medium text-[var(--cf-danger)] hover:bg-[var(--cf-danger)]/10"
            >
              <Square size={11} />
              {t("db.cancel")}
            </button>
          ) : (
            <button
              onClick={() => run(false)}
              title={t("db.runHint")}
              className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-[3px] text-[12px] font-medium text-white hover:brightness-110"
            >
              <Play size={11} />
              {t("db.run")}
            </button>
          )}
          <ToolbarButton
            onClick={() => run(true)}
            disabled={tab.running}
            title={t("db.runSelectionHint")}
          >
            <Waypoints size={13} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => void store.explainConsole(tab.id)}
            disabled={tab.running}
            title={t("db.explain")}
          >
            <span className="text-[10px] font-bold">EX</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => void store.saveConsole(tab.id)}
            title={tab.dirty ? t("db.saveConsole") : t("db.saved")}
            active={tab.dirty}
          >
            {tab.dirty ? <Save size={13} /> : <Check size={13} />}
          </ToolbarButton>
        </div>
      </div>

      {/* Editor */}
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          // One model per tab, so two consoles keep their own undo history and cursor. The scheme
          // is this panel's own — `cf-editor` URIs are file models and would be offered to
          // "go to definition".
          path={`cf-db:/console/${tab.id}.${isSql ? "sql" : "js"}`}
          language={isSql ? "sql" : "javascript"}
          value={tab.body}
          theme={monacoTheme}
          onChange={(value) => store.updateConsole(tab.id, { body: value ?? "", dirty: true })}
          onMount={handleMount}
          options={EDITOR_OPTIONS}
        />
      </div>

      <ResizeHandle
        axis="y"
        value={height}
        min={140}
        max={900}
        invert
        onChange={(value) => setSize("dbResultHeight", value)}
        onCommit={(value) => commitSize("dbResultHeight", value)}
      />

      {/* No `border-t`: the handle above is the seam, and a border here doubled it. */}
      <div style={{ height }} className="flex shrink-0 flex-col overflow-hidden">
        <ConsoleResults tab={tab} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ConsoleResults({ tab }: { tab: DbConsoleTab }) {
  const t = useT();
  const store = useDbStore.getState();
  const openModal = useDbModalStore((s) => s.openDbModal);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [jsonView, setJsonView] = useState(false);
  /** The same gutter selection the data grid has, for the same two reasons: export a few rows, and
   * read a wide one down the page. Read-only here — a console result has no row to delete. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);

  // A Mongo result carries real documents; the JSON view is the useful one for those, so it opens
  // there rather than on a grid of flattened keys.
  useEffect(() => {
    const active = tab.result?.results[tab.activeResult];
    setJsonView((active?.documents.length ?? 0) > 0);
  }, [tab.result, tab.activeResult]);

  // New rows, new indexes — a selection made against the previous result means nothing here.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [tab.result, tab.activeResult]);

  const selectRow = (row: number, mods: { range: boolean; toggle: boolean }) => {
    setSelected((current) => {
      if (mods.range && anchor.current !== null) {
        const [from, to] = [anchor.current, row].sort((a, b) => a - b);
        const next = new Set(mods.toggle ? current : []);
        for (let index = from; index <= to; index += 1) next.add(index);
        return next;
      }
      anchor.current = row;
      if (mods.toggle) {
        const next = new Set(current);
        if (!next.delete(row)) next.add(row);
        return next;
      }
      if (current.size === 1 && current.has(row)) return new Set();
      return new Set([row]);
    });
  };

  if (tab.running) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
        <Loader2 size={13} className="animate-spin" />
        {t("db.running")}
      </div>
    );
  }

  if (tab.plan !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("db.queryPlan")}
          </span>
          <ToolbarButton
            onClick={() => void navigator.clipboard.writeText(tab.plan ?? "")}
            title={t("db.copy")}
          >
            <Copy size={12} />
          </ToolbarButton>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-2 font-mono text-[11.5px] text-[var(--cf-text)]">
          {tab.plan}
        </pre>
      </div>
    );
  }

  const result = tab.result;
  if (!result) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
        <Table2 size={18} className="text-[var(--cf-text-muted)]" />
        <p className="text-[12px] text-[var(--cf-text-muted)]">{t("db.noResultYet")}</p>
        <p className="text-[11px] text-[var(--cf-text-muted)]">{t("db.runHint")}</p>
      </div>
    );
  }

  const active = result.results[tab.activeResult] ?? result.results[0];
  if (!active) {
    return (
      <p className="flex h-full items-center justify-center text-[12px] text-[var(--cf-text-muted)]">
        {t("db.noResultYet")}
      </p>
    );
  }

  const chosen = [...selected].sort((a, b) => a - b);
  /** The result the export and the record view act on: the selection when there is one. */
  const scoped =
    chosen.length === 0
      ? active
      : {
          ...active,
          rows: chosen.map((index) => active.rows[index] ?? []),
          documents: chosen
            .map((index) => active.documents[index])
            .filter((doc): doc is string => doc !== undefined),
        };

  const exportItems: MenuItem[] = (
    ["csv", "tsv", "json", "sql", "markdown"] as ExportFormat[]
  ).map((format) => ({
    label: t("db.exportAs", { format: format.toUpperCase() }),
    icon: Download,
    onClick: async () => {
      const contents = formatResult(scoped, format, "table");
      const saved = await apiSaveFile(`result.${EXPORT_EXTENSIONS[format]}`, contents).catch(
        () => null,
      );
      if (saved) {
        useToastStore.getState().pushToast(t("db.exported", { path: saved }), "success");
      }
    },
  }));
  exportItems.unshift({
    label: t("db.copyAsCsv"),
    icon: Copy,
    onClick: () => void navigator.clipboard.writeText(formatResult(scoped, "csv")),
    separated: false,
  });

  const openRecords = () => {
    const indexes = chosen.length > 0 ? chosen : active.rows.map((_, index) => index);
    if (indexes.length === 0) return;
    openModal({
      kind: "records",
      title: t("db.queryResult"),
      columns: active.columns,
      records: indexes.map((index) => ({ index, values: active.rows[index] ?? [] })),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Result tabs — one per statement in the batch. */}
      {result.results.length > 1 && (
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-[var(--cf-border)] px-1.5 py-1">
          {result.results.map((entry, index) => (
            <button
              key={index}
              onClick={() =>
                store.updateConsole(tab.id, { activeResult: index })
              }
              title={entry.statement}
              className={`shrink-0 rounded-md px-2 py-[2px] text-[11px] font-medium ${
                index === tab.activeResult
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              } ${entry.error ? "text-[var(--cf-danger)]" : ""}`}
            >
              {entry.error ? "⚠ " : ""}
              {index + 1}
            </button>
          ))}
        </div>
      )}

      {/* Status line */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">
        <span className="tabular-nums">{formatDuration(active.duration_ms)}</span>
        {active.rows_affected !== null ? (
          <span className="tabular-nums">
            {t("db.rowsAffected", { n: formatCount(active.rows_affected) })}
          </span>
        ) : (
          <span className="tabular-nums">
            {t("db.rowsN", { n: formatCount(active.rows.length) })}
          </span>
        )}
        {active.truncated && (
          <span
            title={t("db.truncatedHint")}
            className="flex items-center gap-1 text-[var(--cf-warning)]"
          >
            <AlertTriangle size={11} />
            {t("db.truncated")}
          </span>
        )}
        {chosen.length > 0 && (
          <span className="rounded bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] px-1.5 py-[1px] text-[10.5px] font-medium text-[var(--cf-text)]">
            {t("db.rowsSelectedN", { n: String(chosen.length) })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {active.documents.length > 0 && (
            <ToolbarButton
              onClick={() => setJsonView((current) => !current)}
              active={jsonView}
              title={jsonView ? t("db.showGrid") : t("db.showJson")}
            >
              <Braces size={12} />
            </ToolbarButton>
          )}
          <ToolbarButton
            onClick={openRecords}
            disabled={active.rows.length === 0}
            title={chosen.length > 0 ? t("db.viewRecordsSelected") : t("db.viewRecordsAll")}
          >
            <Rows3 size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 180, y: rect.bottom + 2 });
            }}
            disabled={active.rows.length === 0}
            title={
              chosen.length > 0
                ? t("db.exportSelectedN", { n: String(chosen.length) })
                : t("db.export")
            }
          >
            <Download size={12} />
          </ToolbarButton>
        </div>
      </div>

      {active.error ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <p className="flex items-start gap-2 rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/[0.06] p-2 font-mono text-[12px] text-[var(--cf-danger)]">
            <AlertTriangle size={13} className="mt-[2px] shrink-0" />
            <span className="min-w-0 whitespace-pre-wrap break-words">{active.error}</span>
          </p>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--cf-text-muted)]">
            {active.statement}
          </pre>
        </div>
      ) : jsonView && active.documents.length > 0 ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-2 font-mono text-[11.5px] text-[var(--cf-text)]">
          {active.documents.join("\n")}
        </pre>
      ) : (
        <div className="min-h-0 flex-1">
          <ResultGrid
            columns={active.columns}
            rows={active.rows}
            selectedRows={selected}
            onSelectRow={selectRow}
            onSelectAllRows={(on) => {
              anchor.current = null;
              setSelected(on ? new Set(active.rows.map((_, index) => index)) : new Set());
            }}
          />
        </div>
      )}

      {/* Server chatter. Below the grid, not instead of it: a procedure that returns rows *and*
          raises notices should show both. */}
      {active.messages.length > 0 && <Messages messages={active.messages} />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={exportItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function Messages({ messages }: { messages: string[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 border-t border-[var(--cf-border)]">
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      >
        {t("db.serverMessages", { n: String(messages.length) })}
      </button>
      {open && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words px-2 pb-1 font-mono text-[11px] text-[var(--cf-text-muted)]">
          {messages.join("\n")}
        </pre>
      )}
    </div>
  );
}

/** `schema.table`, or just the name where there is no schema. Here rather than in each panel so the
 * tab strip, the data grid's toolbar and the generated `SELECT` all name an object the same way. */
export function nodeLabel(node: DbNodeRef): string {
  return node.schema ? `${node.schema}.${node.name ?? ""}` : (node.name ?? "");
}
