import type { editor } from "monaco-editor";
import { recallViewState, rememberViewState } from "./editorMemory";
import { MODEL_SCHEME } from "./editorModel";

/**
 * Keeps each file's caret, selection, scroll and folds across everything that takes the editor
 * away from it — a tab switch, a repository or workspace switch, a restart — and puts them back
 * when the file is shown again (user report, 2026-11-12: every file came back on line 1).
 *
 * `@monaco-editor/react` already does this between tabs, but only inside one mounted editor: its
 * map lives in a ref, so a repository switch (which reads every tab back from disk and remounts the
 * editor on it), a workspace switch (which unmounts the whole view) or a quit throws it away. This
 * one lives in `lib/editorMemory`, which outlives all three.
 *
 * Saved as the user moves — on caret and scroll changes, at most once a frame — rather than when the
 * file is left, because "left" is not always an event this side sees: an unmount gives Monaco no
 * chance to answer `saveViewState()` with anything but the model it is already letting go of.
 *
 * The frame of delay is also what keeps a model switch from overwriting what it is about to
 * restore: `setModel` fires its own caret and scroll events for the new model at line 1, and by the
 * time the frame comes round the restore below has already put the remembered state in place, so
 * that is what gets saved.
 *
 * Restoring happens on mount and on every model change, both before any jump the pane was asked for
 * (a search hit, a change from the Changes list): those run in `EditorPane`'s effects, after this,
 * and so win — a reveal is a more recent wish than where the file was left.
 *
 * Only for the editor's own models (`lib/editorModel`): a diff's or a scratch's are not files that
 * come back.
 */
export function followViewState(ed: editor.IStandaloneCodeEditor) {
  const keyOf = () => {
    const model = ed.getModel();
    return model && model.uri.scheme === MODEL_SCHEME ? model.uri.toString() : null;
  };

  const restore = () => {
    const key = keyOf();
    const state = key ? recallViewState(key) : undefined;
    if (state) ed.restoreViewState(state as editor.ICodeEditorViewState);
  };

  let frame: number | null = null;
  const save = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const key = keyOf();
      if (key) rememberViewState(key, ed.saveViewState());
    });
  };

  restore();
  ed.onDidChangeModel(restore);
  ed.onDidChangeCursorSelection(save);
  ed.onDidScrollChange(save);
  ed.onDidDispose(() => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  });
}
