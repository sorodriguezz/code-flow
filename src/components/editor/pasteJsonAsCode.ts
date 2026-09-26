import type { Monaco } from "@monaco-editor/react";
import type { IRange, editor as MonacoEditorNS } from "monaco-editor";
import { FALLBACK_LANGUAGE, isTypeName, targetFor } from "../../lib/pasteJson/targets";
import { confirmAction } from "../../state/confirmStore";
import { translate } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast } from "../../state/toastStore";

/**
 * "Paste JSON as Code": the JSON on the clipboard, written at the caret as types for the file's
 * language — VS Code's quicktype extension, down to its ⌘⇧V. What gets written, per language, is
 * `lib/pasteJson/targets.ts`; how it is fitted into the file is `lib/pasteJson/shape.ts`.
 *
 * One Monaco action (`PASTE_JSON_ACTION`) is the only way in. The right-click menu, the chord (the
 * shortcut registry dispatches it — see `editor.pasteJsonAsCode`) and the command palette all
 * trigger that action, so there is one path to keep right.
 */
export const PASTE_JSON_ACTION = "cf-paste-json";

/** The type name the prompt opens on, selected so typing replaces it. */
const DEFAULT_NAME = "Root";

type CodeEditor = MonacoEditorNS.ICodeEditor;

/** A language's display name — "C++" rather than "cpp" — for saying which one is not supported. */
function languageName(monaco: Monaco, id: string): string {
  const entry = (monaco.languages.getLanguages() as { id: string; aliases?: string[] }[]).find(
    (language) => language.id === id,
  );
  return entry?.aliases?.[0] ?? id;
}

/** The edit that puts `lines` after line `after` of the model (0 = above the first). */
function linesAfter(model: MonacoEditorNS.ITextModel, after: number, lines: string[]): MonacoEditorNS.IIdentifiedSingleEditOperation {
  const text = lines.join("\n");
  const count = model.getLineCount();
  if (after < count) {
    const line = after + 1;
    return { range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, text: `${text}\n` };
  }
  const column = model.getLineMaxColumn(count);
  return { range: { startLineNumber: count, startColumn: column, endLineNumber: count, endColumn: column }, text: `\n${text}` };
}

/**
 * Runs the whole thing on `editor`: clipboard, checks, the name, generation, one undoable edit.
 *
 * `path` is the file's path in the repository — Java and Kotlin take a package from it, and Java the
 * name of the one type allowed to stay public.
 */
