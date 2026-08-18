import { invoke } from "@tauri-apps/api/core";

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

/** `open`, `change`, `close` — the ones tsserver never replies to. */
export const tsNotify = (command: string, args: unknown) =>
  invoke<void>("ts_notify", { command, arguments: args });

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

/** Flattens tsserver's part list into the text a tooltip shows. */
export const partsToText = (parts?: TsSymbolDisplayPart[]) =>
  (parts ?? []).map((part) => part.text).join("");

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
