import type * as monaco from "monaco-editor";
import { modelPathForId } from "../editorModel";

/**
 * LSP's shapes, and the arithmetic that turns them into Monaco's.
 *
 * Two conversions live here and both are the kind that fail quietly rather than loudly.
 *
 * **Positions are 0-based in LSP and 1-based in Monaco, on *both* axes.** Getting it wrong does not
 * throw — it returns completions for the character before the caret, hovers for the line above, and
 * a rename that eats the first letter of the symbol. The `to*`/`from*` pairs below are the only
 * place the ±1 is written, so there is one place to be right.
 *
 * **Servers answer with `file://` URIs, and nothing in this app can open one.** Models are addressed
 * as `cf-editor:/<projectId>/<relPath>` and the editor opener in `lib/goToDefinition` turns down
 * anything else, so a definition answered as `file:///…` navigates nowhere at all and does it
 * silently. `modelUriFor` is what makes "go to definition" arrive somewhere; it is the same lesson
 * `useTypeScript` records, in the same words, for the same reason.
 */

// ---------------------------------------------------------------------------
// The wire shapes this app reads back
// ---------------------------------------------------------------------------

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** `textDocument/definition` may answer with a `LocationLink` instead, which names the range twice:
 *  `targetRange` is the whole declaration, `targetSelectionRange` just its name. */
export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

export interface LspMarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface LspDiagnostic {
  range: LspRange;
  /** 1 error · 2 warning · 3 information · 4 hint. Absent means error, per the spec. */
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  /** 1 unnecessary · 2 deprecated. */
  tags?: number[];
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /** 1 plain text · 2 snippet. */
  insertTextFormat?: 1 | 2;
  textEdit?: LspTextEdit | { range: LspRange; newText: string; insert?: LspRange; replace?: LspRange };
  additionalTextEdits?: LspTextEdit[];
  /** Round-tripped untouched to `completionItem/resolve`. */
  data?: unknown;
  preselect?: boolean;
  deprecated?: boolean;
}

export interface LspCompletionList {
  isIncomplete?: boolean;
  items: LspCompletionItem[];
}

export interface LspHover {
  contents: string | LspMarkupContent | (string | LspMarkupContent)[];
  range?: LspRange;
}

export interface LspSignatureHelp {
  signatures: {
    label: string;
    documentation?: string | LspMarkupContent;
    parameters?: { label: string | [number, number]; documentation?: string | LspMarkupContent }[];
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: { textDocument: { uri: string; version?: number | null }; edits: LspTextEdit[] }[];
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Monaco → LSP. Both axes lose one. */
export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** LSP → Monaco, as the four numbers `IRange` wants. */
export function toMonacoRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// ---------------------------------------------------------------------------
// URIs
// ---------------------------------------------------------------------------

/** The `file://` URI for a repo-relative path — what every request has to carry. */
export function fileUriFor(repoPath: string, relPath: string): string {
  const root = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const absolute = `${root}/${relPath}`.replace(/\\/g, "/");
  // `encodeURIComponent` leaves `!'()*` alone; `path_to_uri` in `lsp.rs` escapes everything outside
  // `A-Za-z0-9-_.~`. Two functions naming the same filesystem and disagreeing on five characters is
  // not academic: Rust builds `rootUri` and the workspace folders, this builds every document URI,
  // so a repo at `~/Documents (work)/api` was announced with `%28work%29` and its buffers arrived
  // with `(work)`. A server deciding "is this file in the workspace" by URI prefix sees every open
  // buffer as outside it. Rust is the stricter of the two, so this widens to match it.
  const encoded = absolute
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return absolute.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * A `file://` URI from a server, as a model this app can actually open — or `null`.
 *
 * Anything outside the repository is dropped rather than mapped to a path that would resolve
 * somewhere else: there is no tab this app could open for it, and that is the common case here in
 * a way it is not for `tsserver`. A Rust definition lands in `~/.cargo/registry`, a Go one in
 * `$GOPATH/pkg/mod`, a Python one in `site-packages` — all outside the repo, all real answers this
 * editor has nowhere to put. Returning `null` leaves the jump undone, which is honest; returning a
 * URI nothing can open would leave a click that silently does nothing.
 */
export function modelUriFor(
  monacoApi: typeof monaco,
  projectId: string,
  repoPath: string,
  uri: string,
): monaco.Uri | null {
  if (!uri.startsWith("file://")) return null;
  const root = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  } catch {
    return null;
  }
  // A drive-letter path arrives as `/C:/repo/…`; the leading slash is the URI's, not the path's.
  const normalized = /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  if (!normalized.startsWith(`${root}/`)) return null;
  return monacoApi.Uri.parse(modelPathForId(projectId, normalized.slice(root.length + 1)));
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * LSP's `CompletionItemKind` (1–25) as Monaco's, which is a different enum with different numbers
 * for the same ideas. Indexed by the LSP value, so the array's holes are LSP's 0.
 *
 * Written as names rather than numbers: Monaco's enum has renumbered between versions, and the one
 * thing worse than a wrong icon is a wrong icon that used to be right.
 */
const COMPLETION_KIND: (keyof typeof monaco.languages.CompletionItemKind)[] = [
  "Text", "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface",
  "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference",
  "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter",
];

export function toMonacoCompletionKind(monacoApi: typeof monaco, kind: number | undefined): number {
  const name = COMPLETION_KIND[kind ?? 1] ?? "Text";
  return monacoApi.languages.CompletionItemKind[name];
}

/** LSP severity (1 error … 4 hint) as a Monaco `MarkerSeverity`. Absent means error, per the spec. */
export function toMonacoSeverity(monacoApi: typeof monaco, severity: number | undefined): number {
  switch (severity) {
    case 2:
      return monacoApi.MarkerSeverity.Warning;
    case 3:
      return monacoApi.MarkerSeverity.Info;
    case 4:
      return monacoApi.MarkerSeverity.Hint;
    default:
      return monacoApi.MarkerSeverity.Error;
  }
}

const SYMBOL_KIND: (keyof typeof monaco.languages.SymbolKind)[] = [
  "File", "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
  "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String", "Number",
  "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct", "Event", "Operator",
  "TypeParameter",
];

export function toMonacoSymbolKind(monacoApi: typeof monaco, kind: number | undefined): number {
  const name = SYMBOL_KIND[kind ?? 1] ?? "File";
  return monacoApi.languages.SymbolKind[name];
}

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

/**
 * Whatever a server sent as documentation, as one markdown string.
 *
 * `supportHtml` is deliberately off. The value is text a language server produced from a doc
 * comment in the user's own repository, which is not a reason to let it render markup in the
 * editor's chrome.
 */
export function toMarkdown(
  value: string | LspMarkupContent | (string | LspMarkupContent)[] | undefined,
): monaco.IMarkdownString | undefined {
  if (!value) return undefined;
  const parts = (Array.isArray(value) ? value : [value]).map((part) =>
    typeof part === "string" ? part : part.value,
  );
  const text = parts.filter(Boolean).join("\n\n").trim();
  return text ? { value: text, isTrusted: false, supportHtml: false } : undefined;
}
