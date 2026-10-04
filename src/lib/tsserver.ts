import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relPathFromModelUri } from "./editorModel";
import type { TsRenameGroup } from "./workspaceEdit";

/**
 * The thin half of the TypeScript language service: the protocol, and nothing about editors.
 *
 * `tsserver`'s own commands are the interface — there is no adapter layer here, deliberately. It
 * speaks about forty commands and wrapping each in a typed Rust function would be a great deal of
 * code that adds no safety over the shapes below, which are the ones this app actually reads. The
 * backend is transport; the meaning lives here and in `useTypeScript`.
 *
 * **Positions are 1-based on both axes.** Monaco's columns are 1-based and its lines are too, so the
 * two happen to agree — but tsserver calls the column `offset`, and reading that as 0-based is the
 * classic way to get completions for the character before the caret.
 */

/** Starts the server for a repository. Resolves with the `tsserver.js` that answered. */
export const tsStart = (repoPath: string) => invoke<string>("ts_start", { repoPath });

/** The repository a server is running for, or `null`. */
export const tsStatus = () => invoke<string | null>("ts_status");

export const tsStop = () => invoke<void>("ts_stop");

/** A request that expects an answer. Rejects on timeout and on a refusal from the server. */
export const tsRequest = <T>(command: string, args: unknown) =>
  invoke<T>("ts_request", { command, arguments: args });

/** `open`, `change`, `close` — the ones tsserver never replies to — and `geterr`/`geterrForProject`,
 *  which reply only with events. Resolves with the message's `seq`, the number the closing
 *  `requestCompleted` event names. */
export const tsNotify = (command: string, args: unknown) =>
  invoke<number>("ts_notify", { command, arguments: args });

/**
 * Every `open` and `change` handed to the server so far, settled.
 *
 * A notification resolves once it is on its way to the server's stdin (`ts_notify`), and the two
 * commands are separate invokes: a request made the instant after a buffer was edited has no
 * promise of travelling behind the edit. That is harmless for a completion — the next keystroke asks
 * again — and wrong for anything that acts on the answer. A refactor that extracts a function and
 * then asks where to rename it must ask about the text with the function in it.
 */
let synced: Promise<unknown> = Promise.resolve();

/** `tsNotify` for the document sync, remembered so `tsSynced` can wait on it. */
export function tsSyncNotify(command: "open" | "change", args: unknown): Promise<number> {
  const sent = tsNotify(command, args);
  // Settled to nothing, so the chain holds no values: one link per keystroke for a whole session
  // would otherwise be a list that only ever grows.
  synced = Promise.all([synced, sent.catch(() => undefined)]).then(() => undefined);
  return sent;
}

/** Resolves once everything the document sync has sent so far is with the server. */
export const tsSynced = (): Promise<void> => synced.then(() => undefined);

/**
 * One event tsserver raised on its own — only the diagnostics ones are forwarded (`tsserver.rs`).
 * `root` is the repository the server was started for: every window hears every event, and a
 * window editing another repository must not take these for its own.
 */
export interface TsEvent {
  root: string;
  event: "syntaxDiag" | "semanticDiag" | "suggestionDiag" | "requestCompleted";
  body: unknown;
}

export const onTsEvent = (handler: (event: TsEvent) => void) =>
  listen<TsEvent>("tsserver:event", (e) => handler(e.payload));

/**
 * The project the running server answers for, and whether it is up — published by `useTypeScript`.
 *
 * Module state rather than the hook's own for the reason `tsOpenFiles` is: the other reader is not
 * a component. Monaco's isolated TypeScript worker is registered at startup (`tsWorkerFallback`)
 * and has to know, per model, whether the compiler is the one answering — so that exactly one of
 * the two ever does.
 */
let served: { repoPath: string; projectId: string } | null = null;
/** The repository the server that is up was started for — not a boolean, because the window can
 *  move to another project while the previous one's server is still the one running. */
let runningRoot: string | null = null;

export function setTsServed(project: { repoPath: string; projectId: string } | null): void {
  served = project;
}

