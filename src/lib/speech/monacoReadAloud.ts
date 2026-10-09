import type * as Monaco from "monaco-editor";
import { useSpeechStore } from "../../state/speechStore";
import { speakNow } from "./speakAnswer";

/**
 * «Leer en voz alta» in a Monaco editor's right-click menu, beside Copy: the selection, said by the
 * thinking mark. Shown only with something selected and while «Leer la selección» is on (Settings ›
 * Voz y sonido › Lectura en voz alta) — a context key follows the setting for as long as the editor
 * lives.
 */
export function addReadAloudAction(editor: Monaco.editor.IStandaloneCodeEditor, label: string): void {
  const enabled = editor.createContextKey<boolean>("cfReadAloud", useSpeechStore.getState().readSelection);
  const unsubscribe = useSpeechStore.subscribe((state) => enabled.set(state.readSelection));
  editor.addAction({
    id: "cf-read-aloud",
    label,
    contextMenuGroupId: "9_cutcopypaste",
    contextMenuOrder: 5,
    precondition: "editorHasSelection && cfReadAloud",
    run: (ed) => {
      const selection = ed.getSelection();
      const text = selection ? (ed.getModel()?.getValueInRange(selection) ?? "") : "";
      if (text.trim()) speakNow(text, "selection");
    },
  });
  editor.onDidDispose(unsubscribe);
}
