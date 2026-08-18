import { useEffect, useRef } from "react";
import type { editor as MonacoEditorNS, IDisposable, languages, Position } from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import {
  TS_LANGUAGES,
  partsToText,
  scriptKind,
  tsNotify,
  tsRequest,
  tsStart,
  type TsCompletionDetail,
  type TsCompletionInfo,
  type TsDefinitionInfo,
  type TsQuickInfo,
} from "../../lib/tsserver";
import { relPathFromModelUri } from "../../lib/editorModel";

/**
 * Real TypeScript IntelliSense in the editor, from the project's own `tsserver`.
 *
 * # What this replaces
 *
 * Nothing — there was none. Monaco on its own knows the buffer in front of it, which is why a
 * freshly installed library completed to nothing and why no member of any imported type was ever
 * offered. The compiler is the only thing that can answer either question, and it answers both with
 * the same three providers below.
 *
 * # The file is told to the server, and kept told
 *
 * `open` hands tsserver the buffer's *current* text rather than pointing it at the path, so an
 * unsaved edit is analysed as typed — the difference between completions that follow your cursor and
 * completions that describe the file as it was last written to disk. Every subsequent edit is a
 * `change` covering the whole file: tsserver takes incremental spans, and computing them from
 * Monaco's change events is real work whose only payoff is on files far larger than a source file
 * gets. The full text of a module is kilobytes and the call is a notification, so it costs a copy.
 *
 * # Auto-import is a code action, not an insert
 *
 * Accepting `useEffect` in a file that has not imported it must write the import line too, and that
 * edit arrives from `completionEntryDetails` as a `codeAction` — a set of text changes elsewhere in
 * the file. `additionalTextEdits` is Monaco's slot for exactly that, so resolving a completion is
 * where the import gets attached. Without it the feature completes the name and leaves the file
 * broken, which is worse than not completing at all.
 *
 * # Diagnostics are deliberately not wired
 *
 * `geterr` answers asynchronously through events, and the reader in `tsserver.rs` drops events
 * today. Red squiggles are a bigger surface than completion — they need debouncing against typing,
 * a per-file lifetime, and a decision about whether the editor is allowed to disagree with the
 * user's own build. Left for its own pass rather than half-built here.
 */

interface Options {
  /** Absolute path of the repository — what the server is started for. */
  repoPath: string | null;
  /** The open project's id. Needed to read a model's URI: this app addresses models as
   *  `codeflow:/<projectId>/<relPath>`, not by their path on disk. */
  projectId: string;
  /** Repo-relative path of the file on screen. */
  activePath: string | null;
}

/** tsserver wants absolute, native-looking paths. */
const absolute = (repoPath: string, path: string) => `${repoPath}/${path}`.replace(/\\/g, "/");