export function tsServedProject(): { repoPath: string; projectId: string } | null {
  return served;
}

/** `root` when a server came up for that repository, `null` when none is running. */
export function setTsRunning(root: string | null): void {
  runningRoot = root;
}

/** The repository the running server belongs to, or `null`. */
export function tsRunningRoot(): string | null {
  return runningRoot;
}

/** Whether a server is up *for the project the editor is showing* — the only one it can answer
 *  about. */
export function tsIsRunning(): boolean {
  return runningRoot !== null && served !== null && served.repoPath === runningRoot;
}

/**
 * The absolute path tsserver holds for a model, or `null` when it is not one of the served
 * project's script files or the server has not been handed it yet.
 *
 * Through `relPathFromModelUri`, because models here are addressed as `cf-editor:/<projectId>/<relPath>`
 * and not by their path on disk — reading `uri.path` directly once pasted the project id into the
 * middle of every path and matched nothing (see `useTypeScript`).
 */
export function tsFileOf(uri: { scheme: string; path: string }): string | null {
  const file = tsCandidateFile(uri);
  return file !== null && tsOpenFiles.has(file) ? file : null;
}

/** Whether the compiler — and not Monaco's isolated worker — answers for this model right now. */
export function tsServes(uri: { scheme: string; path: string }): boolean {
  return tsIsRunning() && tsFileOf(uri) !== null;
}

/** The absolute path a model of the served project *would* have in tsserver, open or not — what the
 *  document sync opens it under. */
export function tsCandidateFile(uri: { scheme: string; path: string }): string | null {
  if (!served) return null;
  const relative = relPathFromModelUri(uri, served.projectId);
  if (!relative || !scriptKind(relative)) return null;
  return tsAbsolute(served.repoPath, relative);
}

/** tsserver's absolute path as a repo-relative one of the served project, or `null` outside it. */
export function tsRelPath(file: string): string | null {
  if (!served) return null;
  const root = served.repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = file.replace(/\\/g, "/");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : null;
}

/**
 * The files handed to the running server, as absolute paths.
 *
 * Module state rather than a ref inside `useTypeScript`, because the other reader is not a
 * component: the text-search "go to definition" in `lib/goToDefinition` is registered once at
 * startup and has to know whether the compiler can answer for a file, so that its own ranked guess
 * stays out of the way when a real answer is available. Emptied when a server restarts — every
 * `open` the previous one was told about died with it.
 */
export const tsOpenFiles = new Set<string>();

/** tsserver wants absolute, forward-slashed paths, and this is the one place that spelling is
 *  decided — the set above is keyed by it, so every caller must build it the same way. */
export const tsAbsolute = (repoPath: string, relPath: string) =>
  `${repoPath}/${relPath}`.replace(/\\/g, "/");

/** Whether the compiler holds this file and can be asked about it. */
export const tsKnows = (repoPath: string, relPath: string) =>
  tsOpenFiles.has(tsAbsolute(repoPath, relPath));

// ---------------------------------------------------------------------------
// The shapes this app reads back
// ---------------------------------------------------------------------------

export interface TsCompletionEntry {
  name: string;
  kind: string;
  /** Sort text tsserver computed. Honoured rather than re-sorted: it is what puts the members of
   *  the type you are on above every global with the same prefix. */
  sortText: string;
  /** Present when accepting this entry means writing an import, which is the whole point of
   *  completing a name from a package that is installed but not yet imported. */
  hasAction?: boolean;
  source?: string;
  data?: unknown;
  insertText?: string;
  isSnippet?: boolean;
  replacementSpan?: TsTextSpan;
}

export interface TsCompletionInfo {
  isMemberCompletion: boolean;
  isNewIdentifierLocation: boolean;
  entries: TsCompletionEntry[];
}

export interface TsTextSpan {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
}

export interface TsSymbolDisplayPart {
  text: string;
  kind: string;
}

export interface TsCodeEdit {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  newText: string;
}

