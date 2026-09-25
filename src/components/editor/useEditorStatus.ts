import { useEffect, useMemo } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { useEditorStatusStore, type EditorStatusActions } from "../../state/editorStatusStore";

/** Display names by language id — `getLanguages()` is a list, and this is read on every caret move. */
const languageNames = new Map<string, string>();

function languageNameOf(monaco: Monaco, id: string): string {
  const cached = languageNames.get(id);
  if (cached !== undefined) return cached;
  const entry = (monaco.languages.getLanguages() as { id: string; aliases?: string[] }[]).find(
    (language) => language.id === id,
  );
  const name = entry?.aliases?.[0] ?? id;
  languageNames.set(id, name);
  return name;
}

/**
 * Publishes this pane's file to the Editor's status line while the pane has focus, and hands the
 * line a way to act on it. See `editorStatusStore`.
 *
 * `path` is `null` whenever Monaco is not what the pane is showing — a file still loading, preview or
 * diff mode — and the slot is then released, so the line never describes an editor that is not on
 * screen. Everything is read from Monaco itself rather than from React state: the model's options
 * and end of line are Monaco's (indentation is guessed from the file when it opens), and the caret
 * moves without React hearing about it.
 */
export function useEditorStatus(
  editor: MonacoEditorNS.IStandaloneCodeEditor | null,
  monaco: Monaco | null,
  {
    groupId,
    focused,
    path,
    fileKey,
  }: { groupId: string; focused: boolean; path: string | null; fileKey: string | null },
): void {
  const actions = useMemo<EditorStatusActions | null>(() => {
    if (!editor || !monaco) return null;
    return {
      goToLine: () => {
        editor.focus();
        editor.trigger("status-line", "editor.action.gotoLine", null);
      },
      // `pushEOL`, not `setEOL`: it goes on the undo stack, so ⌘Z takes the conversion back. The
      // content event it fires is what marks the tab dirty — `getValue()` joins with the new ending,
      // so the save writes it.
      setEol: (eol) => {
        const model = editor.getModel();
        if (!model) return;
        model.pushEOL(eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        editor.focus();
      },
      setIndentation: (insertSpaces, tabSize) => {
        editor.getModel()?.updateOptions({ insertSpaces, tabSize, indentSize: tabSize });
        editor.focus();
      },
      detectIndentation: () => {
        const model = editor.getModel();
        if (!model) return;
        const options = model.getOptions();
        model.detectIndentation(options.insertSpaces, options.tabSize);
        editor.focus();
      },
      convertIndentation: (toSpaces) => {
        editor.focus();
        editor.trigger(
          "status-line",
          toSpaces ? "editor.action.indentationToSpaces" : "editor.action.indentationToTabs",
          null,
        );
      },
    };
  }, [editor, monaco]);

  useEffect(() => {
    if (!focused || !editor || !monaco || !actions || !path || !fileKey) {
      useEditorStatusStore.getState().clear(groupId);
      return;
    }
    const publish = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) {
        useEditorStatusStore.getState().clear(groupId);
        return;
      }
      const selections = editor.getSelections() ?? [];
      const selected = selections.reduce((sum, selection) => sum + model.getValueLengthInRange(selection), 0);
      const options = model.getOptions();
      const languageId = model.getLanguageId();
      useEditorStatusStore.getState().publish(
        {
          groupId,
          path,
          fileKey,
          line: position.lineNumber,
          column: position.column,
          selected,
          cursors: Math.max(selections.length, 1),
          tabSize: options.tabSize,
          insertSpaces: options.insertSpaces,
          eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
          languageId,
          languageName: languageNameOf(monaco, languageId),
        },
        actions,
      );
    };
    publish();
    const subscriptions = [
      editor.onDidChangeCursorSelection(publish),
      editor.onDidChangeModel(publish),
      editor.onDidChangeModelOptions(publish),
      editor.onDidChangeModelLanguage(publish),
      // An end-of-line change moves no caret; this is the event that carries it.
      editor.onDidChangeModelContent(publish),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      useEditorStatusStore.getState().clear(groupId);
    };
  }, [editor, monaco, actions, focused, groupId, path, fileKey]);
}
