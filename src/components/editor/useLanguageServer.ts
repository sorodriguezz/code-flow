import { useEffect } from "react";
import type {
  CancellationToken,
  editor as MonacoEditorNS,
  IDisposable,
  languages,
  Position,
} from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import { listDir } from "../../lib/tauri/commands";
import { onLspDiagnostics, onLspExited } from "../../lib/tauri/events";
import { relPathFromModelUri } from "../../lib/editorModel";
import { LANGUAGE_SERVERS } from "../../lib/lsp/servers";
import {
  askAll,
  currentProjectId,
  currentRepoPath,
  forgetSession,
  lspKnows,
  sessionsForLanguage,
  onSessionsChanged,
  startForProject,
  syncChange,
  syncClose,
  syncOpen,
  uriFor,
} from "../../lib/lsp/client";
import {
  modelUriFor,
  toLspPosition,
  toMarkdown,
  toMonacoCompletionKind,
  toMonacoRange,
  toMonacoSeverity,
  toMonacoSymbolKind,
  type LspCompletionItem,
  type LspCompletionList,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspRange,
  type LspSignatureHelp,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from "../../lib/lsp/protocol";

/**
 * Real language intelligence for everything that isn't TypeScript, from the project's own servers.
 *
 * # Why this is not `useTypeScript`
 *
 * They answer the same question and they are deliberately two things. `useTypeScript` speaks
 * `tsserver`'s own protocol, which is not LSP and is a better fit for the two languages it covers:
 * it is the compiler the project already builds with, and it is wired into the npm install flow.
 * This one speaks LSP, which is the protocol every *other* language's server speaks. The catalogue
 * in `lib/lsp/servers.ts` records which languages each of them owns, and neither claims the other's.
 *
 * # Registered once, for the whole app
 *
 * Monaco's providers are global — registering per pane would mean two editor groups asking every
 * server twice and merging the two identical answers into one doubled completion list. So the
 * providers are installed at module scope behind a latch, exactly as `installGoToDefinition` is and
 * for the same reason, and the hook itself owns only what is genuinely per-project: which servers
 * are running, and which buffers they have been told about.
 *
 * # The buffer is what gets sent
 *
 * A server pointed at a path reads what is on disk. What the user is looking at is what they have
 * typed, so `client.ts` sends the text and keeps sending it — the difference between completions
 * that follow the cursor and completions that describe the file as it was last saved.
 */

/** Every language any catalogued server claims. Providers register for all of them once, and each
 *  returns nothing when no session is running for the file in front of it. */
const CLAIMED_LANGUAGES = [...new Set(LANGUAGE_SERVERS.flatMap((server) => server.languages))];

let installed = false;

/**
 * The file a request is about, or `null`.
 *
 * `null` is the answer for a model in an API or database panel (a different URI scheme), for a file
 * in a project whose servers are not running, and for a language nothing claims — and in every one
 * of those the provider must say nothing rather than guess.
 */
function fileOf(model: MonacoEditorNS.ITextModel): { relPath: string; uri: string; language: string } | null {
  const projectId = currentProjectId();
  if (!projectId) return null;
  const relPath = relPathFromModelUri(model.uri, projectId);
  if (!relPath || !lspKnows(relPath)) return null;
  const uri = uriFor(relPath);
  if (!uri) return null;
  return { relPath, uri, language: model.getLanguageId() };
}

/** The `textDocument`/`position` pair that opens almost every LSP request. */
function at(uri: string, position: Position) {
  return { textDocument: { uri }, position: toLspPosition(position) };
}

/** A `Location`, a `LocationLink`, or an array of either — the three shapes `definition` answers in. */
function locationsOf(answer: unknown): { uri: string; range: LspRange }[] {
  const list = Array.isArray(answer) ? answer : answer ? [answer] : [];
  return list.flatMap((entry) => {
    const link = entry as LspLocationLink;
    if (link?.targetUri) return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
    const location = entry as LspLocation;
    return location?.uri ? [{ uri: location.uri, range: location.range }] : [];
  });
}

function installProviders(monaco: Monaco): void {
  if (installed) return;
  installed = true;

  const toLocations = (answers: unknown[]): languages.Location[] => {
    const projectId = currentProjectId();
    const repoPath = currentRepoPath();
    if (!projectId || !repoPath) return [];
    return answers
      .flatMap(locationsOf)
      .flatMap((hit) => {
        const uri = modelUriFor(monaco, projectId, repoPath, hit.uri);
        return uri ? [{ uri, range: toMonacoRange(hit.range) }] : [];
      });
  };

  monaco.languages.registerCompletionItemProvider(CLAIMED_LANGUAGES, {
    /**
     * Hand-picked, and no longer including the space.
     *
     * It used to claim to be "the union of what the catalogue's servers ask for", which it could not
     * be: `LanguageServer` records no trigger characters, so there is no union to compute. What the
     * space actually did was fire a full `askAll` fan-out on every word boundary in every Rust, Go,
     * Python, C++ and Ruby buffer a server holds — Monaco wakes a provider whose list contains the
     * typed character (`suggestModel.js`), and its "this is a case for quick suggest instead" guard
     * passes precisely when the preceding character is not a word character. So it was both the
     * largest source of pointless requests here and a visible misbehaviour: the suggest widget
     * opening after every space, including in prose and comments.
     *
     * Tailwind is the one server that genuinely wants it, for class names inside an attribute. If
     * that is worth having back it belongs in a second provider scoped to Tailwind's own languages
     * and registered only while a tailwind session is running — not in the list every language pays.
     */
    triggerCharacters: [".", ":", ">", "-", '"', "'", "/", "@", "<", "#", "$", "("],
    provideCompletionItems: async (
      model: MonacoEditorNS.ITextModel,
      position: Position,
      _context: languages.CompletionContext,
      token: CancellationToken,
    ) => {
      const file = fileOf(model);
      if (!file) return { suggestions: [] };
      const answers = await askAll<LspCompletionList | LspCompletionItem[]>(
        file.language,
        "textDocument/completion",
        { ...at(file.uri, position), context: { triggerKind: 1 } },
      );
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing. Same guard, same
      // reason, after every await below.
      if (token.isCancellationRequested) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const fallback: import("monaco-editor").IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions = answers
        .flatMap((answer) => (Array.isArray(answer) ? answer : (answer?.items ?? [])))
        .map((item) => {
          const edit = item.textEdit as { range?: LspRange; replace?: LspRange; newText: string } | undefined;
          const range = edit?.range ?? edit?.replace;
          return {
            label: item.label,
            kind: toMonacoCompletionKind(monaco, item.kind),
            detail: item.detail,
            documentation: toMarkdown(item.documentation),
            // The server's own ordering is honoured rather than re-sorted: it is what puts the
            // members of the type you are on above every global sharing a prefix.
            sortText: item.sortText,
            filterText: item.filterText,
            preselect: item.preselect,
            insertText: edit?.newText ?? item.insertText ?? item.label,
            insertTextRules:
              item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            range: range ? toMonacoRange(range) : fallback,
            additionalTextEdits: item.additionalTextEdits?.map((extra) => ({
              range: toMonacoRange(extra.range),
              text: extra.newText,
            })),
            tags: item.deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
            // Round-tripped so `resolveCompletionItem` can hand it straight back.
            _lsp: item,
            _language: file.language,
          } as languages.CompletionItem & { _lsp: LspCompletionItem; _language: string };
        });
      return { suggestions };
    },
    /**
     * The second half of an expensive completion.
     *
     * Servers send a list without documentation and without the import edit that accepting an entry
     * would need — computing either for six hundred candidates is work nobody asked for. `resolve`
     * is where the one entry the user is actually looking at gets both.
     */
    resolveCompletionItem: async (item: languages.CompletionItem, token: CancellationToken) => {
      const carried = item as languages.CompletionItem & { _lsp?: LspCompletionItem; _language?: string };
      if (!carried._lsp || !carried._language) return item;
      const [resolved] = await askAll<LspCompletionItem>(
        carried._language,
        "completionItem/resolve",
        carried._lsp,
      );
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing.
      if (token.isCancellationRequested) return item;
      if (!resolved) return item;
      return {
        ...item,
        detail: resolved.detail ?? item.detail,
        documentation: toMarkdown(resolved.documentation) ?? item.documentation,
        additionalTextEdits:
          resolved.additionalTextEdits?.map((extra) => ({
            range: toMonacoRange(extra.range),
            text: extra.newText,
          })) ?? item.additionalTextEdits,
      };
    },
  });

  monaco.languages.registerHoverProvider(CLAIMED_LANGUAGES, {
    provideHover: async (model: MonacoEditorNS.ITextModel, position: Position, token: CancellationToken) => {
      const file = fileOf(model);
      if (!file) return null;
      const answers = await askAll<LspHover>(file.language, "textDocument/hover", at(file.uri, position));
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing.
      if (token.isCancellationRequested) return null;
      const contents = answers.flatMap((answer) => {
        const markdown = toMarkdown(answer?.contents);
        return markdown ? [markdown] : [];
      });
      if (contents.length === 0) return null;
      const range = answers.find((answer) => answer?.range)?.range;
      return { contents, range: range ? toMonacoRange(range) : undefined };
    },
  });

  /**
   * Go to definition, the real one.
   *
   * Registered alongside the ranked text search in `lib/goToDefinition`, not instead of it: that one
   * covers every language Monaco can open and this one covers the handful with a server installed.
   * Monaco merges both providers' answers and `gotoLocation.multipleDefinitions: "goto"` takes the
   * first, so the fallback stands down on its own when a compiler has spoken — see the guard it
   * grew for exactly this.
   */
  monaco.languages.registerDefinitionProvider(CLAIMED_LANGUAGES, {
    provideDefinition: async (model: MonacoEditorNS.ITextModel, position: Position, token: CancellationToken) => {
      const file = fileOf(model);
      if (!file) return null;
      const answers = await askAll<unknown>(file.language, "textDocument/definition", at(file.uri, position));
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing.
      if (token.isCancellationRequested) return null;
      const locations = toLocations(answers);
      return locations.length > 0 ? locations : null;
    },
  });

  monaco.languages.registerReferenceProvider(CLAIMED_LANGUAGES, {
    provideReferences: async (
      model: MonacoEditorNS.ITextModel,
      position: Position,
      context: languages.ReferenceContext,
      token: CancellationToken,
    ) => {
      const file = fileOf(model);
      if (!file) return [];
      const answers = await askAll<unknown>(file.language, "textDocument/references", {
        ...at(file.uri, position),
        context: { includeDeclaration: context.includeDeclaration },
      });
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing.
      if (token.isCancellationRequested) return [];
      return toLocations(answers);
    },
  });

  /**
   * Rename across the project — the one feature whose absence was actively dangerous.
   *
   * Monaco's own rename is per-model, so renaming a symbol used in nine files renamed it in the one
   * on screen and left the other eight compiling against a name that no longer exists. This asks the
   * server, which knows all nine.
   *
   * Only the first server that answers is used, deliberately. Two servers on one language (Pyright
   * and Ruff both hold Python) would each return a full edit set, and applying both would write
   * every change twice.
   */
  monaco.languages.registerRenameProvider(CLAIMED_LANGUAGES, {
    provideRenameEdits: async (
      model: MonacoEditorNS.ITextModel,
      position: Position,
      newName: string,
      token: CancellationToken,
    ) => {
      const file = fileOf(model);
      const projectId = currentProjectId();
      const repoPath = currentRepoPath();
      if (!file || !projectId || !repoPath) return { edits: [] };
      const [answer] = await askAll<LspWorkspaceEdit>(file.language, "textDocument/rename", {
        ...at(file.uri, position),
        newName,
      });
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing.
      if (token.isCancellationRequested) return { edits: [] };
      if (!answer) return { edits: [] };
      const byFile: [string, LspTextEdit[]][] = answer.documentChanges
        ? answer.documentChanges.map((change) => [change.textDocument.uri, change.edits])
        : Object.entries(answer.changes ?? {});
      const edits: languages.IWorkspaceTextEdit[] = [];
      for (const [uri, changes] of byFile) {
        const resource = modelUriFor(monaco, projectId, repoPath, uri);
        // A rename that reaches outside the repository is dropped rather than applied blind: there
        // is no tab for it, so the user would have no way to see or undo what was written.
        if (!resource) continue;
        for (const change of changes) {
          edits.push({
            resource,
            versionId: undefined,
            textEdit: { range: toMonacoRange(change.range), text: change.newText },
          });
        }
      }
      return { edits };
    },
  });

  monaco.languages.registerSignatureHelpProvider(CLAIMED_LANGUAGES, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: async (model: MonacoEditorNS.ITextModel, position: Position, token: CancellationToken) => {
      const file = fileOf(model);
      if (!file) return null;
      const [answer] = await askAll<LspSignatureHelp>(
        file.language,
        "textDocument/signatureHelp",
        at(file.uri, position),
      );
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing.
      if (token.isCancellationRequested) return null;
      if (!answer?.signatures?.length) return null;
      return {
        value: {
          signatures: answer.signatures.map((signature) => ({
            label: signature.label,
            documentation: toMarkdown(signature.documentation),
            parameters: (signature.parameters ?? []).map((parameter) => ({
              // The offset form addresses a slice of the signature's own label, which is what
              // `labelOffsetSupport` in `client_capabilities` asked servers to use.
              label: parameter.label,
              documentation: toMarkdown(parameter.documentation),
            })),
          })),
          activeSignature: answer.activeSignature ?? 0,
          activeParameter: answer.activeParameter ?? 0,
        },
        dispose: () => {},
      };
    },
  });

  monaco.languages.registerDocumentSymbolProvider(CLAIMED_LANGUAGES, {
    provideDocumentSymbols: async (model: MonacoEditorNS.ITextModel, token: CancellationToken) => {
      const file = fileOf(model);
      if (!file) return [];
      const answers = await askAll<unknown[]>(file.language, "textDocument/documentSymbol", {
        textDocument: { uri: file.uri },
      });
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing.
      if (token.isCancellationRequested) return [];
      type Hierarchical = {
        name: string;
        detail?: string;
        kind?: number;
        range: LspRange;
        selectionRange?: LspRange;
        children?: Hierarchical[];
      };
      const convert = (symbol: Hierarchical): languages.DocumentSymbol => ({
        name: symbol.name,
        detail: symbol.detail ?? "",
        kind: toMonacoSymbolKind(monaco, symbol.kind),
        tags: [],
        range: toMonacoRange(symbol.range),
        selectionRange: toMonacoRange(symbol.selectionRange ?? symbol.range),
        children: symbol.children?.map(convert),
      });
      return (answers.flat() as Hierarchical[]).filter((symbol) => symbol?.range).map(convert);
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(CLAIMED_LANGUAGES, {
    provideDocumentFormattingEdits: async (
      model: MonacoEditorNS.ITextModel,
      options: languages.FormattingOptions,
      token: CancellationToken,
    ) => {
      const file = fileOf(model);
      if (!file) return [];
      const [answer] = await askAll<LspTextEdit[]>(file.language, "textDocument/formatting", {
        textDocument: { uri: file.uri },
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      });
      // Monaco cancels this the moment the caret moves or the next keystroke supersedes the
      // request; converting an answer nobody will read is work for nothing.
      if (token.isCancellationRequested) return [];
      return (answer ?? []).map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }));
    },
  });
}

