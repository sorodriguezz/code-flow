import { memo, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import {
  AlertTriangle,
  ArrowUp,
  Braces,
  Check,
  CornerDownLeft,
  Database,
  Download,
  Copy,
  Eraser,
  FolderCode,
  Layers,
  List,
  Loader2,
  Play,
  Rows3,
  Save,
  Sparkles,
  Square,
  Table2,
  Waypoints,
  X,
} from "lucide-react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { installSqlCompletions } from "../../lib/db/sqlCompletion";
import { firstStatement, type ConsoleLanguage } from "../../lib/db/statements";
import { ResizeHandle } from "../common/ResizeHandle";
import { Select } from "../common/Select";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { recordModel } from "../../lib/db/engineModel";
import { DocumentList } from "./DocumentList";
import { DocumentsView } from "./DocumentsView";
import { ResultGrid } from "./ResultGrid";
import { cellMenuItems } from "./cellMenu";
import { ScopePicker } from "./ScopePicker";
import { EngineBadge, ToolbarButton, formatCount, formatDuration } from "./dbChrome";
import {
  nodeKey,
  useDbStore,
  type DbAiTurn,
  type DbConsoleAi,
  type DbConsoleTab,
} from "../../state/dbStore";
import { useDbCommandStore } from "../../state/dbCommandStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useDbObjectDragStore } from "../../state/dbObjectDragStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useThemeStore } from "../../state/themeStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { RunEngineChip } from "../ai/AiRunLog";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER,
  modelDisplayLabel,
} from "../../lib/aiProviders";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { Markdown } from "../common/Markdown";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { EXPORT_EXTENSIONS, formatResult, type ExportFormat } from "../../lib/db/resultExport";
import { engineInfo, type DbKind, type DbNodeRef } from "../../types/database";

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
  // Enter takes the highlighted row — the key everyone's hands already reach for, and the one the
  // list itself looks like it is waiting for. `"smart"` rather than `"on"` is what keeps that from
  // costing line breaks: it accepts only when the row would actually change the text, so Enter
  // after a name that is already typed in full is still a newline, and the completion provider's
  // space trigger can keep putting tables in front of you without eating the next line.
  acceptSuggestionOnEnter: "smart",
  // Tab goes back to indenting. With Enter accepting, `"on"` — which completes the best match
  // without the list ever being read — is a second, invisible way to commit a name, and the two
  // disagree about which match is best often enough to be worth losing. Tab still takes the
  // highlighted row while the widget is open; that is Monaco's own binding, not this option.
  tabCompletion: "off",
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
  const aiWidth = useLayoutStore((s) => s.sizes.dbAiWidth);
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
  /**
   * Which Monaco language the console gets.
   *
   * Monaco ships no `redis` language, and writing a Monarch grammar for one is a separate piece of
   * work. `shell` is the honest stand-in: it tokenises `SET key "value"` the way a person reads it
   * — command, argument, quoted string — which is most of what highlighting is for here.
   */
  const monacoLanguage =
    engine?.consoleLanguage === "redis"
      ? "shell"
      : engine?.consoleLanguage === "javascript"
        ? "javascript"
        : "sql";
  const monacoExtension =
    engine?.consoleLanguage === "redis" ? "redis" : isSql ? "sql" : "js";
  /** The grammar the buffer is cut into statements by — see `lib/db/statements.ts`. `"sql"` for a
   *  console whose connection has been deleted, which is what every other read here falls back to. */
  const consoleLanguage: ConsoleLanguage = engine?.consoleLanguage ?? "sql";
  /** The connection's folder, shown ahead of its name in the toolbar. Trimmed and empty for the
   *  ungrouped bucket, which is the same `""` the tree keys that bucket by — see `UNGROUPED`. */
  const group = connection?.group_name.trim() ?? "";

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

  /**
   * What the two run buttons do, and the one rule they share.
   *
   * **A selection always wins.** Highlighting a fragment is the most explicit thing a console
   * offers, and it means the same on both buttons — so the difference between them is only what
   * happens when nothing is highlighted:
   *
   * - `"one"` (Run, ⌘↵) runs the **first** statement in the buffer. A console is a script you build
   *   up and re-run the top of; a Run button that fired every statement in it meant the safe,
   *   obvious key was the one that ran the whole file.
   * - `"all"` (⇧⌘↵) runs the buffer end to end, in order. That is the deliberate act, so it is the
   *   one on the button you have to go and find.
   *
   * Nothing is sent for an empty console, or for one holding only comments: `firstStatement`
   * answers `null` there rather than pretending the first blank line is a statement.
   */
  const run = (mode: "one" | "all") => {
    const editor = editorRef.current;
    // Read at call time rather than through the render's captured `store`: this also runs from a
    // Monaco chord registered once for the life of the panel — see `commandsRef`.
    const live = useDbStore.getState();
    const selection = editor?.getSelection();
    const selected =
      selection && !selection.isEmpty() ? editor?.getModel()?.getValueInRange(selection) ?? "" : "";
    if (selected.trim()) {
      void live.runConsole(tab.id, selected);
      return;
    }
    if (mode === "all") {
      void live.runConsole(tab.id);
      return;
    }
    // Read off the store, not off the render's `tab`: the ⌘↵ chord is registered once for the life
    // of the panel and fires long after this closure was built — the same staleness `commandsRef`
    // exists for. Monaco's `onChange` writes straight into the tab, so this is the live text.
    const current = live.tabs.find((entry) => entry.id === tab.id);
    const body = current?.kind === "console" ? current.body : tab.body;
    const first = firstStatement(body, consoleLanguage);
    if (first) void live.runConsole(tab.id, first);
  };

  /**
   * A table dragged out of the explorer, and whether it is over this editor.
   *
   * Refused unless it came from *this* connection: `text` was quoted for the engine it was dragged
   * from (`[x]` on SQL Server, `"x"` elsewhere), so the same name pasted into another engine's
   * console is a syntax error waiting to be run. Refusing shows as the drop hint simply never
   * appearing, which is the same answer the rest of the app gives for a drop that can't land.
   */
  const objectDrag = useDbObjectDragStore((s) => s.drag);
  const endObjectDrag = useDbObjectDragStore((s) => s.end);
  const [dropOver, setDropOver] = useState(false);
  const acceptsDrop = objectDrag !== null && objectDrag.connectionId === tab.connectionId;
  /** The editor's pane, so a release anywhere on screen can be tested against its box. */
  const editorBoxRef = useRef<HTMLDivElement>(null);

  // The drag can end anywhere — over the results, outside the window — and the highlight has to go
  // with it. `dbObjectDragStore` clears the drag from a `window` listener, so this is the one signal
  // that arrives for every ending, including the ones this panel never sees.
  useEffect(() => {
    if (!objectDrag) setDropOver(false);
  }, [objectDrag]);

  /**
   * Inserts the dragged name where it was dropped, not where the caret happens to be.
   *
   * `getTargetAtClientPoint` is what makes that possible: you aim at a spot in a half-written
   * `SELECT ... FROM` and the name lands there. Falling back to the caret covers the drop that
   * lands past the last line, where there is no position under the pointer to resolve.
   */
  const insertObject = (text: string, clientX: number, clientY: number) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const position = editor.getTargetAtClientPoint(clientX, clientY)?.position ?? editor.getPosition();
    if (!position) return;

    // A name dropped straight after a word would weld itself to it — `FROM"public"."x"` parses, and
    // is unreadable. One space when the character before is one a name cannot legally touch.
    const before = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    const padded = /[\w"'`\])]$/.test(before) ? ` ${text}` : text;

    const at = {
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    };
    editor.executeEdits("cf-drop-object", [{ range: at, text: padded, forceMoveMarkers: true }]);
    // The caret lands after what was inserted, so you can keep typing the clause it belongs to.
    editor.setPosition({ lineNumber: position.lineNumber, column: position.column + padded.length });
    editor.focus();
  };

  /**
   * The drop itself, from `window` rather than from a handler on the editor's wrapper.
   *
   * Monaco owns the DOM under this pane and there is no contract that says a `pointerup` inside it
   * reaches a React handler above — a listener on the wrapper works right up until it doesn't. A
   * hit test against the pane's own box asks the question directly instead.
   *
   * **Capture phase, and that is load-bearing.** `dbObjectDragStore` arms its own `pointerup` on
   * `window` the moment the press begins, to guarantee a drag can never get stuck; registered in
   * the bubble phase this would run *after* it, and the drag would already be `null`. Capture-phase
   * listeners on `window` run before every bubble-phase one, so this reads the drag while it lives.
   */
  useEffect(() => {
    if (!acceptsDrop || !objectDrag) return;
    const drop = (e: PointerEvent) => {
      const box = editorBoxRef.current?.getBoundingClientRect();
      if (!box) return;
      const inside =
        e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      if (!inside) return;
      insertObject(objectDrag.text, e.clientX, e.clientY);
      endObjectDrag();
    };
    window.addEventListener("pointerup", drop, true);
    return () => window.removeEventListener("pointerup", drop, true);
    // `insertObject` is rebuilt every render but closes over nothing that changes — only `editorRef`
    // — so the drag itself is the whole dependency, and the listener exists only while one is live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptsDrop, objectDrag, endObjectDrag]);

  /**
   * Puts a proposed statement where the caret is, as one undoable edit.
   *
   * An insert and not an overwrite: the console is usually a script, and the answer to "give me a
   * query for X" belongs next to what is already there rather than on top of it. ⌘Z takes it back,
   * which is the whole reason this goes through Monaco instead of `updateConsole`.
   */
  const insertAtCursor = (text: string) => {
    const editor = editorRef.current;
    const position = editor?.getPosition();
    if (!editor || !position) return;
    // A statement dropped mid-line would weld itself to whatever is there; on its own line it is
    // readable and, on the engines that split on `;`, separately runnable.
    const padded = position.column > 1 ? `\n${text}\n` : `${text}\n`;
    editor.executeEdits("cf-db-ai-insert", [
      {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
        text: padded,
        forceMoveMarkers: true,
      },
    ]);
    editor.focus();
  };

  /**
   * What ⌘↵ / ⌘⇧↵ / ⌘S should do *right now*, rewritten on every render.
   *
   * The chords are registered once, in `handleMount`, and that used to be enough to make them run
   * the wrong console's SQL. `@monaco-editor/react` keys its editor by `path`, which means it keeps
   * **one editor instance** and swaps the model when the tab changes — so `onMount` fires exactly
   * once, on whichever console was open first, and the callbacks it registered kept that render's
   * `run` and `tab.id` for the rest of the session. Pressing ⌘↵ in console B therefore executed
   * console A's statement, against console A's connection.
   *
   * That is the same trap `RequestBuilder`'s `actionsRef` exists for, and the same fix: the
   * registration is stable, the ref is not, and the command reads the ref at the moment it fires.
   */
  const commandsRef = useRef<{ run: (mode: "one" | "all") => void; save: () => void }>({
    run,
    save: () => {},
  });
  commandsRef.current = {
    run,
    save: () => void useDbStore.getState().saveConsole(tab.id),
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      commandsRef.current.run("one"),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () =>
      commandsRef.current.run("all"),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => commandsRef.current.save());
  };

  /**
   * The keyboard's way into the assistant, through the shortcut registry rather than a chord bound
   * here — so it is rebindable and shows up in the shortcuts list like every other action.
   *
   * Consumed whether or not it did anything, the same rule `DataTabPanel` follows: a request left
   * pending replays itself the moment another tab mounts. Opening an already-open bar is not a
   * close — a second press means "let me type the next question", so it only refocuses.
   */
  const request = useDbCommandStore((s) => s.request);
  useEffect(() => {
    if (!request) return;
    useDbCommandStore.getState().consume();
    if (request.command !== "askAi") return;
    if (!tab.ai) store.toggleConsoleAi(tab.id);
    window.dispatchEvent(new CustomEvent("cf-db-ai-focus", { detail: tab.id }));
    // The nonce is what makes a repeated command a new one; `tab.ai` is read fresh on each.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        {connection && <EngineBadge kind={connection.kind} label={engine?.label ?? ""} />}
        {/* The group, ahead of the connection it holds — the same order the explorer draws them in,
            so a console opened from the tree reads as the path you clicked down. Muted and with the
            tree's own folder icon, because the connection is the subject here and the group is where
            it lives; the slash is what says so without a second line of chrome.

            Absent when the connection is ungrouped rather than rendered as "Sin grupo /": that is a
            bucket, not a folder, and naming it here would put a word in front of every console
            belonging to somebody who never made a group. */}
        {group && (
          <span className="flex min-w-0 items-center gap-1 text-[12px] text-[var(--cf-text-muted)]">
            <FolderCode size={11} className="shrink-0" />
            <span className="max-w-[110px] truncate">{group}</span>
            <span aria-hidden>/</span>
          </span>
        )}
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
              onClick={() => run("one")}
              title={t("db.runHint")}
              className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-[3px] text-[12px] font-medium text-white hover:brightness-110"
            >
              <Play size={11} />
              {t("db.run")}
            </button>
          )}
          <ToolbarButton
            onClick={() => run("all")}
            disabled={tab.running}
            title={t("db.runAllHint")}
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
            onClick={() => store.toggleConsoleAi(tab.id)}
            title={tab.ai?.running ? t("db.aiThinking") : t("db.aiHint")}
            active={tab.ai !== null}
            dataTour="db-ai"
          >
            {/* The orb reaches the toolbar too, so a console with the panel closed still shows that
                something is running — and so the button that would close it (and cancel the run)
                says what it is about to interrupt. */}
            {tab.ai?.running ? <ThinkingOrb size="sm" /> : <Sparkles size={13} />}
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

      {/* The console proper and, beside it, the assistant.
          **Beside, not above.** The panel used to be a bar between the toolbar and the editor, and
          it grew downwards as the answer came in — so asking a question pushed the query you were
          asking about off the screen, which is the one thing you need to keep reading while you
          read the reply. A column keeps both: the statement stays where it was, at the height it
          was, and the conversation runs down its own edge. It is also the shape a chat wants —
          turns stack vertically, and a 340px-tall bar can hold about one. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Editor */}
          <div
            ref={editorBoxRef}
            className="relative min-h-0 flex-1"
            // Highlight only — the drop is handled from `window` above, because these handlers sit on
            // top of Monaco's own DOM and are not guaranteed to see a release inside it. `pointerenter`
            // covers the drag arriving from the tree; `pointermove` is the belt to its braces, for one
            // that begins with the pointer already inside. Guarded, so it is a comparison per move
            // rather than a render.
            onPointerEnter={() => {
              if (acceptsDrop) setDropOver(true);
            }}
            onPointerMove={() => {
              if (acceptsDrop && !dropOver) setDropOver(true);
            }}
            onPointerLeave={() => setDropOver(false)}
          >
            <Editor
              height="100%"
              // One model per tab, so two consoles keep their own undo history and cursor. The scheme
              // is this panel's own — `cf-editor` URIs are file models and would be offered to
              // "go to definition".
              path={`cf-db:/console/${tab.id}.${monacoExtension}`}
              language={monacoLanguage}
              value={tab.body}
              theme={monacoTheme}
              onChange={(value) => store.updateConsole(tab.id, { body: value ?? "", dirty: true })}
              onMount={handleMount}
              options={EDITOR_OPTIONS}
            />
            {/* `pointer-events-none` so the drop still reaches the wrapper's handler and Monaco can
                still resolve the position under the pointer — an overlay that swallowed the release
                would be a drop target you cannot drop on. */}
            {dropOver && objectDrag && (
              <div className="pointer-events-none absolute inset-0 z-10 flex justify-center rounded-sm border-2 border-dashed border-[var(--cf-accent)] bg-[color-mix(in_oklab,var(--cf-accent)_7%,transparent)]">
                <span className="mt-3 h-fit rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2 py-1 text-[11px] text-[var(--cf-text)] shadow-[var(--cf-shadow)]">
                  {t("db.dropObjectHint", { name: objectDrag.label })}
                </span>
              </div>
            )}
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

        {tab.ai && (
          <>
            <ResizeHandle
              axis="x"
              value={aiWidth}
              min={280}
              max={720}
              invert
              onChange={(value) => setSize("dbAiWidth", value)}
              onCommit={(value) => commitSize("dbAiWidth", value)}
            />
            <ConsoleAiPanel
              tab={tab}
              ai={tab.ai}
              width={aiWidth}
              onInsert={insertAtCursor}
              onRun={(sql) => void useDbStore.getState().runConsole(tab.id, sql)}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

/** The routing key this assistant runs under — the same one Settings' "Model per task" writes,
 *  and `AiTask::DbQuery` on the Rust side. */
const TASK = "db_query";

/**
 * One turn on screen: what was asked, or what came back and what can be done with it.
 *
 * Split out of the panel because the two roles are genuinely different objects — a question is a
 * line of text, an answer is Markdown with a statement under it and three things you can do to
 * that statement — and because a transcript re-renders on every token of the run in flight while
 * the turns behind it have not changed.
 */
const AiTurn = memo(function AiTurn({
  turn,
  onInsert,
  onReplace,
  onRun,
}: {
  turn: DbAiTurn;
  onInsert: (text: string) => void;
  onReplace: (text: string) => void;
  onRun: (text: string) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  if (turn.role === "user") {
    return (
      // The question, right-aligned and in a tinted bubble — the one convention every chat shares,
      // and the cheapest way to tell two speakers apart down a narrow column without a label per
      // turn. `whitespace-pre-wrap` because a pasted query keeps its own lines.
      <div className="flex justify-end px-2.5">
        <p className="max-w-[92%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-[var(--cf-accent-soft)] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--cf-text)]">
          {turn.text}
        </p>
      </div>
    );
  }

  return (
    <div className="px-2.5">
      <Markdown
        source={turn.text}
        className="cf-markdown-preview text-[12px] leading-relaxed"
      />
      {turn.query && (
        // The three things a proposed statement is for. Not hidden behind the last turn: scrolling
        // back to the query from four questions ago and being able to insert *that* one is most of
        // why the transcript is kept at all.
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => onInsert(turn.query as string)}
            className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-[3px] text-[11.5px] font-medium text-[var(--cf-text)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <CornerDownLeft size={10} />
            {t("db.aiInsert")}
          </button>
          <button
            onClick={() => onReplace(turn.query as string)}
            className="rounded-md border border-[var(--cf-border)] px-2 py-[3px] text-[11.5px] font-medium text-[var(--cf-text)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {t("db.aiReplace")}
          </button>
          {/* Puts it in the editor *and* runs it — the two clicks this panel was making everybody
              do in sequence. Still through the console, so the `DELETE` with no `WHERE` guard and
              the read-only flag apply exactly as they do to anything typed by hand. */}
          <button
            onClick={() => onRun(turn.query as string)}
            className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-[3px] text-[11.5px] font-medium text-[var(--cf-text)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <Play size={10} />
            {t("db.aiRun")}
          </button>
          <button
            onClick={() => copy(turn.query as string)}
            className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-[3px] text-[11.5px] font-medium text-[var(--cf-text)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {t("db.copy")}
          </button>
        </div>
      )}
      {/* What the answer was based on. A model that names a table you don't have is nearly always a
          model that was shown a different scope than the one you meant, so the count and the
          truncation warning belong next to the answer, not in a log. */}
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
        {turn.schemaTruncated && (
          <span className="text-[var(--cf-warning)]">{t("db.aiSchemaTruncated")}</span>
        )}
        {turn.tablesSeen !== undefined && t("db.aiTablesSeen", { count: turn.tablesSeen })}
        <RunEngineChip runId={turn.runId ?? undefined} />
      </div>
    </div>
  );
});

/**
 * A conversation with the connected database — ⌘I, or the sparkle in the toolbar.
 *
 * **A column beside the query, and a chat rather than a single answer.** Both of those were the
 * same complaint. It used to be a bar between the toolbar and the editor holding exactly one
 * question and one reply: a long answer pushed the statement it was about off the screen, and the
 * only things you could do with the reply were insert it, replace with it, or close — so "and now
 * group that by month" meant retyping the whole question with the previous answer pasted into it.
 * Here the turns stack down their own edge, the editor keeps its height, and every question is
 * asked with what has already been said (see `askConsoleAi`).
 *
 * The engine never touches the database. The schema is read by CodeFlow's own driver on the Rust
 * side and put on stdin, and a proposed statement is only ever *offered* — the buttons under it go
 * through the editor and the console's own guards, which is what keeps "run it" from being a way
 * around the `DELETE`-without-`WHERE` refusal or the connection's read-only flag.
 */
function ConsoleAiPanel({
  tab,
  ai,
  width,
  onInsert,
  onRun,
}: {
  tab: DbConsoleTab;
  ai: DbConsoleAi;
  width: number;
  onInsert: (text: string) => void;
  onRun: (text: string) => void;
}) {
  const t = useT();
  const store = useDbStore.getState();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const defaultProvider = useAiProviderStore((s) => s.providerId);
  const routedProvider = useAiProviderStore((s) => s.taskProviders[TASK]);
  const engineModel = useAiProviderStore((s) => s.taskModels[TASK]) ?? "";

  // Opening the panel puts the caret in it — the point of the shortcut is to type the question, and
  // a second ⌘I with it already open comes back here rather than closing what is being read.
  useEffect(() => {
    inputRef.current?.focus();
    const refocus = (event: Event) => {
      if ((event as CustomEvent<string>).detail === tab.id) inputRef.current?.focus();
    };
    window.addEventListener("cf-db-ai-focus", refocus);
    return () => window.removeEventListener("cf-db-ai-focus", refocus);
  }, [tab.id]);

  // The box grows with what is in it rather than standing two lines tall while empty. A pasted
  // statement is what actually makes this field tall, and 160px is where it stops growing and
  // starts scrolling — past that it would be eating the transcript it is asking about.
  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [ai.question, width]);

  // Follows the conversation down. Keyed on the turn count and on `running`, which are the two
  // moments something is added to the bottom — not on every render, which would fight a user
  // scrolled up reading an earlier answer.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [ai.messages.length, ai.running]);

  // Resolved through the same fallback chain the backend uses (`ai_provider_db_query` → the global
  // default; `{provider}_db_query_model` → the provider's base model), so what this names cannot
  // disagree with what actually runs.
  const engineId = routedProvider?.trim() || defaultProvider || DEFAULT_AI_PROVIDER;
  const engineMeta = AI_PROVIDERS.find((entry) => entry.id === engineId);
  const engineLabel = engineMeta?.label ?? (engineMeta?.labelKey ? t(engineMeta.labelKey) : engineId);

  const replace = (sql: string) => store.updateConsole(tab.id, { body: sql, dirty: true });

  /** Nothing said yet — the transcript is a centred pitch rather than a column with one line at the
   *  top of it. Also what picks the composer's placeholder. */
  const idle = ai.messages.length === 0 && !ai.running;

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col overflow-hidden border-l border-[var(--cf-border)] bg-[var(--cf-surface-raised)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        <Sparkles size={13} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">
          {t("db.aiTitle")}
        </span>
        {/* Emptying the transcript without closing the panel. A conversation is what the next
            question is answered *against*, so one that has wandered onto another table is a cost —
            and closing the panel to be rid of it would also lose its place on screen. */}
        {ai.messages.length > 0 && (
          <ToolbarButton onClick={() => store.clearConsoleAi(tab.id)} title={t("db.aiClearChat")}>
            <Eraser size={13} />
          </ToolbarButton>
        )}
        <ToolbarButton onClick={() => store.toggleConsoleAi(tab.id)} title={t("common.close")}>
          <X size={13} />
        </ToolbarButton>
      </div>

      <div
        ref={scrollerRef}
        className={`min-h-0 flex-1 space-y-3 overflow-y-auto py-2.5 ${
          idle ? "flex flex-col justify-center" : ""
        }`}
      >
        {idle && (
          // What the panel is for, centred in the column it is about to fill, and only that. The
          // engine used to be named here as well, which answered "what is about to answer me" in
          // the one state that stops existing the moment you ask it something; it sits on the
          // composer now, where it is still on screen at the fourth question.
          <div className="flex shrink-0 flex-col items-center gap-2 px-5 text-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--cf-accent-soft)]">
              <Sparkles size={14} className="text-[var(--cf-accent)]" />
            </span>
            <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("db.aiPlaceholder")}
            </p>
          </div>
        )}

        {ai.messages.map((turn, at) => (
          <AiTurn
            key={at}
            turn={turn}
            onInsert={onInsert}
            onReplace={replace}
            onRun={onRun}
          />
        ))}

        {ai.running && (
          <div className="flex items-center gap-1.5 px-2.5 text-[11.5px] text-[var(--cf-text-muted)]">
            {/* The orb and not a spinner: this is an engine burning context, which is the one thing
                the orb says and a rotating ring does not. Same mark the agent console uses. */}
            <ThinkingOrb size="sm" />
            {t("db.aiThinking")}
            <RunEngineChip runId={ai.runId ?? undefined} />
          </div>
        )}

        {ai.error && !ai.running && (
          <div className="mx-2.5 flex items-start gap-1.5 rounded-md border border-[var(--cf-danger)] px-2 py-1.5 text-[11.5px] text-[var(--cf-danger)]">
            <AlertTriangle size={12} className="mt-[2px] shrink-0" />
            <span className="min-w-0 break-words">{ai.error}</span>
          </div>
        )}
      </div>

      {/* The composer as one field rather than a field with a button beside it. In a 280px column a
          labelled button took a third of the width and made the box read as half of one, so the
          send control moved onto the field's own bottom edge — and the engine line came down with
          it. Naming the engine here rather than in the empty state is the point of the move: what
          is about to answer is a question you have at the fourth turn too, and the empty state is
          the one place that has already stopped existing by then. */}
      <div className="shrink-0 border-t border-[var(--cf-border)] p-2">
        <div className="rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] transition-colors focus-within:border-[var(--cf-accent)]">
          <textarea
            ref={inputRef}
            rows={1}
            value={ai.question}
            placeholder={
              ai.messages.length > 0 ? t("db.aiFollowUp") : t("db.aiComposerPlaceholder")
            }
            onChange={(e) => store.setConsoleAiQuestion(tab.id, e.target.value)}
            onKeyDown={(e) => {
              // Enter asks, ⇧Enter is a newline — the shape of every chat box, and the one that
              // keeps a pasted query on its own lines.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void store.askConsoleAi(tab.id);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                store.toggleConsoleAi(tab.id);
              }
            }}
            className="block max-h-[160px] w-full resize-none bg-transparent px-2.5 pb-1 pt-2 text-[12.5px] leading-[18px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)]"
          />
          <div className="flex items-center gap-1.5 px-2 pb-1.5">
            {/* A label, never a control. Changing the routing is Settings' job — a picker here would
                be the second place to set it, which is how two places end up disagreeing. */}
            <ProviderGlyph providerId={engineId} size={11} />
            <span
              className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--cf-text-muted)]"
              title={`${engineLabel} · ${modelDisplayLabel(engineId, engineModel, t)}`}
            >
              {engineLabel} · {modelDisplayLabel(engineId, engineModel, t)}
            </span>
            {ai.running ? (
              <button
                onClick={() => void store.cancelConsoleAi(tab.id)}
                title={t("db.cancel")}
                aria-label={t("db.cancel")}
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border border-[var(--cf-danger)] text-[var(--cf-danger)] hover:bg-[var(--cf-danger)]/10"
              >
                <Square size={9} />
              </button>
            ) : (
              <button
                onClick={() => void store.askConsoleAi(tab.id)}
                disabled={!ai.question.trim()}
                title={t("db.aiAsk")}
                aria-label={t("db.aiAsk")}
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent)] text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ArrowUp size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}


// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ConsoleResults({ tab }: { tab: DbConsoleTab }) {
  const t = useT();
  const store = useDbStore.getState();
  const openModal = useDbModalStore((s) => s.openDbModal);
  /** Whose rules these fields are read by. Only the kind is needed here — the panel above already
   *  owns everything else about the connection — and the fallback is the one `recordModel` makes
   *  for an unknown engine, for a console whose connection was deleted while its rows were up. */
  const kind: DbKind =
    useDbStore((s) => s.connections.find((c) => c.id === tab.connectionId)?.kind) ?? "postgres";
  /** What this engine calls the things it just returned — "50 filas" under a page of documents was
   *  the console describing a Mongo result in SQL's noun. */
  const counts = recordModel(kind).counts;
  /**
   * The one floating menu this panel has room for, wherever it was opened from.
   *
   * `items` is what distinguishes them: absent means the export menu, which is the toolbar button
   * this state was originally added for. A right-click on a result cell fills it in instead. One
   * piece of state rather than two because only one menu can be open at a time — two would let a
   * cell menu and the export menu sit on screen together, each waiting for a click.
   */
  const [menu, setMenu] = useState<{ x: number; y: number; items?: MenuItem[] } | null>(null);
  /** Which of the three document views is up. Mirrors the data tab's switcher exactly, on purpose:
   *  a document looked at from a `find()` and the same document looked at by opening the collection
   *  should not be two different screens.
   *
   *  On the tab record, because one `SqlConsolePanel` instance serves every console tab. It is put
   *  back to `documents` by `runConsole` when a new result arrives — see the note there for why the
   *  reset cannot live in an effect here. */
  const { docView } = tab.ui;
  const setUi = useDbStore((s) => s.setConsoleUi);
  /** The same gutter selection the data grid has, for the same two reasons: export a few rows, and
   * read a wide one down the page. Read-only here — a console result has no row to delete. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);

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

  const failedCount = result.results.filter((entry) => entry.error !== null).length;

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
      engine: kind,
      // No keys: a console result is whatever the statement projected, and an arbitrary query has
      // no one table to resolve a primary key or a reference against. What is still markable is
      // what the engine names by convention — `_id`, IRIS's `ID` — and the model handles that.
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
        {/* How the batch as a whole went, next to how the selected statement went. Without it a run
            of twenty writes is twenty numbered tabs and no answer to "did that work" — you would
            have to click each one. Counted over the results that came *back*: the engines stop at
            the first failure, so a batch that broke at 5 returns five results and this says four of
            five, which is what actually ran. The tabs are what show which one broke. */}
        {result.results.length > 1 && (
          <>
            <span className="tabular-nums">
              {t("db.batchOk", {
                n: String(result.results.length - failedCount),
                total: String(result.results.length),
              })}
            </span>
            {failedCount > 0 && (
              <span className="tabular-nums text-[var(--cf-danger)]">
                {t("db.batchFailed", { n: String(failedCount) })}
              </span>
            )}
          </>
        )}
        {active.rows_affected !== null ? (
          <span className="tabular-nums">
            {t(counts.affected, { n: formatCount(active.rows_affected) })}
          </span>
        ) : (
          <span className="tabular-nums">
            {t(counts.n, { n: formatCount(active.rows.length) })}
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
            {t(counts.selected, { n: String(chosen.length) })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {active.documents.length > 0 && (
            <>
              <ToolbarButton
                onClick={() => setUi(tab.id, { docView: "documents" })}
                active={docView === "documents"}
                title={t("db.documentList")}
              >
                <List size={12} />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => setUi(tab.id, { docView: "json" })}
                active={docView === "json"}
                title={t("db.showJson")}
              >
                <Braces size={12} />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => setUi(tab.id, { docView: "grid" })}
                active={docView === "grid"}
                title={t("db.showGrid")}
              >
                <Table2 size={12} />
              </ToolbarButton>
            </>
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
      ) : active.documents.length > 0 && docView !== "grid" ? (
        docView === "documents" ? (
          <DocumentList documents={active.documents} />
        ) : (
          <DocumentsView id={tab.id} documents={active.documents} />
        )
      ) : active.columns.length === 0 && active.documents.length === 0 ? (
        /* A statement that succeeded and projected nothing — an INSERT, a DELETE, a CREATE TABLE.
           The grid's own empty state ("returned no columns") is *true* here and reads as a failure,
           which is the wrong answer to the only question being asked: did it work. It did, so the
           panel says so, and the row count that was already in the status line above is repeated
           here because that line is a strip of grey 11px numbers nobody reads after a write. */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-3 text-center">
          <Check size={20} className="text-[var(--cf-success)]" />
          <p className="text-[13px] font-medium text-[var(--cf-text)]">
            {active.rows_affected !== null
              ? t(counts.affected, { n: formatCount(active.rows_affected) })
              : t("db.statementOk")}
          </p>
          <p className="max-w-[30rem] text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {t("db.statementOkHint")}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <ResultGrid
            engine={kind}
            columns={active.columns}
            rows={active.rows}
            // Per tab, for the same reason the data tab's are — one panel instance serves every
            // console, so widths held in the grid were applied by column name across all of them.
            widths={tab.ui.widths}
            onWidths={(widths) => setUi(tab.id, { widths })}
            // A console result is read-only — it is whatever the statement returned, not a table
            // with a primary key to write back through — so `onSet` is null and the menu comes out
            // as Copy alone. The three editing entries belong to the data tab, where there is
            // something to save them to.
            onCellContextMenu={(row, column, event) => {
              const columnIndex = active.columns.findIndex((entry) => entry.name === column);
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: cellMenuItems({ value: active.rows[row]?.[columnIndex] ?? null, onSet: null }, t),
              });
            }}
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
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items ?? exportItems}
          onClose={() => setMenu(null)}
        />
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
