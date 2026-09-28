import { invoke } from "@tauri-apps/api/core";
import { readEditorFile, writeEditorFile, type DiskVersion } from "./tauri/commands";
import { isChangedOnDisk } from "./editorFiles";
import type { LspTextEdit, LspWorkspaceEdit } from "./lsp/protocol";

/**
 * A rename's edits, pointed at this repository's files — and the one way they are applied.
 *
 * # Why this exists
 *
 * Monaco applies a rename through its bulk-edit service, and the standalone build of that service
 * edits **models only**: a `WorkspaceEdit` naming a file with no model throws `bad edit - model not
 * found` and the whole rename is refused. Nine files use the symbol, one is open, nothing changes.
 * The language servers were answering correctly the entire time; the edits simply had nowhere to
 * land.
 *
 * So a rename no longer goes back to Monaco at all. The provider plans the edit here and applies it
 * itself, and the plan is split by where each file lives:
 *
 * - **An open tab** is edited in its buffer — its Monaco model when it has one, so the change is one
 *   Ctrl+Z away and the language servers hear about it through the ordinary document sync. Nothing
 *   is written; the tab goes dirty, exactly as if the user had typed the new name there.
 * - **Any other file** is edited on disk, through the editor's checked write: read with its version,
 *   edited, written back only if it is still that version. A file an agent or a pull rewrote in
 *   between is reported as a conflict, never overwritten.
 *
 * Before the first disk write the working tree is checkpointed (`git/checkpoint.rs`), so a rename
 * that went wider than expected can be put back as a unit from the restore-points list.
 *
 * Positions everywhere below are Monaco's: 1-based lines, 1-based UTF-16 columns — which is also
 * what JavaScript strings index by, so a column is an offset into the line with no conversion.
 */

export interface TextRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface TextEdit {
  range: TextRange;
  text: string;
}

export interface FileEdits {
  /** Repo-relative, forward-slashed — the key every tab is filed under. */
  path: string;
  edits: TextEdit[];
}

/** An edit, pointed at the repository. */
export interface EditPlan {
  files: FileEdits[];
  /** Files the edit named outside the repository: dependencies, the standard library. Never
   *  written — there is no tab to show the change in and no restore point that covers it. */
  outside: string[];
  /** File creations, renames and deletions, which this editor does not perform. */
  unsupported: number;
}

/** How many single edits a plan makes, across every file. */
export function editCount(plan: { files: FileEdits[] }): number {
  return plan.files.reduce((sum, file) => sum + file.edits.length, 0);
}

function lspToRange(edit: LspTextEdit): TextEdit {
  return {
    range: {
      startLineNumber: edit.range.start.line + 1,
      startColumn: edit.range.start.character + 1,
      endLineNumber: edit.range.end.line + 1,
      endColumn: edit.range.end.character + 1,
    },
    text: edit.newText,
  };
}

/** Collects edits by path, in the order the answer named them, merging a file named twice. */
function collect(
  entries: { target: string; path: string | null; edits: TextEdit[] }[],
  unsupported: number,
): EditPlan {
  const byPath = new Map<string, TextEdit[]>();
  const outside = new Set<string>();
  for (const entry of entries) {
    if (entry.path === null) {
      if (entry.edits.length > 0) outside.add(entry.target);
      continue;
    }
    if (entry.edits.length === 0) continue;
    const list = byPath.get(entry.path) ?? [];
    list.push(...entry.edits);
    byPath.set(entry.path, list);
  }
  return {
    files: [...byPath].map(([path, edits]) => ({ path, edits })),
    outside: [...outside],
    unsupported,
  };
}

/**
 * An LSP `WorkspaceEdit` as a plan. Both of its shapes: `documentChanges` (with versions, and
 * possibly file operations, which are refused) and the older `changes` map.
 */
export function planLspEdit(edit: LspWorkspaceEdit, relPathOf: (uri: string) => string | null): EditPlan {
  let unsupported = 0;
  const entries: { target: string; path: string | null; edits: TextEdit[] }[] = [];
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if (!("textDocument" in change)) {
        unsupported += 1;
        continue;
      }
      const uri = change.textDocument.uri;
      entries.push({ target: uri, path: relPathOf(uri), edits: change.edits.map(lspToRange) });
    }
  } else {
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
      entries.push({ target: uri, path: relPathOf(uri), edits: edits.map(lspToRange) });
    }
  }
  return collect(entries, unsupported);
}

/** One place tsserver's `rename` says the symbol occurs. `prefixText`/`suffixText` are there when
 *  the rename has to keep a shorthand working — `{ foo }` becoming `{ foo: bar }`. */