/**
 * Every open buffer, told to the servers that claim it — not just the focused one.
 *
 * Driven off Monaco's model registry rather than off the active tab: a server told about one file
 * reports diagnostics for one file, and the whole point of a project-wide compiler is that opening
 * a second tab does not make the first one's errors disappear. The registry is a *superset* of the
 * open tabs — the diff views and Monaco's own scratch buffers are in it too — and what filters it is
 * `relPathFromModelUri` returning null for anything that is not one of this project's files. That
 * null check is load-bearing, not defensive.
 *
 * **Installed once, like the providers, and for the same reason.** This used to be a per-pane
 * effect with its own `perModel` map, so splitting the editor gave each pane its own
 * `onDidChangeContent` over the *same* global model registry: every keystroke serialised and sent
 * the whole buffer twice, three times with three panes. Monaco's registry is global, the project is
 * global (`currentProjectId`), and so is this.
 */
let syncInstalled = false;

function installDocumentSync(monaco: Monaco): void {
  if (syncInstalled) return;
  syncInstalled = true;

  const perModel = new Map<string, IDisposable>();

  const attach = (model: MonacoEditorNS.ITextModel) => {
    const projectId = currentProjectId();
    if (!projectId) return;
    const relPath = relPathFromModelUri(model.uri, projectId);
    if (!relPath || perModel.has(model.uri.toString())) return;
    const language = model.getLanguageId();
    if (sessionsForLanguage(language).length === 0) return;
    syncOpen(relPath, language, model.getValue());
    perModel.set(
      model.uri.toString(),
      model.onDidChangeContent(() => syncChange(relPath, model.getValue())),
    );
  };

  /** Every model the open project owns, offered to whatever is running now. Idempotent: `attach`
   *  returns early for anything already attached. */
  const sweep = () => {
    for (const model of monaco.editor.getModels()) attach(model);
  };

  sweep();
  // Again once the servers are actually up. The first sweep runs in the same commit as the effect
  // that starts them, so at that moment `sessionsForLanguage` is empty for every model and the file
  // on screen would be the one file no server was ever told about — see `onSessionsChanged`.
  onSessionsChanged(sweep);
  monaco.editor.onDidCreateModel(attach);
  monaco.editor.onWillDisposeModel((model: MonacoEditorNS.ITextModel) => {
    const key = model.uri.toString();
    perModel.get(key)?.dispose();
    perModel.delete(key);
    const projectId = currentProjectId();
    const relPath = projectId ? relPathFromModelUri(model.uri, projectId) : null;
    if (relPath) syncClose(relPath);
  });
}

