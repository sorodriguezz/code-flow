import * as monaco from "monaco-editor";
import {
  declarationPattern,
  findImportSource,
  moduleSpecifierAt,
  rankDefinitions,
  resolveModuleFile,
  type DefinitionHit,
} from "./definitions";
import { MODEL_SCHEME, modelPathFor, relPathFromModelUri } from "./editorModel";
import { TS_LANGUAGES, tsKnows } from "./tsserver";
import { lspCanDefine } from "./lsp/client";
import { listRepoFiles, searchRepo } from "./tauri/commands";
import type { Project } from "../types/domain";

/** What the provider needs from the app: which repo it's looking at, and how to open a file in
 * the group the user is working in. Set by the editor while a project is open. */
interface DefinitionContext {
  project: Project;
  open: (path: string, line: number, column?: number) => void;
}

let context: DefinitionContext | null = null;
/** The repo's file list, needed to resolve an import specifier to a real file. Cached per repo
 * because it's a full tree walk and the answer barely changes; a stale entry costs at most one
 * failed jump for a file created since the editor opened. */
let fileCache: { repoPath: string; files: string[] } | null = null;

export function setDefinitionContext(next: DefinitionContext | null) {
  context = next;
  if (!next || fileCache?.repoPath !== next.project.local_path) fileCache = null;
}

async function repoFiles(repoPath: string): Promise<string[]> {
  if (fileCache?.repoPath === repoPath) return fileCache.files;
  const files = await listRepoFiles(repoPath).catch(() => []);
  fileCache = { repoPath, files };
  return files;
}

/** Column of `symbol` within `line`, 1-based, so the caret lands on the name rather than at the
 * start of the declaration. */
function columnOf(line: string, symbol: string): number {
  const index = line.indexOf(symbol);
  return index < 0 ? 1 : index + 1;
}

async function findDefinition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.Definition | null> {
  if (!context) return null;
  const { project } = context;
  const fromPath = relPathFromModelUri(model.uri, project.id);
  if (!fromPath) return null;

  /**
   * The compiler outranks the guess.
   *
   * Everything below is a repo-wide text search with a ranking on top: it finds `class Foo` by
   * looking for the words, which is the best available answer in a shell script or a Rust file and
   * a poor one in TypeScript, where a real language service knows which `Foo` this name is bound
   * to. Both providers are registered, and Monaco concatenates their results in registration
   * order — this one first, because it is installed at startup — so with a compiler running its
   * answer would sit *behind* a guess that the editor is configured to jump to. Standing aside is
   * what puts the right file first.
   *
   * Only for files the server actually holds: a `.ts` file in a repo with no TypeScript installed
   * still gets the search, which is the whole reason it exists.
   */
  if (TS_LANGUAGES.includes(model.getLanguageId()) && tsKnows(project.local_path, fromPath)) {
    return null;
  }

  // The same stand-aside, for every other language — but only for a server that *advertises*
  // definitions. Standing aside merely because some server holds the file is how F12 stopped
  // working in a Python repo with only `ruff` running, or in any CSS file next to a Tailwind
  // config: those servers hold the file and answer nothing. A file with no capable server, or none
  // running at all, still gets the ranked search below, which is the whole reason it exists.
  //
  // Note this is not about winning the ordering, which an earlier version of this comment had
  // backwards. Monaco breaks provider ties by registration time and the *later* one sorts first
  // (`_compareByScoreAndTime`), and the LSP providers are registered from a React effect long after
  // this one is installed at startup — so a compiler's answer was already first. What standing
  // aside buys is keeping a low-quality duplicate out of Peek Definition and the result list.
  if (lspCanDefine(fromPath)) return null;

  const lineText = model.getLineContent(position.lineNumber);

  // Clicking the path in an import line is its own, unambiguous answer: that file, line 1.
  const spec = moduleSpecifierAt(lineText, position.column);
  if (spec) {
    const target = resolveModuleFile(spec, fromPath, await repoFiles(project.local_path));
    if (!target) return null;
    return [
      {
        uri: monaco.Uri.parse(modelPathFor(project, target)),
        range: new monaco.Range(1, 1, 1, 1),
      },
    ];
  }

  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const symbol = word.word;

  // Where the name came from, when it came from somewhere — this is what turns a repo-wide grep
  // into an answer, by giving one candidate file a decisive edge in the ranking.
  const importSpec = findImportSource(model.getValue(), symbol);
  const importedFrom = importSpec
    ? resolveModuleFile(importSpec, fromPath, await repoFiles(project.local_path))
    : null;

  const outcome = await searchRepo(
    project.local_path,
    declarationPattern(symbol),
    { caseSensitive: true, wholeWord: false, regex: true, include: "", exclude: "" },
    200,
  ).catch(() => null);
  if (!outcome) return null;

  const hits: DefinitionHit[] = outcome.hits.map((hit) => ({
    path: hit.path,
    line: hit.line_no,
    text: hit.line,
  }));
  const ranked = rankDefinitions(hits, {
    symbol,
    fromPath,
    fromLine: position.lineNumber,
    importedFrom,
  });
  if (ranked.length === 0) return null;

  // Every survivor is returned, best first. The editor is configured to jump to the first one
  // rather than peek (`gotoLocation.multipleDefinitions` in `EditorPane`), so the order here is
  // the answer; the rest stay available to a deliberate Peek Definition.
  return ranked.slice(0, 12).map((hit) => ({
    uri: monaco.Uri.parse(modelPathFor(project, hit.path)),
    range: new monaco.Range(hit.line, columnOf(hit.text, symbol), hit.line, columnOf(hit.text, symbol) + symbol.length),
  }));
}

let installed = false;

/**
 * Wires Ctrl/Cmd+click (and F12) to a project-wide definition lookup.
 *
 * Two registrations are needed and both are global, which is why this runs once at startup rather
 * than per editor instance:
 *
 * - a **definition provider**, which is what makes Monaco underline a symbol on Ctrl-hover and ask
 *   where it lives. Registered for every language Monaco knows, because the lookup is textual and
 *   works the same in all of them;
 * - an **editor opener**, because a standalone Monaco cannot navigate to a model it isn't showing.
 *   Without it, a definition in another file silently does nothing. This hands the location back
 *   to the app, which opens the file in the focused editor group like any other jump.
 */
export function installGoToDefinition() {
  if (installed) return;
  installed = true;

  monaco.languages.registerDefinitionProvider(
    monaco.languages.getLanguages().map((language) => language.id),
    {
      provideDefinition: (model, position) =>
        findDefinition(model, position).catch(() => null) as monaco.languages.ProviderResult<monaco.languages.Definition>,
    },
  );

  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (!context || resource.scheme !== MODEL_SCHEME) return false;
      const path = relPathFromModelUri(resource, context.project.id);
      if (!path) return false;
      const line =
        selectionOrPosition && "startLineNumber" in selectionOrPosition
          ? selectionOrPosition.startLineNumber
          : (selectionOrPosition?.lineNumber ?? 1);
      const column =
        selectionOrPosition && "startColumn" in selectionOrPosition
          ? selectionOrPosition.startColumn
          : (selectionOrPosition?.column ?? 1);
      context.open(path, line, column);
      // Claiming the navigation even when the target is the file already open: the app's own
      // reveal puts the caret there, and returning false would make Monaco fall back to doing
      // nothing at all.
      return true;
    },
  });
}
