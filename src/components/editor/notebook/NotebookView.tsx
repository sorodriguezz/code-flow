import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Eraser,
  FileDown,
  ListStart,
  Plus,
  RotateCcw,
  Search,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { AiSparkles } from "../../common/AiGlyph";
import { Tooltip } from "../../common/Tooltip";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { ChatModelPicker } from "../../ai/ChatModelPicker";
import { cellOutputs, cellSource, notebookFileExtension, notebookLanguage } from "../../../lib/notebook/nbformat";
import { outputText } from "../../../lib/notebook/outputs";
import { notebookToScript, scriptExtension } from "../../../lib/notebook/exportPy";
import { notebookKey } from "../../../lib/notebook/host";
import { languageForPath } from "../../../lib/monacoLanguage";
import { modelPathFor } from "../../../lib/editorModel";
import { VSCODE_ANSI } from "../../../lib/terminalTheme";
import { findTheme } from "../../../lib/codeThemes";
import { openExternalUrl, writeFileBytes } from "../../../lib/tauri/commands";
import { notebookActions, useNotebookStore } from "../../../state/notebookStore";
import { useThemeStore } from "../../../state/themeStore";
import { chooseAction } from "../../../state/confirmStore";
import { pushErrorToast, pushSuccessToast } from "../../../state/toastStore";
import { useT } from "../../../state/languageStore";
import type { Project } from "../../../types/domain";
import { CellScrollRoot, type CellKey } from "./CellEditor";
import { NotebookCellView } from "./NotebookCellView";
import { CellAiPanel, GeneratePrompt, NOTEBOOK_TASK } from "./CellAiPanel";
import { KernelPicker, installIpykernel } from "./KernelPicker";
import type { OutputPalette } from "./HtmlOutput";

/** Monaco models of every notebook cell live under this scheme — never `cf-editor:`, so the
 *  language servers, which serve that one, leave them alone. */
const CELL_SCHEME = "cf-notebook";

/**
 * Where a notebook's cell models live: `cf-notebook:/<project>/<path>/<cell key>`, each segment
 * encoded as the editor's own model paths are (`modelPathForId`). Given back the way Monaco prints
 * a URI, since that is what it is compared against when the models are disposed.
 */
function cellModelPrefix(projectId: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const probe = "__cell__";
  const printed = monaco.Uri.parse(`${CELL_SCHEME}:/${encodeURIComponent(projectId)}/${encoded}/${probe}`).toString();
  return printed.slice(0, -probe.length);
}

/** Disposes the cell models of notebooks whose session closed — the tab went, the models go. Once,
 *  at module load: the store outlives every view. */
const prefixes = new Map<string, string>();
useNotebookStore.subscribe((state, previous) => {
  for (const key of Object.keys(previous.sessions)) {
    if (state.sessions[key]) continue;
    const prefix = prefixes.get(key);
    prefixes.delete(key);
    if (!prefix) continue;
    for (const model of monaco.editor.getModels()) {
      if (model.uri.toString().startsWith(prefix)) model.dispose();
    }
  }
});

/** The cell editor's language: the kernel's file extension first, then the language's name. */
function monacoLanguageFor(language: string, extension: string | null): string {
  if (extension) {
    const byExtension = languageForPath(`cell${extension}`);
    if (byExtension !== "plaintext") return byExtension;
  }
  const aliases: Record<string, string> = { "c++": "cpp", "c#": "csharp", bash: "shell", sh: "shell", zsh: "shell" };
  const wanted = aliases[language] ?? language;
  const known = monaco.languages.getLanguages().some((entry) => entry.id === wanted);
  return known ? wanted : "plaintext";
}

