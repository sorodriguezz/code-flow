import { useEffect, useRef, type MutableRefObject } from "react";
import type { Monaco } from "@monaco-editor/react";
import type * as MonacoEditorNS from "monaco-editor";
import { normalizePath, useDebugStore, type Breakpoint } from "../../state/debugStore";
import { promptAction } from "../../state/promptStore";
import { translate } from "../../state/languageStore";

/** The glyph a breakpoint wears: a dot, a dot with a centre for a condition, a diamond for a logpoint,
 *  hollow when it is switched off. */
export function breakpointGlyphClass(bp: Breakpoint): string {
  return [
    "cf-breakpoint-glyph",
    bp.logMessage ? "cf-breakpoint-log" : bp.condition ? "cf-breakpoint-conditional" : "",
    bp.enabled ? "" : "cf-breakpoint-disabled",
  ]
    .filter(Boolean)
    .join(" ");
}

function hoverFor(bp: Breakpoint): MonacoEditorNS.IMarkdownString[] | undefined {
  const lines = [
    bp.condition ? translate("debug.hoverCondition", { value: bp.condition }) : null,
    bp.logMessage ? translate("debug.hoverLog", { value: bp.logMessage }) : null,
    bp.enabled ? null : translate("debug.hoverDisabled"),
  ].filter((line): line is string => line !== null);
  return lines.length ? lines.map((value) => ({ value, isTrusted: false, supportHtml: false })) : undefined;
}

/**
 * Asks for a breakpoint's condition or log message, and sets it — adding the breakpoint when the line
 * has none. Clearing the field on a breakpoint with nothing else to it takes it away entirely.
 */
export async function promptBreakpoint(file: string, line: number, kind: "condition" | "logMessage"): Promise<void> {
  const existing = useDebugStore.getState().breakpointsFor(file).find((bp) => bp.line === line);
  const answer = await promptAction(translate(kind === "condition" ? "debug.conditionPrompt" : "debug.logPrompt", { line }), {
    initial: existing?.[kind] ?? "",
    placeholder: kind === "condition" ? "i > 3" : "total = {total}",
    confirmLabel: translate("common.save"),
  });
  if (answer === null) return;
  const other = kind === "condition" ? existing?.logMessage : existing?.condition;
  if (!answer) {
    if (existing && !other) useDebugStore.getState().removeBreakpoint(file, line);
    else if (existing) useDebugStore.getState().setBreakpoint(file, line, { [kind]: "" });
    return;
  }
  useDebugStore.getState().setBreakpoint(file, line, { [kind]: answer, enabled: true });
}

/**
 * Whether a content change replaced the whole buffer — a reload from disk, a `setValue`, the value
 * prop of `@monaco-editor/react` catching up with the file. That collapses every decoration onto one
 * edge, which is not the code moving: the stored lines are still right and are simply drawn again.
 */
export function replacedWholesale(event: MonacoEditorNS.editor.IModelContentChangedEvent, previousLength: number): boolean {
  return event.isFlush || event.changes.some((change) => change.rangeOffset === 0 && change.rangeLength === previousLength && previousLength > 0);
}

/**
 * The breakpoint gutter of one editor pane, and the line the program is stopped on.
 *
 * **Breakpoints follow the code.** Each is a decoration over its whole line with
 * `NeverGrowsWhenTypingAtEdges`, so Monaco carries it with the text: a line inserted above pushes it
 * down, Enter at the start of its line takes it along, and joining its line into the one above lifts
 * it — VS Code's behaviour. Every edit reads the decorations back and moves the stored lines to
 * match, which is what keeps a breakpoint on `return total` rather than on whatever line 12 has
 * become. They used to be plain line numbers re-drawn from the store, so they stayed put while the
 * code slid out from under them.
 *
 * A separate decoration set from the git markers, bookmarks and anchors, for the reason those give:
 * they change on different rhythms, and one shared id list would make each update clobber the rest.
 */
