import { useEffect } from "react";
import type { IRange, editor as MonacoEditorNS, languages, Position } from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import {
  TS_LANGUAGES,
  partsToText,
  scriptKind,
  tsAbsolute,
  tsNotify,
  tsOpenFiles,
  tsRequest,
  tsStart,
  type TsCompletionDetail,
  type TsCodeFixAction,
  type TsDiagnostic,
  type TsCompletionInfo,
  type TsDefinitionInfo,
  type TsQuickInfo,
} from "../../lib/tsserver";
import { modelPathForId, relPathFromModelUri } from "../../lib/editorModel";
import { isInstallableName } from "../../lib/packageScripts";
import type { TranslationKey } from "../../lib/i18n/translations";

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
 * # Registered once, for the whole app
 *
 * Monaco's providers are global to the instance and `EditorPane` is rendered once per editor group,
 * so registering them from the hook meant a split editor asked tsserver everything twice and Monaco
 * merged the two identical answers into one doubled completion list. `installProviders` is behind a
 * latch for that reason — the same one `installGoToDefinition` and `useLanguageServer` use — and the
 * hook itself owns only what is per-project: the server, the document sync, and the markers.
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
 * # Diagnostics come from the project, not from the buffer
 *
 * Monaco's own TypeScript worker type-checks each file *in isolation* — no tsconfig, no
 * `node_modules`, no siblings — so its semantic errors are about a project it cannot see. That is
 * why `monacoSetup` turns them off, and why for a long time this editor showed no errors at all:
 * the only thing allowed to speak had nothing true to say.
 *
 * The compiler does. `semanticDiagnosticsSync` is the same check `tsc` runs, over the same
 * `tsconfig.json`, so what is underlined here is what the build will say — and it arrives as an
 * ordinary request, one file at a time, rather than through the `geterr` event stream the reader in
 * `tsserver.rs` drops.
 *
 * Syntax stays with Monaco's worker, which is right about it by construction and answers on every
 * keystroke without a round trip.
 */

