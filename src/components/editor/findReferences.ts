import * as monaco from "monaco-editor";
import { readEditorFile } from "../../lib/tauri/commands";
import { modelPathForId } from "../../lib/editorModel";
import { lineText } from "../../lib/workspaceEdit";
import { groupHits, useEditorPanelStore } from "../../state/editorPanelStore";
import { pushErrorToast } from "../../state/toastStore";
import { translate } from "../../state/languageStore";
import { tsImplementations, tsReferences } from "./useTypeScript";
import { lspImplementations, lspReferences } from "./useLanguageServer";

/**
 * "Find All References": every use of the symbol under the caret, across the project, listed in
 * the panel under the editor with the text of each line.
 *
 * A list rather than Monaco's peek because the peek can only preview a file that has a model — in
 * standalone Monaco, a reference in a file nobody has open shows as a file name over an empty row.
 * The compiler answers for the files it holds (tsserver's `references` brings each line's text
 * along); the language servers answer for the rest, and their lines are read from the open buffer
 * or, for a file with no tab, from disk.
 */

/** Past this many files a language server's answer is listed without each line's text: reading
 *  them all to decorate a list would cost more than the list is worth. */
const MAX_FILES_READ = 150;

interface Hit {
  path: string;
  range: monaco.IRange;
  text?: string;
}

export async function findAllReferences(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  project: { id: string; local_path: string },
): Promise<void> {
  let symbol = model.getWordAtPosition(position)?.word ?? "";
  let hits: Hit[];
  const fromCompiler = await tsReferences(model, position);
  if (fromCompiler) {
    symbol = fromCompiler.symbol || symbol;
    hits = fromCompiler.hits;
  } else {
    const fromServers = await lspReferences(model, position);
    if (!fromServers) {
      pushErrorToast(translate("editor.referencesUnavailable"));
      return;
    }
    hits = await withLineText(fromServers, project);
  }
  const unique = new Map<string, Hit>();
  for (const hit of hits) unique.set(`${hit.path}:${hit.range.startLineNumber}:${hit.range.startColumn}`, hit);
  useEditorPanelStore.getState().showResults({
    title: translate("editor.referencesTitle", { n: unique.size, name: symbol }),
    groups: groupHits([...unique.values()]),
    notes: [],
  });
}

/**
 * "Find All Implementations": every class that implements the interface under the caret, every
 * override of the method — the whole list "Go to Implementations" jumps to the first of, in the
 * same panel and for the same reason as the references above.
 *
 * Neither tsserver's answer nor a server's carries the line's text, so both are read the way the
 * language servers' references are.
 */
export async function findAllImplementations(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  project: { id: string; local_path: string },
): Promise<void> {
  const symbol = model.getWordAtPosition(position)?.word ?? "";
  const found = (await tsImplementations(model, position)) ?? (await lspImplementations(model, position));
  if (!found) {
    pushErrorToast(translate("editor.implementationsUnavailable"));
    return;
  }
  const hits = await withLineText(found, project);
  const unique = new Map<string, Hit>();
  for (const hit of hits) unique.set(`${hit.path}:${hit.range.startLineNumber}:${hit.range.startColumn}`, hit);
  useEditorPanelStore.getState().showResults({
    title: translate("editor.implementationsTitle", { n: unique.size, name: symbol }),
    groups: groupHits([...unique.values()]),
    notes: [],
  });
}

/** Each hit's line, from the file's model when it has one — the buffer, which is what the server
 *  answered about — and from disk otherwise. */
async function withLineText(hits: Hit[], project: { id: string; local_path: string }): Promise<Hit[]> {
  const texts = new Map<string, string | null>();
  for (const path of new Set(hits.map((hit) => hit.path))) {
    const model = monaco.editor.getModel(monaco.Uri.parse(modelPathForId(project.id, path)));
    if (model) {
      texts.set(path, model.getValue());
    } else if (texts.size < MAX_FILES_READ) {
      const file = await readEditorFile(project.local_path, path).catch(() => null);
      texts.set(path, file && (file.kind === "text" || file.kind === "legacy") ? file.text : null);
    }
  }
  return hits.map((hit) => {
    const text = texts.get(hit.path);
    return text ? { ...hit, text: lineText(text, hit.range.startLineNumber) } : hit;
  });
}
