import { useEffect, useRef } from "react";
import { DiffEditor as MonacoDiffEditor, type DiffEditorProps, type DiffOnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

/**
 * `@monaco-editor/react`'s `DiffEditor`, unmounted in the right order.
 *
 * The library disposes both text models *before* the diff widget, and the widget then throws
 * "TextModel got disposed before DiffEditorWidget model got reset" from its model listener (user
 * log, 2026-11-02, closing a response comparison). Here the library keeps the models and this frees
 * them a task later — after the widget is gone, whichever effect cleanup React runs first.
 *
 * Same props; import it instead of the library's for every diff view.
 */
export function DiffEditor({ onMount, ...props }: DiffEditorProps) {
  const models = useRef<editor.IDiffEditorModel | null>(null);
  const mounted: DiffOnMount = (diff, monaco) => {
    models.current = diff.getModel();
    // A model swap (`original`/`modified` paths) leaves the old pair to be freed too.
    diff.onDidChangeModel(() => {
      const previous = models.current;
      models.current = diff.getModel();
      if (previous) freeLater(previous, models.current);
    });
    onMount?.(diff, monaco);
  };
  useEffect(
    () => () => {
      if (models.current) freeLater(models.current, null);
      models.current = null;
    },
    [],
  );
  return <MonacoDiffEditor {...props} keepCurrentOriginalModel keepCurrentModifiedModel onMount={mounted} />;
}

export type { DiffOnMount };

function freeLater(pair: editor.IDiffEditorModel, kept: editor.IDiffEditorModel | null): void {
  setTimeout(() => {
    for (const model of [pair.original, pair.modified]) {
      if (model === kept?.original || model === kept?.modified || model.isDisposed()) continue;
      model.dispose();
    }
  }, 0);
}