/**
 * Diagnostics, which are the one LSP feature that arrives rather than being asked for.
 *
 * Owned per session, so the two servers a language may have (Pyright for types, Ruff for lint) each
 * replace their own markers instead of erasing the other's — and so Monaco's own syntax markers,
 * under a different owner again, are left alone. Latched for the same reason as the sync above:
 * one listener for the app, not one per editor group.
 */
let diagnosticsInstalled = false;

function installDiagnostics(monaco: Monaco): void {
  if (diagnosticsInstalled) return;
  diagnosticsInstalled = true;

  void onLspDiagnostics((event) => {
    const projectId = currentProjectId();
    const repoPath = currentRepoPath();
    if (!projectId || !repoPath) return;
    const uri = modelUriFor(monaco, projectId, repoPath, event.uri);
    if (!uri) return;
    const model = monaco.editor.getModel(uri);
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      `lsp:${event.session_id}`,
      (event.diagnostics as LspDiagnostic[]).map((diagnostic) => ({
        ...toMonacoRange(diagnostic.range),
        message: diagnostic.message,
        // The code is what makes an error searchable — `E0308` finds an answer, the sentence finds
        // a hundred pages of other people's code.
        code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
        source: diagnostic.source,
        severity: toMonacoSeverity(monaco, diagnostic.severity),
        tags: diagnostic.tags?.includes(1) ? [monaco.MarkerTag.Unnecessary] : undefined,
      })),
    );
  });

  void onLspExited((event) => forgetSession(event.session_id));
}