export function useTypeScript(
  editor: MonacoEditorNS.IStandaloneCodeEditor | null,
  monaco: Monaco | null,
  { repoPath, projectId, activePath }: Options,
) {
  /** Files this session has told the server about, so `open` is sent once and `change` after. */
  const opened = useRef<Set<string>>(new Set());
  /** Whether the server came up. Providers stay registered either way — they simply return nothing
   *  — so a project without TypeScript installed behaves exactly as it did before. */
  const running = useRef(false);

  // One server per repository, started when a file that needs it is first shown.
  useEffect(() => {
    if (!repoPath || !activePath || !scriptKind(activePath)) return;
    let alive = true;
    void tsStart(repoPath)
      .then(() => {
        if (!alive) return;
        running.current = true;
        // A restart invalidates every `open` the previous server was told about.
        opened.current = new Set();
      })
      .catch(() => {
        // No TypeScript in the project. Not an error to surface: it is the ordinary state of a repo
        // that is not a TypeScript project, and a toast on every file opened would be noise.
        running.current = false;
      });
    return () => {
      alive = false;
    };
  }, [repoPath, activePath]);

  // Keep the server's copy of the open file in step with the buffer.
  useEffect(() => {
    if (!editor || !monaco || !repoPath || !activePath) return;
    const kind = scriptKind(activePath);
    if (!kind) return;
    const model = editor.getModel();
    if (!model) return;

    const file = absolute(repoPath, activePath);
    let disposed = false;

    const send = () => {
      if (!running.current || disposed) return;
      if (opened.current.has(file)) {
        void tsNotify("change", {
          file,
          line: 1,
          offset: 1,
          endLine: model.getLineCount() + 1,
          endOffset: 1,
          insertString: model.getValue(),
        }).catch(() => undefined);
      } else {
        opened.current.add(file);
        void tsNotify("open", {
          file,
          fileContent: model.getValue(),
          scriptKindName: kind,
          // The project the file belongs to. Left to tsserver to work out from the path, which is
          // what makes `tsconfig.json`, `paths` and project references apply — the whole reason
          // this is a real server rather than a worker fed a pile of `.d.ts`.
        }).catch(() => undefined);
      }
    };

    // The first send may race the start above; a short retry covers the cold-start case without a
    // subscription, and every later edit goes through the change listener.
    send();
    const retry = setTimeout(send, 400);
    const changed = model.onDidChangeContent(() => send());

    return () => {
      disposed = true;
      clearTimeout(retry);
      changed.dispose();
    };
  }, [editor, monaco, repoPath, activePath]);

  // The providers. Registered once per Monaco instance, for every language this serves.
  useEffect(() => {
    if (!monaco || !repoPath) return;
    const disposables: IDisposable[] = [];

    /**
     * The file a model belongs to, or `null` when it is not one tsserver was told about.
     *
     * Through `relPathFromModelUri`, and that is the whole of this function's history. Models here
     * are addressed as `codeflow:/<projectId>/<relPath>` — not as paths on disk — so reading
     * `uri.path` directly yielded `<projectId>/src/x.ts`, which still ends in `.ts` and therefore
     * sailed past the kind check before being pasted onto the repo root. The absolute path that came
     * out had the project id wedged into the middle of it and matched nothing in `opened`, so every
     * request returned null and Monaco fell back to word-from-the-document suggestions: the list of
     * `abc and`, `abc are`, `abc Array` scraped out of the file you were editing.
     */
    const fileOf = (model: MonacoEditorNS.ITextModel): string | null => {
      const relative = relPathFromModelUri(model.uri, projectId);
      if (!relative || !scriptKind(relative)) return null;
      const file = absolute(repoPath, relative);
      return opened.current.has(file) ? file : null;
    };

    for (const language of TS_LANGUAGES) {
      disposables.push(
        monaco.languages.registerCompletionItemProvider(language, {
          // `.` for members, `"` and `'` for module specifiers inside an import — which is what
          // makes completing the *package name* work, not just the symbol.
          triggerCharacters: [".", '"', "'", "`", "/", "@", "<", "#", " "],
          provideCompletionItems: async (model: MonacoEditorNS.ITextModel, position: Position) => {
            const file = fileOf(model);
            if (!file || !running.current) return { suggestions: [] };
            const info = await tsRequest<TsCompletionInfo>("completionInfo", {
              file,
              line: position.lineNumber,
              offset: position.column,
              includeExternalModuleExports: true,
              includeInsertTextCompletions: true,
            }).catch(() => null);
            if (!info) return { suggestions: [] };

            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            );

            return {
              suggestions: info.entries.map((entry) => ({
                label: entry.name,
                kind: monacoKind(monaco, entry.kind),
                insertText: entry.insertText ?? entry.name,
                sortText: entry.sortText,
                range,
                // Carried so `resolveCompletionItem` can ask for the details — and the import —
                // for this exact entry, including which module it would come from.
                _ts: { file, position, entry },
              })) as languages.CompletionItem[],
            };
          },

          /**
           * Fills in the documentation and, when the entry comes from a module this file has not
           * imported, the import statement itself.
           *
           * Resolution rather than up-front, because `completionEntryDetails` is a request per
           * entry: doing it for a list of four hundred would be four hundred round trips to render
           * a dropdown. Monaco asks only for the row the user is actually on.
           */
          resolveCompletionItem: async (item: languages.CompletionItem) => {
            const carried = (item as languages.CompletionItem & { _ts?: TsCarried })._ts;
            if (!carried || !running.current) return item;
            const details = await tsRequest<TsCompletionDetail[]>("completionEntryDetails", {
              file: carried.file,
              line: carried.position.lineNumber,
              offset: carried.position.column,
              entryNames: [
                carried.entry.source
                  ? { name: carried.entry.name, source: carried.entry.source, data: carried.entry.data }
                  : carried.entry.name,
              ],
            }).catch(() => null);
            const detail = details?.[0];
            if (!detail) return item;

            item.detail = partsToText(detail.displayParts);
            const docs = partsToText(detail.documentation);
            if (docs) item.documentation = { value: docs };

            // The import. Every change the action asks for that lands in *this* file becomes an
            // additional edit applied with the completion; changes to other files are dropped,
            // because accepting a completion must not silently rewrite a file you are not looking
            // at.
            const edits = (detail.codeActions ?? [])
              .flatMap((action) => action.changes)
              .filter((change) => change.fileName === carried.file)
              .flatMap((change) => change.textChanges);
            if (edits.length > 0) {
              item.additionalTextEdits = edits.map((edit) => ({
                range: new monaco.Range(edit.start.line, edit.start.offset, edit.end.line, edit.end.offset),
                text: edit.newText,
              }));
            }
            return item;
          },
        }),
      );

      disposables.push(
        monaco.languages.registerHoverProvider(language, {
          provideHover: async (model: MonacoEditorNS.ITextModel, position: Position) => {
            const file = fileOf(model);
            if (!file || !running.current) return null;
            const info = await tsRequest<TsQuickInfo>("quickinfo", {
              file,
              line: position.lineNumber,
              offset: position.column,
            }).catch(() => null);
            if (!info) return null;
            return {
              range: new monaco.Range(info.start.line, info.start.offset, info.end.line, info.end.offset),
              contents: [
                { value: "```typescript\n" + info.displayString + "\n```" },
                ...(info.documentation ? [{ value: info.documentation }] : []),
              ],
            };
          },
        }),
      );

      disposables.push(
        monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: async (model: MonacoEditorNS.ITextModel, position: Position) => {
            const file = fileOf(model);
            if (!file || !running.current) return null;
            const found = await tsRequest<TsDefinitionInfo>("definitionAndBoundSpan", {
              file,
              line: position.lineNumber,
              offset: position.column,
            }).catch(() => null);
            if (!found?.definitions?.length) return null;
            return found.definitions.map((definition) => ({
              uri: monaco.Uri.file(definition.file),
              range: new monaco.Range(
                definition.start.line,
                definition.start.offset,
                definition.end.line,
                definition.end.offset,
              ),
            }));
          },
        }),
      );
    }

    return () => {
      for (const item of disposables) item.dispose();
    };
  }, [monaco, repoPath, projectId]);
}

/** What travels on a suggestion so its resolution can ask about the same entry. */
interface TsCarried {
  file: string;
  position: Position;
  entry: TsCompletionInfo["entries"][number];
}

/**
 * tsserver's `kind` strings to Monaco's icon enum.
 *
 * The mapping is what makes a dropdown readable at a glance — a method, a property and a module all
 * drawn with the same glyph is a list you have to read word by word.
 */
function monacoKind(monaco: Monaco, kind: string): languages.CompletionItemKind {
  const k = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "method":
    case "constructor":
      return k.Method;
    case "function":
    case "local function":
      return k.Function;
    case "property":
    case "getter":
    case "setter":
      return k.Property;
    case "class":
      return k.Class;
    case "interface":
      return k.Interface;
    case "type":
    case "type parameter":
      return k.TypeParameter;
    case "enum":
      return k.Enum;
    case "enum member":
      return k.EnumMember;
    case "module":
    case "external module name":
      return k.Module;
    case "keyword":
      return k.Keyword;
    case "const":
    case "let":
    case "var":
    case "local var":
    case "parameter":
      return k.Variable;
    case "primitive type":
      return k.Value;
    default:
      return k.Text;
  }
}