export function useBreakpointGutter(
  editorRef: MutableRefObject<MonacoEditorNS.editor.IStandaloneCodeEditor | null>,
  monacoRef: MutableRefObject<Monaco | null>,
  /** The open file's absolute path, slash-normalized — the store's key. */
  file: string | null,
  /** Bumped when the editor instance is (re)created. */
  editorReady: number,
  loading: boolean | undefined,
) {
  const breakpoints = useDebugStore((s) => (file ? s.breakpoints[file] : undefined));
  const pausedFrame = useDebugStore((s) => (s.status === "paused" ? s.frames[s.selectedFrame] : undefined));
  const decorationsRef = useRef<string[]>([]);
  /** Which stored line each breakpoint decoration stands for — what an edit is measured against. */
  const placedRef = useRef<Array<{ id: string; line: number }>>([]);
  const fileRef = useRef(file);
  fileRef.current = file;
  const pausedRef = useRef(pausedFrame);
  pausedRef.current = pausedFrame;

  const render = () => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !mon || !model) return;
    const current = fileRef.current;
    const lineCount = model.getLineCount();
    const list = (current ? (useDebugStore.getState().breakpoints[current] ?? []) : []).filter((bp) => bp.line <= lineCount);
    const decorations: MonacoEditorNS.editor.IModelDeltaDecoration[] = list.map((bp) => ({
      range: new mon.Range(bp.line, 1, bp.line, model.getLineMaxColumn(bp.line)),
      options: {
        glyphMarginClassName: breakpointGlyphClass(bp),
        glyphMarginHoverMessage: hoverFor(bp),
        stickiness: mon.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
    // Only when the *selected* frame is this file: stepping through a call shows where you are,
    // not a stale highlight in a file you happen to have open.
    const paused = pausedRef.current;
    if (paused && current && normalizePath(paused.file) === current && paused.line <= lineCount) {
      decorations.push({
        range: new mon.Range(paused.line, 1, paused.line, 1),
        options: {
          isWholeLine: true,
          className: "cf-debug-current-line",
          glyphMarginClassName: "cf-debug-current-glyph",
        },
      });
    }
    const ids = ed.deltaDecorations(decorationsRef.current, decorations);
    decorationsRef.current = ids;
    placedRef.current = list.map((bp, index) => ({ id: ids[index], line: bp.line }));
  };
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    renderRef.current();
  }, [breakpoints, file, pausedFrame, editorReady, loading]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    let length = ed.getModel()?.getValueLength() ?? 0;
    const modelChange = ed.onDidChangeModel(() => {
      length = ed.getModel()?.getValueLength() ?? 0;
    });
    const contentChange = ed.onDidChangeModelContent((event) => {
      const model = ed.getModel();
      const previous = length;
      length = model?.getValueLength() ?? 0;
      const current = fileRef.current;
      if (!model || !current || placedRef.current.length === 0) return;
      if (replacedWholesale(event, previous)) {
        renderRef.current();
        return;
      }
      // Every breakpoint drawn, moved or not: the store tells a report it has already applied (a
      // second pane on the same file) by its starting lines.
      const moves: Array<[number, number]> = [];
      let moved = false;
      // Enter in the middle of a breakpoint's line leaves its decoration over two lines, and Monaco
      // draws a glyph on every line a decoration covers — so it is drawn again, on its first line.
      let stretched = false;
      for (const { id, line } of placedRef.current) {
        const range = model.getDecorationRange(id);
        const to = range?.startLineNumber ?? line;
        moves.push([line, to]);
        if (to !== line) moved = true;
        if (range && range.endLineNumber !== range.startLineNumber) stretched = true;
      }
      if (moved) useDebugStore.getState().moveBreakpoints(current, moves);
      else if (stretched) renderRef.current();
    });

    // Conditions and logpoints from the editor's own context menu, on the caret's line.
    const edit = (kind: "condition" | "logMessage") => {
      const current = fileRef.current;
      const line = ed.getPosition()?.lineNumber;
      if (current && line) void promptBreakpoint(current, line, kind);
    };
    const actions = [
      ed.addAction({
        id: "codeflow.debug.conditionalBreakpoint",
        label: translate("debug.editCondition"),
        contextMenuGroupId: "codeflow-debug",
        contextMenuOrder: 1,
        run: () => edit("condition"),
      }),
      ed.addAction({
        id: "codeflow.debug.logpoint",
        label: translate("debug.editLogpoint"),
        contextMenuGroupId: "codeflow-debug",
        contextMenuOrder: 2,
        run: () => edit("logMessage"),
      }),
    ];
    return () => {
      modelChange.dispose();
      contentChange.dispose();
      actions.forEach((action) => action.dispose());
    };
    // Once per editor instance: everything it reads goes through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorReady]);
}