interface Options {
  repoPath: string;
  projectId: string;
}

export function useLanguageServer(monaco: Monaco | null, { repoPath, projectId }: Options) {
  // Providers first, and independently of whether any server comes up: they answer nothing until
  // one does, which is exactly the behaviour a machine with none installed should have.
  useEffect(() => {
    if (!monaco) return;
    installProviders(monaco);
    installDocumentSync(monaco);
    installDiagnostics(monaco);
  }, [monaco]);

  /**
   * The servers for this repository, started from what is at its root.
   *
   * `listDir` rather than the full tree walk `listRepoFiles` does: every marker in the catalogue is
   * a root file (`Cargo.toml`, `go.mod`, `composer.json`), so one directory listing answers the
   * whole question, and it answers it without reading a repository's worth of paths on every open.
   */
  useEffect(() => {
    if (!monaco || !repoPath || !projectId) return;
    let alive = true;
    void listDir(repoPath)
      .then((entries) => {
        if (!alive) return;
        return startForProject(projectId, repoPath, entries.map((entry) => entry.name));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [monaco, repoPath, projectId]);

  // Deliberately no unmount cleanup. This hook runs once per editor *group*, so stopping the
  // servers here would mean closing a split killed the intelligence in the pane still open beside
  // it. Switching project is already handled where it belongs — `startForProject` stops the
  // previous project's servers before starting the new ones — and quitting is handled in `lib.rs`,
  // beside the other child processes `process::exit` would otherwise orphan.


}