export interface TsRenameLocation {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  prefixText?: string;
  suffixText?: string;
}

export interface TsRenameGroup {
  /** Absolute path, as tsserver spells it. */
  file: string;
  locs: TsRenameLocation[];
}

/** tsserver's `rename` answer as a plan. Its positions are already Monaco's: 1-based `line`, and
 *  `offset` a 1-based column. */
export function planTsRename(
  groups: TsRenameGroup[],
  newName: string,
  relPathOf: (file: string) => string | null,
): EditPlan {
  return collect(
    groups.map((group) => ({
      target: group.file,
      path: relPathOf(group.file),
      edits: group.locs.map((loc) => ({
        range: {
          startLineNumber: loc.start.line,
          startColumn: loc.start.offset,
          endLineNumber: loc.end.line,
          endColumn: loc.end.offset,
        },
        text: `${loc.prefixText ?? ""}${newName}${loc.suffixText ?? ""}`,
      })),
    })),
    0,
  );
}

/** Where each line of `text` starts, as offsets — broken on `\r\n`, `\n` and `\r` alike, which is
 *  how both LSP and Monaco count lines. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      starts.push(i + 1);
    } else if (code === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** The offset of a Monaco position. A column past the end of its line is the end of that line
 *  (LSP's own rule), and a line past the last is the end of the text — the `{ line: lineCount }`
 *  some servers use for "the end of the document". */
function offsetAt(text: string, starts: number[], line: number, column: number): number {
  if (line < 1 || column < 1) throw new Error(`invalid position ${line}:${column}`);
  if (line > starts.length) return text.length;
  const start = starts[line - 1];
  let end = line < starts.length ? starts[line] : text.length;
  // The line's own text, without its terminator.
  while (end > start && (text.charCodeAt(end - 1) === 10 || text.charCodeAt(end - 1) === 13)) end -= 1;
  return Math.min(start + column - 1, end);
}

/**
 * `edits` applied to `text`. Throws on edits that overlap — two servers' answers merged, or an
 * answer for a different version of the file — rather than guess which one wins.
 *
 * Edits at the same position are inserted in the order given, which is the LSP rule.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const starts = lineStarts(text);
  const spans = edits
    .map((edit, order) => ({
      start: offsetAt(text, starts, edit.range.startLineNumber, edit.range.startColumn),
      end: offsetAt(text, starts, edit.range.endLineNumber, edit.range.endColumn),
      text: edit.text,
      order,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
  for (let i = 0; i < spans.length; i += 1) {
    if (spans[i].end < spans[i].start) throw new Error("an edit ends before it starts");
    if (i > 0 && spans[i].start < spans[i - 1].end) throw new Error("overlapping edits");
  }
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + span.text;
    at = span.end;
  }
  return out + text.slice(at);
}

/**
 * Where each edit's replacement starts once all of them are applied, in the order given — what
 * the summary lists, so a click lands on the new name rather than on where the old one used to be.
 */
export function positionsAfter(edits: TextEdit[]): { lineNumber: number; column: number }[] {
  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort(
      (a, b) =>
        a.edit.range.startLineNumber - b.edit.range.startLineNumber ||
        a.edit.range.startColumn - b.edit.range.startColumn ||
        a.index - b.index,
    );
  const out: { lineNumber: number; column: number }[] = new Array(edits.length);
  let lineDelta = 0;
  // The column shift still in force: the line (in the old text) the last edit ended on, and how
  // far it moved what followed it on that line.
  let shiftLine = -1;
  let columnDelta = 0;
  for (const { edit, index } of sorted) {
    const { startLineNumber, startColumn, endLineNumber, endColumn } = edit.range;
    const column = startLineNumber === shiftLine ? startColumn + columnDelta : startColumn;
    const lineNumber = startLineNumber + lineDelta;
    out[index] = { lineNumber, column };
    const inserted = edit.text.split(/\r\n|\r|\n/);
    lineDelta += inserted.length - 1 - (endLineNumber - startLineNumber);
    const endColumnAfter =
      inserted.length === 1 ? column + inserted[0].length : inserted[inserted.length - 1].length + 1;
    shiftLine = endLineNumber;
    columnDelta = endColumnAfter - endColumn;
  }
  return out;
}