interface Options {
  /** Absolute path of the repository — what the server is started for. */
  repoPath: string | null;
  /** The open project's id. Needed to read a model's URI: this app addresses models as
   *  `codeflow:/<projectId>/<relPath>`, not by their path on disk. */
  projectId: string;
  /** Repo-relative path of the file on screen. */
  activePath: string | null;
  /**
   * Offers to install a package the file imports and the project does not have.
   *
   * Passed in rather than done here: which manifest an install lands in, and which manager writes
   * it, is a question about the repository — `EditorPane` already holds both answers for the
   * dependency lens, and a second, quieter answer computed here is how the two would drift apart.
   */
  onInstallPackage: (name: string, dev: boolean) => void;
  /** Translations, passed in for the same reason the lens takes them: a key that does not exist is
   *  a compile error here too. */
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/** tsserver wants absolute, forward-slashed paths. Spelled in `lib/tsserver`, because the set of
 *  open files is keyed by it and a second spelling here would miss every lookup. */
const absolute = tsAbsolute;

/**
 * What the providers — installed once, for the whole app — need from the project that is open.
 *
 * They cannot close over a pane's props. `EditorView` renders one `EditorPane` per editor group, so
 * anything captured at registration would be whichever group happened to mount last; this is
 * published by the hook and read at call time instead.
 */
interface Current {
  repoPath: string;
  projectId: string;
  install: (name: string, dev: boolean) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

let current: Current | null = null;

/** Whether the server came up. Providers stay registered either way — they simply return nothing
 *  — so a project without TypeScript installed behaves exactly as it did before. */
let running = false;

let installed = false;

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
function fileOf(model: MonacoEditorNS.ITextModel): string | null {
  const project = current;
  if (!project) return null;
  const relative = relPathFromModelUri(model.uri, project.projectId);
  if (!relative || !scriptKind(relative)) return null;
  const file = absolute(project.repoPath, relative);
  return tsOpenFiles.has(file) ? file : null;
}

/**
 * The other direction: an absolute path from tsserver, as a model this app can open.
 *
 * **This is what was missing for go-to-definition.** The provider used to answer with
 * `Uri.file(...)`, and nothing in this app can open a `file:` URI — models are addressed as
 * `cf-editor:/<projectId>/<relPath>` and the editor opener in `lib/goToDefinition` turns down
 * anything else. So the compiler was answering correctly and the click did nothing at all.
 *
 * Anything outside the repository is dropped rather than mapped to a path that would resolve
 * somewhere else: there is no tab this app could open for it. A dependency is not such a case —
 * `node_modules` lives inside the repo, so `@nestjs/common` and its `.d.ts` files map like any
 * other file and open as ordinary tabs.
 */
function modelUriFor(monaco: Monaco, file: string) {
  const project = current;
  if (!project) return null;
  const root = project.repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = file.replace(/\\/g, "/");
  if (!normalized.startsWith(`${root}/`)) return null;
  return monaco.Uri.parse(modelPathForId(project.projectId, normalized.slice(root.length + 1)));
}

/**
 * The id the quick fix below invokes.
 *
 * Fixed, where `usePackageJsonLens` scopes its own with `useId`. That hook needs the suffix because
 * it registers per pane and command ids are global, so two panes both claiming `cf.npm.check` leave
 * the registry answering with one of them. This is registered once for the whole app, so there is
 * nothing to collide with — and a `useId` would be a per-pane id on a registration that is not.
 */
const INSTALL_COMMAND = "cf.npm.installMissing";

/**
 * The diagnostic codes worth asking the compiler for a fix on, restricted to the ones this quick
 * fix exists for.
 *
 * **`getCodeFixes` is asked per error code, and asking for all of them is not free**: tsserver
 * computes every registered fix for every code it is handed, and the import fixes alone walk the
 * whole module graph. So the list is the "this name is not defined here" family and nothing else —
 * which is exactly the set that `@Module`, `@Column` and `@Entity` land in.
 *
 * - `2304` cannot find name — the ordinary case, an undecorated `Module` with no import.
 * - `2552` / `2551` cannot find name, did you mean… — the same thing with a near miss suggested.
 * - `2503` cannot find namespace, for `Foo.Bar` used as a type.
 * - `2686` refers to a UMD global — a `.tsx` using `React` under `isolatedModules`.
 * - `2osen`… no: `2663` / `2662` are the class-member forms, and `2724` is "has no exported member
 *   named X, did you mean Y", which is the fix that *rewrites* an existing import.
 * - `18004` no value exists for the shorthand property, which is `{ Module }` written by hand.
 *
 * Everything else Ctrl+. could offer — remove-unused, implement-interface, add-missing-member — is
 * deliberately out of scope here. They are worth having and they are a different set of codes; this
 * is the one the user cannot work around, because the alternative is knowing which package a
 * decorator came from.
 */
const IMPORT_FIX_CODES = [2304, 2551, 2552, 2503, 2662, 2663, 2686, 2724, 18004];

/**
 * "Import X from 'y'" — the fix the compiler already knows and nothing here used to ask for.
 *
 * The gap this closes: the editor could *complete* a name into an import (see `resolveCompletionItem`,
 * where `codeActions` rides along with the completion), but only while the name was being typed.
 * A name already written — pasted in, or typed before the package was installed — had a red
 * underline and no lightbulb, so `@Module` from `@nestjs/common` and `@Column` from `typeorm` were
 * something you had to know by heart and write by hand. `getCodeFixes` is the same machinery from
 * the other end, and the compiler's answer names the real module, from this project's real
 * `node_modules` and `paths` mapping, rather than a guess.
 *
 * **The whole answer is applied, including changes to other files.** That is the opposite of the
 * rule `resolveCompletionItem` follows, and deliberately: a completion is a keystroke and must not
 * quietly rewrite a file you are not looking at, while a quick fix is an explicit choice from a
 * menu that named what it was going to do. In practice an import fix only ever touches this file;
 * the others are edits the user asked for. A file outside the repository is still dropped — there
 * is no model this app could edit for it (see `modelUriFor`).
 */
async function compilerFixes(
  monaco: Monaco,
  model: MonacoEditorNS.ITextModel,
  range: IRange,
  context: languages.CodeActionContext,
): Promise<languages.CodeAction[]> {
  const file = fileOf(model);
  if (!file || !running) return [];
  // A request for one specific kind — the "fix all on save" family, `source.*` — is not this. Left
  // unguarded it would be a tsserver round trip per save that can only ever produce quick fixes
  // Monaco then filters out.
  if (context.only && !context.only.startsWith("quickfix")) return [];

  // Only the markers this request is actually about — Monaco hands over the ones intersecting the
  // range, which for a Ctrl+. is the caret's line. `code` is written as `TS2304` where the protocol
  // wants the number; see where the markers are built.
  const codes = new Set<number>();
  const diagnostics: MonacoEditorNS.IMarkerData[] = [];
  for (const marker of context.markers) {
    const numeric = Number(String(marker.code ?? "").replace(/^TS/i, ""));
    if (!IMPORT_FIX_CODES.includes(numeric)) continue;
    codes.add(numeric);
    diagnostics.push(marker);
  }
  if (codes.size === 0) return [];

  // The span asked about is the diagnostics' own, widened to cover all of them — not the caret
  // range Monaco handed over. `getCodeFixes` answers for errors whose span *intersects* what it is
  // given, and a Ctrl+. with nothing selected is a zero-width range: it happens to intersect a name
  // it sits inside, and happens not to when the caret is one character past the end of it. Asking
  // about the underline itself is the version that cannot be off by one.
  const span = diagnostics.reduce(
    (acc, marker) => ({
      startLineNumber: Math.min(acc.startLineNumber, marker.startLineNumber),
      startColumn:
        marker.startLineNumber < acc.startLineNumber
          ? marker.startColumn
          : Math.min(acc.startColumn, marker.startColumn),
      endLineNumber: Math.max(acc.endLineNumber, marker.endLineNumber),
      endColumn:
        marker.endLineNumber > acc.endLineNumber
          ? marker.endColumn
          : Math.max(acc.endColumn, marker.endColumn),
    }),
    {
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn,
    },
  );

  const fixes = await tsRequest<TsCodeFixAction[]>("getCodeFixes", {
    file,
    startLine: span.startLineNumber,
    startOffset: span.startColumn,
    endLine: span.endLineNumber,
    endOffset: span.endColumn,
    errorCodes: [...codes],
  }).catch(() => null);
  if (!fixes || fixes.length === 0) return [];

  const actions: languages.CodeAction[] = [];
  for (const fix of fixes) {
    const edits: languages.IWorkspaceTextEdit[] = [];
    for (const change of fix.changes) {
      const uri = change.fileName === file ? model.uri : modelUriFor(monaco, change.fileName);
      if (!uri) continue;
      for (const edit of change.textChanges) {
        edits.push({
          resource: uri,
          versionId: undefined,
          textEdit: {
            range: new monaco.Range(
              edit.start.line,
              edit.start.offset,
              edit.end.line,
              edit.end.offset,
            ),
            text: edit.newText,
          },
        });
      }
    }
    // A fix whose every change landed outside the repository has nothing left to apply, and an
    // empty action in the menu is a row that does nothing when you pick it.
    if (edits.length === 0) continue;
    actions.push({
      // tsserver's own sentence, which already reads as a menu row ("Import 'Module' from
      // \"@nestjs/common\"") and — unlike anything written here — names the module it found.
      title: fix.description,
      kind: "quickfix",
      diagnostics,
      // The import is what you came for. `isPreferred` is what puts it under the caret when Ctrl+.
      // opens, and what makes "fix this" without reading the list do the right thing.
      isPreferred: fix.fixName === "import",
      edit: { edits },
    });
  }
  // Imports first whatever order the server answered in: with several fixes offered for one name,
  // the other kinds are consolation prizes.
  return actions.sort(
    (a, b) => Number(b.isPreferred ?? false) - Number(a.isPreferred ?? false),
  );
}

/**
 * Everything tsserver answers, installed once for the whole app.
 *
 * Monaco's language providers are global to the instance, and `EditorPane` — which owns this hook —
 * is rendered once per editor group. Registering from the hook therefore meant that splitting the
 * editor registered a second, identical set: every completion went to tsserver twice and Monaco
 * merged the two answers into one list with every entry in it twice, and the same for hovers and
 * definitions. So they are installed at module scope behind a latch, exactly as
 * `installGoToDefinition` and `useLanguageServer`'s `installProviders` are and for the same reason.
 *
 * Never disposed, for the same reason `useLanguageServer` never disposes its own: there is no moment
 * at which "the editor" goes away, and tearing them down when one pane unmounted would take the
 * intelligence out of the pane still open beside it. They cost nothing until there is something to
 * answer with — without a project, or without a server, every one of them returns nothing.
 */
function installProviders(monaco: Monaco): void {
  if (installed) return;
  installed = true;

  monaco.languages.registerCompletionItemProvider(TS_LANGUAGES, {
    // `.` for members, `"` and `'` for module specifiers inside an import — which is what
    // makes completing the *package name* work, not just the symbol.
    triggerCharacters: [".", '"', "'", "`", "/", "@", "<", "#", " "],
    provideCompletionItems: async (model: MonacoEditorNS.ITextModel, position: Position) => {
      const file = fileOf(model);
      if (!file || !running) return { suggestions: [] };
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
      if (!carried || !running) return item;
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
  });

  monaco.languages.registerHoverProvider(TS_LANGUAGES, {
    provideHover: async (model: MonacoEditorNS.ITextModel, position: Position) => {
      const file = fileOf(model);
      if (!file || !running) return null;
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
  });

  /**
   * Ctrl/Cmd+click, F12, and the underline on hover — answered by the compiler.
   *
   * This is what makes the jump land on a method of an imported class, on an interface, on a
   * type alias, and on the package itself when the click is on `'@nestjs/common'`: tsserver
   * resolves a module specifier to the `.d.ts` it points at, which is a question no text search
   * can answer. The ranked text search in `lib/goToDefinition` stands aside for any file this
   * server holds — see `tsKnows` there — so these answers are not competing with guesses.
   */
  monaco.languages.registerDefinitionProvider(TS_LANGUAGES, {
    provideDefinition: async (model: MonacoEditorNS.ITextModel, position: Position) => {
      const file = fileOf(model);
      if (!file || !running) return null;
      const found = await tsRequest<TsDefinitionInfo>("definitionAndBoundSpan", {
        file,
        line: position.lineNumber,
        offset: position.column,
      }).catch(() => null);
      if (!found?.definitions?.length) return null;
      return found.definitions
        .map((definition) => {
          const uri = modelUriFor(monaco, definition.file);
          return uri
            ? {
                uri,
                range: new monaco.Range(
                  definition.start.line,
                  definition.start.offset,
                  definition.end.line,
                  definition.end.offset,
                ),
              }
            : null;
        })
        .filter((location) => location !== null);
    },
  });

  /**
   * "Install it" on a module the project does not have.
   *
   * TypeScript already knows: `TS2307` is *cannot find module*, and `TS7016` is *the module is
   * there but its types are not*. Both are exactly the moment somebody wants the package, and
   * until now both ended the same way — a red line in the editor, a search in a terminal, and a
   * command typed by hand. The two fixes differ only in what gets installed: the package itself,
   * or its `@types`.
   *
   * The name is read **off the marker's own span**, not out of the message. The span is the module
   * specifier — quotes and all — so this does not depend on tsserver's wording, which is a
   * sentence in whatever locale the server is running in.
   *
   * The action opens the install dialog with the name already searched rather than running an
   * install outright: `pg` may not be the package you meant, may not exist, and writing to a
   * lockfile is not something a lightbulb should do without being looked at. Whether it exists is
   * the dialog's own answer — it searches the registry, and a name nothing matches installs
   * nothing.
   */
  monaco.editor.registerCommand(INSTALL_COMMAND, (_ctx: unknown, name: string, dev: boolean) =>
    current?.install(name, dev),
  );

  monaco.languages.registerCodeActionProvider(TS_LANGUAGES, {
    provideCodeActions: async (
      model: MonacoEditorNS.ITextModel,
      range: IRange,
      context: languages.CodeActionContext,
    ) => {
      const project = current;
      if (!project) return { actions: [], dispose: () => undefined };
      const actions: languages.CodeAction[] = [];
      const seen = new Set<string>();
      for (const marker of context.markers) {
        const wanted = missingPackage(model, marker);
        if (!wanted || seen.has(wanted.name)) continue;
        seen.add(wanted.name);
        actions.push({
          title: project.t(wanted.dev ? "npm.quickFixTypes" : "npm.quickFixInstall", {
            name: wanted.name,
          }),
          kind: "quickfix",
          diagnostics: [marker],
          isPreferred: true,
          command: { id: INSTALL_COMMAND, title: "install", arguments: [wanted.name, wanted.dev] },
        });
      }
      actions.push(...(await compilerFixes(monaco, model, range, context)));
      return { actions, dispose: () => undefined };
    },
  });
}

export function useTypeScript(
  editor: MonacoEditorNS.IStandaloneCodeEditor | null,
  monaco: Monaco | null,
  { repoPath, projectId, activePath, onInstallPackage, t }: Options,
) {
  /**
   * The project the providers answer about, republished on every render.
   *
   * No dependency list, deliberately: `onInstallPackage` and `t` are fresh functions on every render
   * of `EditorPane`, so a list naming them would run this every render regardless, and one leaving
   * them out would hand the quick fix a callback from a render ago. Assigning four fields is cheaper
   * than either.
   */
  useEffect(() => {
    if (repoPath) current = { repoPath, projectId, install: onInstallPackage, t };
  });

  // Installed before the server and independently of it: the providers answer nothing until it is
  // up, which is exactly how a repository with no TypeScript in it should behave.
  useEffect(() => {
    if (monaco) installProviders(monaco);
  }, [monaco]);

  // One server per repository, started when a file that needs it is first shown.
  useEffect(() => {
    if (!monaco || !repoPath || !activePath || !scriptKind(activePath)) return;
    let alive = true;
    void tsStart(repoPath)
      .then(() => {
        if (!alive) return;
        running = true;
        // A restart invalidates every `open` the previous server was told about.
        tsOpenFiles.clear();
        isolatedWorker(monaco, false);
      })
      .catch(() => {
        // No TypeScript in the project. Not an error to surface: it is the ordinary state of a repo
        // that is not a TypeScript project, and a toast on every file opened would be noise.
        running = false;
        isolatedWorker(monaco, true);
      });
    return () => {
      alive = false;
    };
  }, [monaco, repoPath, activePath]);

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
      if (!running || disposed) return;
      if (tsOpenFiles.has(file)) {
        void tsNotify("change", {
          file,
          line: 1,
          offset: 1,
          endLine: model.getLineCount() + 1,
          endOffset: 1,
          insertString: model.getValue(),
        }).catch(() => undefined);
      } else {
        tsOpenFiles.add(file);
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

  /**
   * What is wrong with the file, and what is merely unused.
   *
   * Two answers from the same pair of requests, drawn differently because they mean different
   * things:
   *
   * * **Errors and warnings** become Monaco markers — the squiggle, the entry in the hover, the mark
   *   in the overview ruler. `Cannot find name 'pool'` should not first appear in a terminal after a
   *   build; it is known the moment the file is typed, and this is the editor saying so.
   * * **Unused code** is faded instead. An import you stopped using is not an error — the file
   *   compiles, the build passes — but it is dead weight, and dimming it is what VS Code does. The
   *   source of truth is the same: the spans TypeScript marks `reportsUnnecessary`.
   *
   * # Two commands, because the same fact arrives as two different kinds of diagnostic
   *
   * With `noUnusedLocals` off — the default, and what most projects run — an unused import is a
   * *suggestion*. With it on, the very same import is a semantic **error**. Asking for only one of
   * the two would fade nothing in half the projects that exist, and which half depends on a tsconfig
   * flag nobody would connect to this. Both are requested, and each entry is read for both answers.
   *
   * A suggestion that is *only* about something being unused gets the fade and no squiggle, which is
   * again VS Code's split: `'readFile' is declared but never read` is not a defect to underline. The
   * same fact as a semantic error — which is what `noUnusedLocals` makes it — keeps its squiggle,
   * because at that point the build does fail on it.
   *
   * These are the `Sync` commands, so they answer as ordinary requests. The event-driven `geterr` is
   * what the header calls unwired, and it stays that way: this needs an answer about one file at a
   * time, which is exactly what these return.
   */
  useEffect(() => {
    if (!editor || !monaco || !repoPath || !activePath || !scriptKind(activePath)) return;
    let disposed = false;
    let marks: MonacoEditorNS.IEditorDecorationsCollection | null = null;

    const draw = async () => {
      const model = editor.getModel();
      if (disposed || !model || !running) return;
      const file = absolute(repoPath, activePath);
      // The buffer has to have reached the server first; the sync effect above sends it and retries,
      // so a miss here simply waits for the next pass rather than asking about a file tsserver has
      // never heard of.
      if (!tsOpenFiles.has(file)) return;
      const [suggested, semantic] = await Promise.all([
        tsRequest<TsDiagnostic[]>("suggestionDiagnosticsSync", { file }).catch(() => []),
        tsRequest<TsDiagnostic[]>("semanticDiagnosticsSync", { file }).catch(() => []),
      ]);
      // The answer describes the buffer as it was when it was asked for. A tab switched in the
      // meantime would take these spans onto a file they are not about.
      if (disposed || editor.getModel() !== model) return;
      const all = [...suggested, ...semantic];
      if (all.length > 0) answered = true;

      /**
       * The markers, owned by this file's own key so a later pass replaces them wholesale rather
       * than piling a second copy on top — and so Monaco's own syntax markers, under a different
       * owner, are left alone.
       */
      monaco.editor.setModelMarkers(
        model,
        "tsserver",
        all
          .filter((entry) => !(entry.category === "suggestion" && entry.reportsUnnecessary))
          .map((entry) => ({
            startLineNumber: entry.start.line,
            startColumn: entry.start.offset,
            endLineNumber: entry.end.line,
            endColumn: entry.end.offset,
            message: entry.text,
            // The number is what makes an error searchable — `TS2304` finds an answer, the sentence
            // finds a hundred pages of other people's code.
            code: entry.code === undefined ? undefined : `TS${entry.code}`,
            severity: severityOf(monaco, entry.category),
          })),
      );

      const unused = all.filter((entry) => entry.reportsUnnecessary);
      marks?.clear();
      marks = editor.createDecorationsCollection(
        unused.map((entry) => ({
          range: new monaco.Range(entry.start.line, entry.start.offset, entry.end.line, entry.end.offset),
          options: {
            inlineClassName: "cf-unused",
            hoverMessage: { value: entry.text },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })),
      );
    };

    /**
     * Whether any pass has come back with something. Only used to stop the opening ladder early —
     * a file that is genuinely clean simply runs out of rungs.
     */
    let answered = false;

    /**
     * The opening passes, and why there is more than one.
     *
     * A cold tsserver answers `semanticDiagnosticsSync` with an empty list while it is still loading
     * the project: correct as a statement about what it knows, and wrong as a statement about the
     * file. One pass at 900ms therefore means a file you open and *read* — without typing a
     * character — can sit there looking clean, which is exactly the case the editor is for.
     *
     * Three rungs, spread out, and stopped as soon as one of them says something. On a clean file it
     * costs two extra checks in the first six seconds and nothing after.
     */
    const ladder = [900, 2500, 6000];
    const timers = ladder.map((delay) =>
      setTimeout(() => {
        if (!answered) void draw();
      }, delay),
    );

    // Settled rather than immediate, and more slowly than the badges: this is a type-check of the
    // file, and running one per keystroke would ask the compiler to redo the project's work while
    // somebody is still typing the name.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = editor.onDidChangeModelContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void draw(), 700);
    });

    return () => {
      disposed = true;
      for (const each of timers) clearTimeout(each);
      if (timer) clearTimeout(timer);
      changed.dispose();
      marks?.clear();
      // Markers live on the *model*, which outlives this effect — a tab kept open in another group,
      // a file reopened later. Left behind, they would be a snapshot of a file as it was some edits
      // ago, presented as current.
      const model = editor.getModel();
      if (model) monaco.editor.setModelMarkers(model, "tsserver", []);
    };
  }, [editor, monaco, repoPath, activePath]);
}

/**
 * Turns Monaco's own TypeScript worker on or off as a source of *answers about types*.
 *
 * # Why it has to be turned off
 *
 * The worker type-checks each file alone: no `tsconfig.json`, no `node_modules`, no siblings. So
 * `pool.query<RuleRow>(…)` — whose type comes from a package — is `any` to it, and it says so, in a
 * hover box stacked on top of the compiler's own. Two answers to one question, one of them wrong,
 * and the wrong one is the one that reads `any`. That is not a display bug to hide; it is a second
 * opinion from something that cannot see the project.
 *
 * Diagnostics were already off for this reason (see `monacoSetup`). This is the rest of it:
 * hovers, completions, definitions, signature help, quick fixes and inlay hints all come from the
 * same isolated view, and every one of them is now answered by tsserver instead.
 *
 * # What stays on
 *
 * Formatting, document symbols and highlights. None of them ask what a type *is* — they are about
 * the shape of the text — so the isolated view is a perfectly good source, and turning them off
 * would take away the only formatter this editor has.
 *
 * # And why it is a toggle rather than a line in the bootstrap
 *
 * A repository with no TypeScript installed gets no server, and there the worker's isolated
 * answers, wrong as they are about imports, are the only ones there are. Off while a compiler is
 * running, back on when there is none.
 */
function isolatedWorker(monaco: Monaco, enabled: boolean) {
  const typed = {
    completionItems: enabled,
    hovers: enabled,
    definitions: enabled,
    references: enabled,
    signatureHelp: enabled,
    codeActions: enabled,
    inlayHints: enabled,
    rename: enabled,
    // Not about types, and the only formatter the editor has.
    documentSymbols: true,
    documentHighlights: true,
    documentFormattingEdits: true,
    documentRangeFormattingEdits: true,
    onTypeFormattingEdits: true,
    diagnostics: false,
  };
  monaco.typescript.typescriptDefaults.setModeConfiguration(typed);
  monaco.typescript.javascriptDefaults.setModeConfiguration(typed);
}

/**
 * The package a marker is complaining about, or `null` when it is not that kind of marker.
 *
 * `TS2307` — no module — wants the package. `TS7016` — module found, types missing — wants its
 * `@types`, where a scoped name is flattened the way DefinitelyTyped spells it: `@nestjs/common`
 * becomes `@types/nestjs__common`.
 *
 * A relative import is never offered: `./app.service` is a file that is missing or misspelled, and
 * "install it" is not the fix. `isInstallableName` is what draws that line, and it is the same guard
 * the install command uses before a name becomes a shell word.
 */
function missingPackage(
  model: MonacoEditorNS.ITextModel,
  marker: MonacoEditorNS.IMarkerData,
): { name: string; dev: boolean } | null {
  const code = typeof marker.code === "string" ? marker.code : marker.code?.value;
  if (code !== "TS2307" && code !== "TS7016") return null;
  const specifier = model
    .getValueInRange({
      startLineNumber: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLineNumber: marker.endLineNumber,
      endColumn: marker.endColumn,
    })
    .trim()
    .replace(/^['"`]|['"`]$/g, "");
  // `lodash/merge` is still `lodash`; `@scope/pkg/sub` is still `@scope/pkg`.
  const parts = specifier.split("/");
  const bare = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!isInstallableName(bare)) return null;
  if (code === "TS2307") return { name: bare, dev: false };
  return { name: `@types/${bare.startsWith("@") ? bare.slice(1).replace("/", "__") : bare}`, dev: true };
}

/**
 * tsserver's `category` to Monaco's severity.
 *
 * `suggestion` and `message` land on `Hint`, which draws no squiggle and no ruler mark — the right
 * weight for "you could tidy this", and the reason a hint that is *also* about unused code is
 * dropped from the marker list entirely rather than shown twice.
 */
function severityOf(monaco: Monaco, category?: string) {
  switch (category) {
    case "error":
      return monaco.MarkerSeverity.Error;
    case "warning":
      return monaco.MarkerSeverity.Warning;
    default:
      return monaco.MarkerSeverity.Hint;
  }
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