export interface TsFileCodeEdits {
  fileName: string;
  textChanges: TsCodeEdit[];
}

export interface TsCodeAction {
  description: string;
  changes: TsFileCodeEdits[];
}

/**
 * One fix tsserver is offering for a diagnostic — what `getCodeFixes` answers with.
 *
 * A superset of [`TsCodeAction`], which is the shape the same edits arrive in when they ride along
 * with a *completion*. The extra fields are what tell one fix from another: `fixName` is the stable
 * identifier (`"import"` for the auto-import this exists for, `"unusedIdentifier"`, `"fixMissingMember"`…)
 * while `description` is a sentence in the server's own locale and only fit for a menu label.
 *
 * `fixId` and `fixAllDescription` are present on the fixes that can be applied to every occurrence
 * in the file. Carried but unused for now — offering "fix all" needs a second request
 * (`getCombinedCodeFix`), and the one-at-a-time fix is the whole of what Ctrl+. is for.
 */
export interface TsCodeFixAction extends TsCodeAction {
  fixName: string;
  fixId?: string;
  fixAllDescription?: string;
}

export interface TsCompletionDetail {
  name: string;
  displayParts: TsSymbolDisplayPart[];
  documentation?: TsSymbolDisplayPart[];
  /** The import to add. `codeActions` is how auto-import travels. */
  codeActions?: TsCodeAction[];
}

export interface TsQuickInfo {
  displayString: string;
  documentation: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
}

export interface TsDefinition {
  file: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
}

export interface TsDefinitionInfo {
  definitions: TsDefinition[];
  textSpan: TsTextSpan;
}

/**
 * One inlay hint — what `provideInlayHints` answers with.
 *
 * `text` is the whole hint when `displayParts` is absent, and empty when it is present: since TS 5.0
 * (`interactiveInlayHints`) a type arrives as parts, and a part that names a declaration carries its
 * `span`, which is what makes Ctrl+click on the type in a hint go to it.
 */
export interface TsInlayHint {
  text: string;
  position: { line: number; offset: number };
  kind: "Type" | "Parameter" | "Enum";
  whitespaceBefore?: boolean;
  whitespaceAfter?: boolean;
  displayParts?: { text: string; span?: { file: string; start: { line: number; offset: number }; end: { line: number; offset: number } } }[];
}

/** One way to carry out a refactoring — `getApplicableRefactors` lists them under their refactor. */
export interface TsRefactorAction {
  /** The programmatic name, handed back to `getEditsForRefactor`. */
  name: string;
  /** A sentence in the server's locale, fit for a menu row ("Extract to function in module scope"). */
  description: string;
  /** Present when the refactoring exists here but cannot run — said in the menu, greyed out. */
  notApplicableReason?: string;
  /** The dotted code action kind (`refactor.extract.function`). Older servers leave it out. */
  kind?: string;
  /** Needs an argument this editor has no way to ask for (the target file of "Move to file"). */
  isInteractive?: boolean;
}

export interface TsApplicableRefactor {
  name: string;
  description: string;
  actions: TsRefactorAction[];
}

/**
 * What a refactoring does, from `getEditsForRefactor`: its edits, and where to start a rename once
 * they are in — the name an extraction made up (`newFunction`) is the first thing anyone changes.
 */
export interface TsRefactorEditInfo {
  edits: TsFileCodeEdits[];
  renameLocation?: { line: number; offset: number };
  renameFilename?: string;
  notApplicableReason?: string;
}

/** Flattens tsserver's part list into the text a tooltip shows. */
/**
 * One diagnostic, as the `*DiagnosticsSync` commands answer.
 *
 * `reportsUnnecessary` is the interesting field and the reason these are requested at all: it is
 * what TypeScript sets on "declared but never read", and it is exactly the set VS Code fades rather
 * than underlines. The rest is carried so the hover can say *why* a span is dimmed.
 */
export interface TsDiagnostic {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  text: string;
  code?: number;
  category?: string;
  /** Truthy — an empty object in the protocol — when the span is unused rather than wrong. */
  reportsUnnecessary?: unknown;
  reportsDeprecated?: unknown;
}