export async function pasteJsonAsCode(editor: CodeEditor, monaco: Monaco, path: string): Promise<void> {
  const model = editor.getModel();
  if (!model) return;

  // First, and before any `await`: WebKit only lets a page read the clipboard from inside the click
  // or keystroke that asked for it (and on macOS may show its own "Paste" button for it), and a
  // gesture does not survive being awaited past. Everything after this can take its time.
  const clipboard = navigator.clipboard?.readText() ?? Promise.reject(new Error("no clipboard"));
  // Fetched while the prompt below is open, so the chunk has usually landed by the time it is needed.
  // The failure, if any, is reported where it is awaited.
  const engine = import("../../lib/pasteJson/generate");
  engine.catch(() => {});

  const giveUp = (message?: string) => {
    if (message) pushErrorToast(message);
    editor.focus();
  };

  let text: string;
  try {
    text = await clipboard;
  } catch {
    return giveUp(translate("pasteJson.clipboardFailed"));
  }
  const json = text.replace(/^\uFEFF/, "").trim();
  if (!json) return giveUp(translate("pasteJson.emptyClipboard"));
  try {
    JSON.parse(json);
  } catch (e) {
    return giveUp(translate("pasteJson.notJson", { reason: e instanceof Error ? e.message : String(e) }));
  }

  let target = targetFor(model.getLanguageId());
  if (!target) {
    const agreed = await confirmAction(
      translate("pasteJson.unsupported", { language: languageName(monaco, model.getLanguageId()) }),
      false,
      translate("pasteJson.useTypeScript"),
    );
    if (!agreed) return giveUp();
    target = targetFor(FALLBACK_LANGUAGE);
    if (!target) return giveUp();
  }

  const name = await promptAction(translate("pasteJson.namePrompt"), {
    initial: DEFAULT_NAME,
    confirmLabel: translate("pasteJson.insert"),
    validate: (value) => (isTypeName(value) ? null : translate("pasteJson.badName")),
  });
  if (name === null) return giveUp();

  const options = model.getOptions();
  let generated: string;
  let engineModule: Awaited<typeof engine>;
  try {
    engineModule = await engine;
    generated = await engineModule.renderJsonAsCode({
      json,
      name,
      target,
      indentation: options.insertSpaces ? " ".repeat(options.tabSize) : "\t",
      fileName: path.split(/[\\/]/).pop() ?? "",
    });
  } catch (e) {
    return giveUp(translate("pasteJson.failed", { error: e instanceof Error ? e.message : String(e) }));
  }
  if (!generated) return giveUp(translate("pasteJson.nothing"));

  // Two dialogs and a chunk load stood between the keystroke and here. Writing to a model this editor
  // no longer shows would change a buffer behind the tab's back — the tab's own copy of the text
  // only follows the model a mounted editor reports — so a file that left the screen gets nothing.
  if (model.isDisposed() || editor.getModel() !== model) return giveUp(translate("pasteJson.fileGone"));
  const selection = editor.getSelection();
  if (!selection) return giveUp();

  try {
    const { header, body } = engineModule.placeGenerated(generated, {
      dialect: target.dialect,
      text: model.getValue(),
      line: selection.startLineNumber,
      before: model.getValueInRange({
        startLineNumber: selection.startLineNumber,
        startColumn: 1,
        endLineNumber: selection.startLineNumber,
        endColumn: selection.startColumn,
      }),
      path,
    });
    const edits: MonacoEditorNS.IIdentifiedSingleEditOperation[] = [];
    // Above the selection by construction (see `placeGenerated`), so the two never overlap.
    if (header) edits.push(linesAfter(model, header.after, header.lines));
    edits.push({ range: selection, text: body, forceMoveMarkers: true });
    // Stops on both sides, so ⌘Z takes the paste — imports and all — back in one press, and typing
    // on either side of it stays its own step.
    editor.pushUndoStop();
    editor.executeEdits("paste-json-as-code", edits, (inverse) => {
      // The caret goes after the declarations: the inserted range that ends last is theirs.
      const last = inverse.reduce<IRange | null>(
        (latest, { range }) =>
          !latest ||
          range.endLineNumber > latest.endLineNumber ||
          (range.endLineNumber === latest.endLineNumber && range.endColumn > latest.endColumn)
            ? range
            : latest,
        null,
      );
      return last ? [new monaco.Selection(last.endLineNumber, last.endColumn, last.endLineNumber, last.endColumn)] : null;
    });
    editor.pushUndoStop();
    const caret = editor.getPosition();
    if (caret) editor.revealPosition(caret);
    editor.focus();
  } catch (e) {
    giveUp(translate("pasteJson.failed", { error: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * The focused pane's editor, for the command palette.
 *
 * The palette is outside the Editor and has no idea which of its panes the user was in, while every
 * pane knows whether it is the focused one — the same arrangement `registerCapture` uses for the
 * snapshot. A getter rather than the editor itself, because the pane's editor is remounted whenever
 * the file on it changes and the getter always reads the current one. Module state is per window,
 * and so is the palette.
 */
let focusedEditor: (() => CodeEditor | null) | null = null;

/** Called by the focused pane. Returns the way to take the offer back when it stops being focused. */
export function offerPasteTarget(get: () => CodeEditor | null): () => void {
  focusedEditor = get;
  return () => {
    if (focusedEditor === get) focusedEditor = null;
  };
}

/** Whether there is a file on screen to paste into — the palette lists the command only then. */
export function canPasteJsonHere(): boolean {
  return Boolean(focusedEditor?.()?.getModel());
}

/**
 * Runs the action in the focused pane, synchronously — the palette calls this from its own click
 * or Enter, which is the gesture the clipboard read above needs to happen inside.
 */
export function pasteJsonInFocusedEditor(): void {
  const editor = focusedEditor?.();
  if (editor?.getModel()) editor.trigger("command-palette", PASTE_JSON_ACTION, null);
}
