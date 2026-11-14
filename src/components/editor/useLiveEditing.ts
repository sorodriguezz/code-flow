import { useEffect } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { attachLive } from "../../lib/collabLive/registry";
import { modelPathFor } from "../../lib/editorModel";
import { useLiveStore } from "../../state/liveStore";
import type { Project } from "../../types/domain";

/**
 * Live editing of a shared session's file (`lib/collabLive`): while this pane shows a text file of a
 * session project («api · sesión»), its model is bound to the file's shared document, and the other
 * people's cursors are drawn in it. Anywhere else this does nothing.
 *
 * Gated on `editorReady` like the pane's other Monaco hooks; re-checked when a session starts or
 * ends (`targets`), since a session project can appear while the file is already open.
 */
export function useLiveEditing(
  editor: MonacoEditorNS.IStandaloneCodeEditor | null,
  monaco: Monaco | null,
  project: Project | null | undefined,
  path: string | null,
  enabled: boolean,
): void {
  const targets = useLiveStore((s) => s.targets);
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!editor || !monaco || !project || !path || !enabled) return;
    const expected = monaco.Uri.parse(modelPathFor(project, path)).toString();
    let detach: (() => void) | null = null;
    const bind = () => {
      detach?.();
      detach = null;
      const model = editor.getModel();
      if (model && model.uri.toString() === expected) detach = attachLive(project.id, path, model, editor);
    };
    bind();
    // The model this component asked for may arrive a moment after the path did.
    const swapped = editor.onDidChangeModel(bind);
    return () => {
      swapped.dispose();
      detach?.();
    };
    // `project` is read through its id: a new object for the same project must not rebind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, monaco, projectId, path, enabled, targets]);
}