/** The text of a line, 1-based, trimmed — what a result row shows beside its position. */
export function lineText(text: string, lineNumber: number): string {
  const starts = lineStarts(text);
  if (lineNumber < 1 || lineNumber > starts.length) return "";
  const end = lineNumber < starts.length ? starts[lineNumber] : text.length;
  return text.slice(starts[lineNumber - 1], end).replace(/[\r\n]+$/, "").trim();
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * What the editor offers a workspace edit: its open tabs. Registered by `EditorView` per project,
 * the way the notebooks reach their tabs (`lib/notebook/host`) — the providers that plan a rename
 * are installed once for the whole app and cannot close over a component.
 */
export interface WorkspaceEditHost {
  /** Whether a tab holds this file. Its buffer is what gets edited then, never the disk. */
  isOpen: (path: string) => boolean;
  /**
   * Applies edits to an open tab — its model when it has one, the tab's text otherwise — and
   * answers with the text it now holds, or throws why it could not (a read-only tab, a notice, a
   * buffer the server could not have seen).
   */
  applyToOpen: (path: string, edits: TextEdit[]) => string;
}

const hosts = new Map<string, WorkspaceEditHost>();

export function registerWorkspaceEditHost(repoPath: string, host: WorkspaceEditHost): () => void {
  hosts.set(repoPath, host);
  return () => {
    if (hosts.get(repoPath) === host) hosts.delete(repoPath);
  };
}

/** Everything the apply step touches outside this module, injectable so it can be tested without
 *  a backend. */
export interface ApplyDeps {
  host: WorkspaceEditHost | null;
  /** The file as text with the version it was read at, or `null` when it is not UTF-8 text. */
  read: (path: string) => Promise<{ text: string; version: DiskVersion } | null>;
  /** The checked write — rejects with `changed-on-disk:` when the file is no longer `version`. */
  write: (path: string, text: string, version: DiskVersion) => Promise<void>;
  /** A restore point of the working tree; `null` when the repository cannot take one. */
  checkpoint: () => Promise<string | null>;
}

export interface AppliedFile {
  path: string;
  /** Where each of the file's edits landed, in the text it holds now. */
  at: { lineNumber: number; column: number; text: string }[];
  /** `true` when the change went into an open tab's buffer, which still has to be saved. */
  inBuffer: boolean;
}

export interface ApplyOutcome {
  applied: AppliedFile[];
  changes: number;
  /** Changed on disk between being read and being written — left as they were. */
  conflicts: string[];
  failed: { path: string; error: string }[];
  checkpointId: string | null;
}

function appliedFile(path: string, edits: TextEdit[], text: string, inBuffer: boolean): AppliedFile {
  return {
    path,
    inBuffer,
    at: positionsAfter(edits).map((position) => ({ ...position, text: lineText(text, position.lineNumber) })),
  };
}

export function defaultApplyDeps(repoPath: string): ApplyDeps {
  return {
    host: hosts.get(repoPath) ?? null,
    read: async (path) => {
      const file = await readEditorFile(repoPath, path);
      return file.kind === "text" ? { text: file.text, version: file.version } : null;
    },
    write: async (path, text, version) => {
      await writeEditorFile(repoPath, path, text, version);
    },
    checkpoint: () => invoke<string>("create_editor_checkpoint", { repoPath }).catch(() => null),
  };
}

/**
 * Applies a plan: open tabs in their buffers, every other file on disk through the checked write,
 * after a checkpoint. One file failing never stops the rest — a rename that could not reach one
 * file is reported with that file named, and the others keep their change.
 */
export async function applyEditPlan(plan: EditPlan, deps: ApplyDeps): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { applied: [], changes: 0, conflicts: [], failed: [], checkpointId: null };
  const open = plan.files.filter((file) => deps.host?.isOpen(file.path));
  const closed = plan.files.filter((file) => !deps.host?.isOpen(file.path));

  for (const file of open) {
    try {
      const text = deps.host!.applyToOpen(file.path, file.edits);
      outcome.applied.push(appliedFile(file.path, file.edits, text, true));
      outcome.changes += file.edits.length;
    } catch (e) {
      outcome.failed.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (closed.length > 0) outcome.checkpointId = await deps.checkpoint();
  for (const file of closed) {
    try {
      const current = await deps.read(file.path);
      if (!current) {
        outcome.failed.push({ path: file.path, error: "not a UTF-8 text file" });
        continue;
      }
      const next = applyTextEdits(current.text, file.edits);
      await deps.write(file.path, next, current.version);
      outcome.applied.push(appliedFile(file.path, file.edits, next, false));
      outcome.changes += file.edits.length;
    } catch (e) {
      if (isChangedOnDisk(e)) outcome.conflicts.push(file.path);
      else outcome.failed.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcome;
}