function usePalette(): { palette: OutputPalette; ansi: Record<string, string> } {
  const resolved = useThemeStore((s) => s.resolved);
  const darkThemeId = useThemeStore((s) => s.darkThemeId);
  const lightThemeId = useThemeStore((s) => s.lightThemeId);
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const text = read("--cf-text", resolved === "dark" ? "#e5e5e5" : "#1f2328");
    const palette: OutputPalette = {
      scheme: resolved,
      text,
      muted: read("--cf-text-muted", "#888888"),
      border: read("--cf-border", "#80808040"),
      stripe: `color-mix(in srgb, ${text} 4%, transparent)`,
      hover: `color-mix(in srgb, ${text} 8%, transparent)`,
      accent: read("--cf-accent", "#3b82f6"),
    };
    const scheme = findTheme(resolved === "dark" ? darkThemeId : lightThemeId, resolved);
    const colors = scheme.ansi ?? VSCODE_ANSI[scheme.mode];
    const ansi: Record<string, string> = {};
    colors.forEach((color, index) => {
      ansi[`--nb-ansi-${index}`] = color;
    });
    return { palette, ansi };
  }, [resolved, darkThemeId, lightThemeId]);
}

/** The sixteen ANSI classes `ansiToHtml` writes, mapped onto the scheme's terminal palette. */
const ANSI_CSS = [
  ...Array.from({ length: 16 }, (_, i) => `.nb-root .nb-ansi-fg-${i}{color:var(--nb-ansi-${i})}`),
  ...Array.from({ length: 16 }, (_, i) => `.nb-root .nb-ansi-bg-${i}{background-color:var(--nb-ansi-${i})}`),
  ".nb-root .nb-ansi-bold{font-weight:600}",
  ".nb-root .nb-ansi-dim{opacity:.7}",
  ".nb-root .nb-ansi-italic{font-style:italic}",
  ".nb-root .nb-ansi-underline{text-decoration:underline}",
].join("\n");

interface SearchState {
  open: boolean;
  query: string;
  at: number;
}

/**
 * A Jupyter notebook in the editor: cells to edit and run on a real kernel, outputs as Jupyter
 * draws them, and AI per cell. The file stays the tab's (see `notebookStore`); this is a view of it.
 *
 * Keys, as in Jupyter. **Edit mode** (in a cell's editor): ⇧↵ run and move on, ⌘/Ctrl↵ run in
 * place, Esc to command mode. **Command mode** (a cell selected): ↵ edit, ↑/↓ or K/J move, A/B add
 * above/below, D D delete, Z undo the delete, M/Y/R make it Markdown/code/raw, and the run keys.
 */