export const partsToText = (parts?: TsSymbolDisplayPart[]) =>
  (parts ?? []).map((part) => part.text).join("");

/** What a `syntaxDiag`/`semanticDiag`/`suggestionDiag` event carries: one file's whole list of
 *  that kind, which replaces whatever the previous one said about it. */
export interface TsDiagnosticEventBody {
  file: string;
  diagnostics: TsDiagnostic[];
}

/**
 * `rename`'s answer. `info` says whether the symbol can be renamed at all — a keyword, a symbol
 * from a `.d.ts` in `node_modules`, a string literal all say no, with the compiler's own sentence
 * why — and `locs` is every occurrence, grouped by file, across the whole project.
 */
export interface TsRenameResponse {
  info: {
    canRename: boolean;
    localizedErrorMessage?: string;
    displayName?: string;
    triggerSpan?: TsTextSpan;
  };
  locs: TsRenameGroup[];
}

/** One occurrence `references` found. `lineText` is the line it is on — what makes a results
 *  list readable without opening each file. */
export interface TsReferenceEntry {
  file: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  lineText?: string;
  isDefinition?: boolean;
  isWriteAccess?: boolean;
}

export interface TsReferencesResponse {
  refs: TsReferenceEntry[];
  symbolName: string;
}

export interface TsSignatureHelpParameter {
  name: string;
  documentation?: TsSymbolDisplayPart[];
  displayParts: TsSymbolDisplayPart[];
}

export interface TsSignatureHelpItem {
  prefixDisplayParts: TsSymbolDisplayPart[];
  suffixDisplayParts: TsSymbolDisplayPart[];
  separatorDisplayParts: TsSymbolDisplayPart[];
  parameters: TsSignatureHelpParameter[];
  documentation?: TsSymbolDisplayPart[];
}

export interface TsSignatureHelpItems {
  items: TsSignatureHelpItem[];
  selectedItemIndex: number;
  argumentIndex: number;
}

/**
 * A signature as Monaco draws it: the label written out, and each parameter as the `[start, end)`
 * slice of that label it occupies — which is what lets Monaco bold the one being typed even when
 * two parameters share a name with something else in the signature.
 */
export function signatureLabel(item: TsSignatureHelpItem): {
  label: string;
  parameters: { label: [number, number]; documentation: string }[];
} {
  let label = partsToText(item.prefixDisplayParts);
  const separator = partsToText(item.separatorDisplayParts);
  const parameters = item.parameters.map((parameter, index) => {
    if (index > 0) label += separator;
    const start = label.length;
    label += partsToText(parameter.displayParts);
    return { label: [start, label.length] as [number, number], documentation: partsToText(parameter.documentation) };
  });
  label += partsToText(item.suffixDisplayParts);
  return { label, parameters };
}

/**
 * The script kind tsserver should parse a file as.
 *
 * Passed explicitly on `open` rather than left to the extension, because the server otherwise
 * guesses from the filename and a `.js` file in a project with `allowJs` off is then silently not
 * analysed at all — the case where the editor looks like it is simply ignoring you.
 */
export function scriptKind(path: string): "TS" | "TSX" | "JS" | "JSX" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "TSX";
  if (lower.endsWith(".jsx")) return "JSX";
  if (/\.(ts|mts|cts)$/.test(lower)) return "TS";
  if (/\.(js|mjs|cjs)$/.test(lower)) return "JS";
  return null;
}

/**
 * The Monaco language ids this service answers for.
 *
 * Two, not four. `typescriptreact` and `javascriptreact` are **VS Code's** ids and do not exist in
 * Monaco — `lib/monacoLanguage` maps `.tsx` to `typescript` and `.jsx` to `javascript`, which is
 * also what Monaco's own grammars are registered under. Registering against an id nothing produces
 * is a provider that is never consulted.
 */
export const TS_LANGUAGES = ["typescript", "javascript"];