export default function NotebookView({
  project,
  path,
  content,
  focused,
  monacoTheme,
  onSave,
}: {
  project: Project;
  path: string;
  /** The tab's text. */
  content: string;
  focused: boolean;
  monacoTheme: string;
  onSave: () => void;
}) {
  const t = useT();
  const key = useMemo(() => notebookKey(project.local_path, path), [project.local_path, path]);
  const session = useNotebookStore((s) => s.sessions[key]);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const editors = useRef(new Map<string, MonacoEditorNS.IStandaloneCodeEditor>());
  const lastD = useRef(0);
  const [search, setSearch] = useState<SearchState>({ open: false, query: "", at: 0 });
  const { palette, ansi } = usePalette();
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useLayoutEffect(() => {
    prefixes.set(key, cellModelPrefix(project.id, path));
    notebookActions.open({
      repoPath: project.local_path,
      path,
      projectId: project.id,
      workspaceId: project.workspace_id ?? null,
      text: content,
    });
  }, [key, content, project.id, project.local_path, project.workspace_id, path]);

  // The file's JSON model, left from an earlier visit to the JSON view: it falls behind the notebook
  // with the first edit made here, and the editor reuses a kept model as it is — the JSON view would
  // reopen on the old text, and typing in it would write the old text back. Gone, it is made afresh
  // from the tab when the JSON is next shown.
  useEffect(() => {
    monaco.editor.getModel(monaco.Uri.parse(modelPathFor(project, path)))?.dispose();
  }, [project, path]);

  useEffect(() => {
    if (!focused) return;
    notebookActions.setFocused(key);
    return () => {
      if (useNotebookStore.getState().focusedKey === key) notebookActions.setFocused(null);
    };
  }, [focused, key]);

  const doc = session?.doc ?? null;
  const language = useMemo(
    () => (doc ? monacoLanguageFor(notebookLanguage(doc), notebookFileExtension(doc)) : "python"),
    [doc],
  );
  const modelPrefix = cellModelPrefix(project.id, path);

  // A deleted cell's model goes with it; `undoDelete` brings the text back into a fresh one.
  const cellKeys = useMemo(() => new Set(doc?.cells.map((cell) => cell.key) ?? []), [doc]);
  useEffect(() => {
    for (const model of monaco.editor.getModels()) {
      const uri = model.uri.toString();
      if (!uri.startsWith(modelPrefix)) continue;
      if (!cellKeys.has(uri.slice(modelPrefix.length))) model.dispose();
    }
  }, [cellKeys, modelPrefix]);

  const focusList = useCallback(() => listRef.current?.focus({ preventScroll: true }), []);

  // Keep the selected cell on screen as the selection moves by keyboard.
  const selected = session?.selected ?? null;
  useEffect(() => {
    if (!selected) return;
    const node = listRef.current?.querySelector(`[data-cell="${CSS.escape(selected)}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const registerEditor = useCallback((cellKey: string, editor: MonacoEditorNS.IStandaloneCodeEditor | null) => {
    if (editor) editors.current.set(cellKey, editor);
    else editors.current.delete(cellKey);
  }, []);

  const openLink = useCallback((href: string) => {
    void openExternalUrl(href).catch((e) => pushErrorToast(String(e)));
  }, []);

  const onCellKey = useCallback(
    (cellKey: string, pressed: CellKey) => {
      const current = useNotebookStore.getState().sessions[key];
      const cell = current?.doc?.cells.find((c) => c.key === cellKey);
      if (!current || !cell) return;
      if (pressed === "save") {
        onSaveRef.current();
        return;
      }
      const isCode = cell.json.cell_type === "code";
      if (pressed === "escape") {
        notebookActions.leaveEditing(key);
        focusList();
      } else if (pressed === "runInPlace") {
        if (isCode) void notebookActions.run(key, [cellKey]);
        notebookActions.leaveEditing(key);
        focusList();
      } else if (pressed === "runAdvance") {
        if (isCode) {
          notebookActions.runAndAdvance(key, cellKey);
        } else {
          const at = current.doc!.cells.findIndex((c) => c.key === cellKey);
          const next = current.doc!.cells[at + 1];
          if (next) notebookActions.select(key, next.key, false);
          else notebookActions.insert(key, cellKey, "below", "code", true);
        }
        if (useNotebookStore.getState().sessions[key]?.editing === null) focusList();
      }
    },
    [key, focusList],
  );

  /** Command mode: the keys a selected cell answers to when no editor has the caret. */
  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!session?.doc) return;
    const target = event.target as HTMLElement;
    if (target.closest(".monaco-editor, input, textarea, select, [contenteditable='true']")) return;
    const cells = session.doc.cells;
    const at = cells.findIndex((cell) => cell.key === session.selected);
    const current = at >= 0 ? cells[at] : null;
    const mod = event.metaKey || event.ctrlKey;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Enter") {
      if (!current) return;
      handled();
      if (event.shiftKey && !mod) {
        if (current.json.cell_type === "code") notebookActions.runAndAdvance(key, current.key);
        else if (cells[at + 1]) notebookActions.select(key, cells[at + 1].key, false);
      } else if (mod && !event.shiftKey) {
        if (current.json.cell_type === "code") void notebookActions.run(key, [current.key]);
      } else if (!mod && !event.shiftKey) {
        notebookActions.select(key, current.key, true);
      }
      return;
    }
    if (mod || event.altKey) return;
    const letter = event.key.toLowerCase();
    if (event.key === "ArrowUp" || letter === "k") {
      handled();
      const prev = cells[Math.max(0, at - 1)];
      if (prev) notebookActions.select(key, prev.key, false);
    } else if (event.key === "ArrowDown" || letter === "j") {
      handled();
      const next = cells[Math.min(cells.length - 1, at + 1)];
      if (next) notebookActions.select(key, next.key, false);
    } else if (letter === "a" && !event.shiftKey) {
      handled();
      notebookActions.insert(key, current?.key ?? null, "above", "code", false);
    } else if (letter === "b" && !event.shiftKey) {
      handled();
      notebookActions.insert(key, current?.key ?? null, "below", "code", false);
    } else if (letter === "d" && !event.shiftKey && current) {
      handled();
      const now = Date.now();
      if (now - lastD.current < 600) {
        lastD.current = 0;
        notebookActions.remove(key, current.key);
      } else {
        lastD.current = now;
      }
    } else if (letter === "z" && !event.shiftKey) {
      handled();
      notebookActions.undoDelete(key);
    } else if (letter === "m" && current) {
      handled();
      notebookActions.changeType(key, current.key, "markdown");
    } else if (letter === "y" && current) {
      handled();
      notebookActions.changeType(key, current.key, "code");
    } else if (letter === "r" && current) {
      handled();
      notebookActions.changeType(key, current.key, "raw");
    }
  };

  const restart = async () => {
    const answer = await chooseAction({
      message: t("notebook.restartConfirm"),
      choices: [
        { id: "restart", label: t("notebook.restart"), variant: "primary" },
        { id: "clear", label: t("notebook.restartClear") },
      ],
    });
    if (answer === "restart" || answer === "clear") await notebookActions.restart(key, answer === "clear");
  };

  const exportScript = async () => {
    if (!doc) return;
    const base = path.replace(/\.ipynb$/i, "");
    const target = await saveDialog({ defaultPath: `${project.local_path}/${base}${scriptExtension(doc)}` }).catch(
      () => null,
    );
    if (!target) return;
    try {
      await writeFileBytes(target, new TextEncoder().encode(notebookToScript(doc)));
      pushSuccessToast(t("notebook.exported", { name: target.split(/[\\/]/).pop() ?? target }));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  // Search: the cells whose source or output holds the text, in order.
  const matches = useMemo(() => {
    const query = search.query.trim().toLowerCase();
    if (!search.open || !query || !doc) return [] as string[];
    return doc.cells
      .filter(
        (cell) =>
          cellSource(cell).toLowerCase().includes(query) ||
          cellOutputs(cell).some((output) => outputText(output).toLowerCase().includes(query)),
      )
      .map((cell) => cell.key);
  }, [search.open, search.query, doc]);

  const goToMatch = (at: number) => {
    if (matches.length === 0) return;
    const index = ((at % matches.length) + matches.length) % matches.length;
    setSearch((s) => ({ ...s, at: index }));
    const cellKey = matches[index];
    notebookActions.select(key, cellKey, false);
    const editor = editors.current.get(cellKey);
    const model = editor?.getModel();
    if (editor && model && search.query.trim()) {
      const found = model.findMatches(search.query.trim(), false, false, false, null, false)[0];
      if (found) {
        editor.setSelection(found.range);
        editor.revealRangeInCenterIfOutsideViewport(found.range);
      }
    }
  };

  const kernel = session?.kernel ?? null;
  const running = kernel && kernel.status !== "dead";
  const busy = !!session && Object.keys(session.runs).length > 0;
  const notebookDir = `${project.local_path}/${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}`.replace(/\/$/, "");
  const noKernelCandidates = session?.discovery?.withoutIpykernel ?? [];

  const toolButton = (label: string, icon: React.ReactNode, onClick: () => void, disabled = false) => (
    <Tooltip side="bottom" label={label}>
      <button onClick={onClick} disabled={disabled} aria-label={label} className={iconButtonClass({ size: "sm" })}>
        {icon}
      </button>
    </Tooltip>
  );

  if (!session) return null;

  return (
    <div className="nb-root flex h-full min-h-0 flex-col" style={ansi as React.CSSProperties}>
      <style>{ANSI_CSS}</style>
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2">
        {toolButton(t("notebook.runAll"), <ListStart size={14} />, () => void notebookActions.runAll(key), !doc)}
        {toolButton(t("notebook.interrupt"), <Square size={13} />, () => void notebookActions.interrupt(key), !running || (!busy && kernel?.status !== "busy"))}
        {toolButton(t("notebook.restart"), <RotateCcw size={13} />, () => void restart(), !kernel)}
        {toolButton(t("notebook.clearAll"), <Eraser size={14} />, () => notebookActions.clearOutputs(key), !doc)}
        <span className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
        <button
          onClick={() => notebookActions.insert(key, session.selected, "below", "code")}
          disabled={!doc}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          <Plus size={12} />
          {t("notebook.addCode")}
        </button>
        <button
          onClick={() => notebookActions.insert(key, session.selected, "below", "markdown")}
          disabled={!doc}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          <Plus size={12} />
          {t("notebook.addMarkdown")}
        </button>
        {session.deleted.length > 0 &&
          toolButton(t("notebook.undoDelete"), <Undo2 size={14} />, () => notebookActions.undoDelete(key))}
        <span className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
        {toolButton(t("notebook.ai.generate"), <AiSparkles size={13} />, () => notebookActions.openGenerate(key, session.selected), !doc)}
        {/* The engine the notebook's AI runs on, changeable right here — the same row Settings
            shows for this task. */}
        <ChatModelPicker task={NOTEBOOK_TASK} variant="tag" liveModel={null} chatActive={false} title={t("notebook.ai.modelHint")} />
        <span className="flex-1" />
        {search.open ? (
          <div className="flex items-center gap-1 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-1.5">
            <Search size={12} className="text-[var(--cf-text-muted)]" />
            <input
              autoFocus
              value={search.query}
              onChange={(event) => setSearch({ open: true, query: event.target.value, at: 0 })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  // Enter moves on from the match on screen; the first press lands on the first one.
                  const onIt = matches[search.at] === session.selected;
                  goToMatch(onIt ? search.at + (event.shiftKey ? -1 : 1) : search.at);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setSearch({ open: false, query: "", at: 0 });
                  focusList();
                }
              }}
              placeholder={t("notebook.search")}
              className="h-6 w-40 bg-transparent text-[12px] outline-none"
            />
            <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              {search.query.trim() ? `${matches.length ? search.at + 1 : 0}/${matches.length}` : ""}
            </span>
            <button onClick={() => setSearch({ open: false, query: "", at: 0 })} aria-label={t("common.close")} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={12} />
            </button>
          </div>
        ) : (
          toolButton(t("notebook.search"), <Search size={13} />, () => setSearch({ open: true, query: "", at: 0 }), !doc)
        )}
        {toolButton(t("notebook.export"), <FileDown size={14} />, () => void exportScript(), !doc)}
        <span className="ml-1" />
        <KernelPicker sessionKey={key} projectId={project.id} notebookDir={notebookDir} />
      </div>

      {(kernel?.status === "dead" && kernel.error) || session.noKernel ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-[color-mix(in_oklab,var(--cf-danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-danger)_7%,transparent)] px-3 py-2">
          <div className="min-w-0 flex-1">
            {session.noKernel ? (
              <>
                <p className="text-[12px] font-medium text-[var(--cf-danger)]">{t("notebook.noKernel")}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {noKernelCandidates.slice(0, 3).map((candidate) => (
                    <button
                      key={candidate.path}
                      onClick={() => void installIpykernel(project.id, notebookDir, candidate.path, t)}
                      title={candidate.path}
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                    >
                      {t("notebook.kernel.install", {
                        where: `${candidate.label}${candidate.version ? ` · Python ${candidate.version}` : ""}`,
                      })}
                    </button>
                  ))}
                  <button onClick={() => void notebookActions.discover(key, true)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                    {t("notebook.kernel.refresh")}
                  </button>
                </div>
              </>
            ) : (
              <pre className="m-0 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-[var(--cf-danger)]">
                {kernel?.error}
              </pre>
            )}
          </div>
          {!session.noKernel && (
            <button onClick={() => void notebookActions.restart(key, false)} className={buttonClass({ variant: "secondary", size: "sm" })}>
              {t("notebook.restart")}
            </button>
          )}
          <button
            onClick={() => notebookActions.dismissKernelError(key)}
            aria-label={t("common.close")}
            className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {!doc ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="max-w-lg select-text text-[12px] text-[var(--cf-danger)]">{session.parseError}</p>
          <button onClick={() => notebookActions.setMode(key, "json")} className={buttonClass({ variant: "secondary", size: "sm" })}>
            {t("notebook.viewJson")}
          </button>
        </div>
      ) : (
        <CellScrollRoot.Provider value={scrollRoot}>
          <div
            ref={(node) => {
              listRef.current = node;
              if (node !== scrollRoot) setScrollRoot(node);
            }}
            tabIndex={0}
            onKeyDown={onListKey}
            onMouseDown={(event) => {
              // A click on the list's own background (not in a cell) leaves edit mode.
              if (event.target === event.currentTarget) {
                notebookActions.leaveEditing(key);
                focusList();
              }
            }}
            className="min-h-0 flex-1 overflow-auto py-3 pr-4 outline-none"
          >
            {doc.cells.length === 0 && !session.generateAt && (
              <div className="flex items-center justify-center gap-2 py-10">
                <button onClick={() => notebookActions.insert(key, null, "below", "code")} className={buttonClass({ variant: "secondary", size: "sm" })}>
                  <Plus size={12} />
                  {t("notebook.addCode")}
                </button>
                <button onClick={() => notebookActions.insert(key, null, "below", "markdown")} className={buttonClass({ variant: "secondary", size: "sm" })}>
                  <Plus size={12} />
                  {t("notebook.addMarkdown")}
                </button>
                <button onClick={() => notebookActions.openGenerate(key, null)} className={buttonClass({ variant: "secondary", size: "sm" })}>
                  <AiSparkles size={12} />
                  {t("notebook.ai.generate")}
                </button>
              </div>
            )}
            {doc.cells.map((cell, index) => (
              <Fragment key={cell.key}>
                <NotebookCellView
                  sessionKey={key}
                  cell={cell}
                  index={index}
                  count={doc.cells.length}
                  selected={session.selected === cell.key}
                  editing={session.editing === cell.key}
                  run={session.runs[cell.key]}
                  input={session.input && session.input.cellKey === cell.key ? session.input : null}
                  ai={session.ai[cell.key]}
                  language={language}
                  modelPath={`${modelPrefix}${cell.key}`}
                  theme={monacoTheme}
                  palette={palette}
                  onKey={onCellKey}
                  onOpenLink={openLink}
                  registerEditor={registerEditor}
                />
                {session.generateAt?.cellKey === cell.key && (
                  <div className="pl-14">
                    <GeneratePrompt sessionKey={key} cellKey={cell.key} />
                  </div>
                )}
              </Fragment>
            ))}
            {/* An `input()` whose cell is not known (it came from a cell run before a restart of
                this view), and a generation at the end of the notebook. */}
            {session.input && !doc.cells.some((cell) => cell.key === session.input?.cellKey) && (
              <div className="pl-14 text-[12px]">
                <OrphanInput sessionKey={key} prompt={session.input.prompt} password={session.input.password} />
              </div>
            )}
            {session.generateAt?.cellKey === null && (
              <div className="pl-14">
                <GeneratePrompt sessionKey={key} cellKey={null} />
              </div>
            )}
            {session.ai[""] && (
              <div className="pl-14">
                <CellAiPanel sessionKey={key} slot="" run={session.ai[""]} currentSource="" onOpenLink={openLink} />
              </div>
            )}
            {doc.cells.length > 0 && (
              <div className="flex justify-center gap-2 pb-6 pl-14 pt-2 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100">
                <button onClick={() => notebookActions.insert(key, null, "below", "code")} className={buttonClass({ variant: "ghost", size: "sm" })}>
                  <Plus size={12} />
                  {t("notebook.addCode")}
                </button>
                <button onClick={() => notebookActions.insert(key, null, "below", "markdown")} className={buttonClass({ variant: "ghost", size: "sm" })}>
                  <Plus size={12} />
                  {t("notebook.addMarkdown")}
                </button>
              </div>
            )}
          </div>
        </CellScrollRoot.Provider>
      )}
    </div>
  );
}

function OrphanInput({ sessionKey, prompt, password }: { sessionKey: string; prompt: string; password: boolean }) {
  const t = useT();
  const [value, setValue] = useState("");
  return (
    <form
      className="my-1.5 flex items-center gap-2 rounded-md border border-[var(--cf-accent)] bg-[var(--cf-field)] px-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        void notebookActions.answerInput(sessionKey, value);
      }}
    >
      <span className="shrink-0 font-mono text-[var(--cf-text-muted)]">{prompt || "›"}</span>
      <input
        autoFocus
        type={password ? "password" : "text"}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={t("notebook.inputLabel")}
        className="min-w-0 flex-1 bg-transparent font-mono outline-none"
      />
    </form>
  );
}
