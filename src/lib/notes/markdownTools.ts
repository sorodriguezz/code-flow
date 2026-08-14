import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditorNS, Selection } from "monaco-editor";

/**
 * What the formatting toolbar does to the text.
 *
 * **Everything here goes through `executeEdits`, never `setValue`.** That is the whole reason this
 * module exists rather than a handful of string splices: `setValue` replaces the model, which
 * throws away Monaco's undo stack. A user who presses Bold and then Ctrl-Z expects the bold to come
 * off — not to find the last twenty minutes of typing collapsed into one un-undoable step. Every
 * operation below is one edit and therefore one undo step.
 *
 * The operations **toggle**. Pressing Bold on already-bold text takes it off, and pressing List on
 * a list unlists it. That is what every editor with a Markdown toolbar does, and the alternative —
 * a button that only ever adds marks — makes `****text****` a normal outcome of pressing a button
 * twice.
 *
 * The module knows about Monaco and nothing about React, so a toolbar button is a call and the
 * component holds no formatting logic.
 */

export type MarkdownTool =
  /** Marks either side of the selection: bold, italic, code, strikethrough. */
  | { kind: "wrap"; before: string; after: string }
  /** A prefix on every selected line: headings, quotes, lists, tasks. */
  | { kind: "line"; prefix: string }
  /** A numbered list, which is a line prefix that counts. */
  | { kind: "ordered" }
  /** A block dropped in whole: a table, a rule, a fenced block. `select` is the substring to leave
   *  selected so the user can type over it. */
  | { kind: "block"; text: string; select?: string }
  /** `[selection](url)` — or `[](url)` with the caret in the label when nothing is selected. */
  | { kind: "link" }
  | { kind: "image" }
  /** The opening half of a `[[note]]` reference, selection included as the title typed so far. */
  | { kind: "noteLink" };

/** Applies `tool` to whatever is selected, then puts the caret back somewhere useful. */
export function applyTool(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  monaco: Monaco,
  tool: MarkdownTool,
): void {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;

  switch (tool.kind) {
    case "wrap":
      applyWrap(editor, monaco, model, selection, tool.before, tool.after);
      break;
    case "line":
      applyLinePrefix(editor, monaco, model, selection, tool.prefix);
      break;
    case "ordered":
      applyOrdered(editor, monaco, model, selection);
      break;
    case "block":
      applyBlock(editor, monaco, model, selection, tool.text, tool.select);
      break;
    case "link":
    case "image":
      applyLink(editor, monaco, model, selection, tool.kind === "image");
      break;
    case "noteLink":
      applyNoteLink(editor, model, selection);
      break;
  }
  editor.focus();
}

// ---------------------------------------------------------------------------

function applyWrap(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  monaco: Monaco,
  model: MonacoEditorNS.ITextModel,
  selection: Selection,
  before: string,
  after: string,
): void {
  const selected = model.getValueInRange(selection);

  // Already wrapped *inside* the selection — the user selected `**word**` and pressed Bold.
  if (selected.length >= before.length + after.length &&
      selected.startsWith(before) && selected.endsWith(after)) {
    const stripped = selected.slice(before.length, selected.length - after.length);
    editor.executeEdits("md-tool", [{ range: selection, text: stripped }]);
    selectAfter(editor, monaco, selection, "", stripped);
    return;
  }

  // Already wrapped *around* the selection — the user selected `word` inside `**word**`. Checked
  // against the model rather than the selection, which is the case that actually happens: you
  // double-click the word, not the marks.
  const outer = surrounding(model, selection, before, after);
  if (outer) {
    editor.executeEdits("md-tool", [{ range: outer, text: selected }]);
    // `surrounding` is single-line by construction, so the plain column is correct here.
    editor.setSelection(
      new monaco.Selection(
        outer.startLineNumber,
        outer.startColumn,
        outer.startLineNumber,
        outer.startColumn + selected.length,
      ),
    );
    return;
  }

  const text = `${before}${selected}${after}`;
  editor.executeEdits("md-tool", [{ range: selection, text }]);
  // Inside the marks when there was nothing selected, around the text when there was — the same
  // rule the app's other Markdown field uses, and the one every editor teaches. `selected` may span
  // lines, which is why the placement goes through `selectAfter`.
  selectAfter(editor, monaco, selection, before, selected);
}

/** The range covering `before…after` around a selection that sits inside them, or `null`. */
function surrounding(
  model: MonacoEditorNS.ITextModel,
  selection: Selection,
  before: string,
  after: string,
) {
  // Single-line only: marks spanning a line break aren't a thing this needs to detect, and reading
  // two extra lines of model per keystroke of a held-down button is not free.
  if (selection.startLineNumber !== selection.endLineNumber) return null;
  const line = model.getLineContent(selection.startLineNumber);
  const from = selection.startColumn - 1 - before.length;
  const to = selection.endColumn - 1;
  if (from < 0 || to + after.length > line.length) return null;
  if (line.slice(from, from + before.length) !== before) return null;
  if (line.slice(to, to + after.length) !== after) return null;
  return {
    startLineNumber: selection.startLineNumber,
    startColumn: from + 1,
    endLineNumber: selection.startLineNumber,
    endColumn: to + after.length + 1,
  };
}

function applyLinePrefix(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  monaco: Monaco,
  model: MonacoEditorNS.ITextModel,
  selection: Selection,
  prefix: string,
): void {
  const from = selection.startLineNumber;
  const to = selection.endLineNumber;
  const lines: string[] = [];
  for (let line = from; line <= to; line++) lines.push(model.getLineContent(line));

  // Off if every non-blank line already carries it — "every", not "any", so pressing Quote on a
  // half-quoted block finishes the job rather than undoing the half that was done.
  const meaningful = lines.filter((line) => line.trim().length > 0);
  const allPrefixed =
    meaningful.length > 0 && meaningful.every((line) => hasPrefix(line, prefix));

  const next = lines.map((line) => {
    if (allPrefixed) return removePrefix(line, prefix);
    if (line.trim().length === 0) return line;
    // A heading replaces a heading rather than stacking: pressing H2 on an H1 line should give an
    // H2, not `## # Title`. Only within the same family — a `>` in front of a `- ` is a quoted
    // list, which is a real construct and must survive.
    const base = family(prefix) === "heading" ? stripHeading(line) : line;
    return hasPrefix(base, prefix) ? base : `${prefix}${base}`;
  });

  replaceLines(editor, monaco, from, to, next, model);
}

function applyOrdered(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  monaco: Monaco,
  model: MonacoEditorNS.ITextModel,
  selection: Selection,
): void {
  const from = selection.startLineNumber;
  const to = selection.endLineNumber;
  const lines: string[] = [];
  for (let line = from; line <= to; line++) lines.push(model.getLineContent(line));

  const numbered = /^(\s*)\d+[.)]\s+/;
  const meaningful = lines.filter((line) => line.trim().length > 0);
  const allNumbered = meaningful.length > 0 && meaningful.every((line) => numbered.test(line));

  let counter = 0;
  const next = lines.map((line) => {
    if (allNumbered) return line.replace(numbered, "$1");
    if (line.trim().length === 0) return line;
    counter++;
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    // Renumbered from 1 across the selection rather than continuing whatever was above it: the
    // user asked for *this* block to be a list, and Markdown renumbers on render anyway.
    return `${indent}${counter}. ${line.slice(indent.length)}`;
  });

  replaceLines(editor, monaco, from, to, next, model);
}

function applyBlock(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  monaco: Monaco,
  model: MonacoEditorNS.ITextModel,
  selection: Selection,
  text: string,
  toSelect?: string,
): void {
  const line = model.getLineContent(selection.startLineNumber);
  // A block needs its own line. Inserted after a blank one when the caret is mid-text, so a table
  // dropped into the middle of a paragraph doesn't become part of it.
  const needsBreak = line.slice(0, selection.startColumn - 1).trim().length > 0;
  const body = needsBreak ? `\n\n${text}` : text;

  editor.executeEdits("md-tool", [{ range: selection, text: body }]);

  if (!toSelect) {
    editor.setPosition({
      lineNumber: selection.startLineNumber + countLines(body),
      column: 1,
    });
    return;
  }

  // Where the placeholder landed, found in the text just written rather than computed from it.
  selectAfter(editor, monaco, selection, body.slice(0, body.indexOf(toSelect)), toSelect);
}

function applyLink(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  monaco: Monaco,
  model: MonacoEditorNS.ITextModel,
  selection: Selection,
  image: boolean,
): void {
  const selected = model.getValueInRange(selection);
  const bang = image ? "!" : "";

  /**
   * A selection that is already a URL becomes the *target*, not the label — pasting a link and
   * pressing the button is the commonest way this gets used, and putting the URL in the label is
   * the wrong half of the answer.
   *
   * **Images accept `http(s)` only; links also accept a path.** A note is stored in the database
   * and nothing else about it lives on disk, so an image pointed at `./diagram.png` renders until
   * the day that file moves and travels with no backup — a broken picture on another machine, with
   * nothing in the note explaining why. A link to a local path is a different matter: it is
   * understood as a reference to something on *this* machine and reads as one.
   */
  const target = selected.trim();
  const isUrl = image
    ? /^https?:\/\/\S+$/i.test(target)
    : /^(https?:\/\/|mailto:|\/|\.\/|\.\.\/)\S*$/i.test(target);
  // The placeholder says what belongs there. `url` was ambiguous enough that a local path looked
  // like a reasonable answer to it; `https://` is not.
  const placeholder = image ? "https://" : "url";
  const text = isUrl
    ? `${bang}[](${target})`
    : `${bang}[${selected}](${placeholder})`;
  editor.executeEdits("md-tool", [{ range: selection, text }]);

  if (isUrl) {
    // Caret in the empty label, which is the one thing left to type. Single-line by definition —
    // a URL with a newline in it is not a URL.
    editor.setPosition({
      lineNumber: selection.startLineNumber,
      column: selection.startColumn + bang.length + 1,
    });
    return;
  }
  // Otherwise the placeholder is selected, so typing replaces it. `selected` may span lines — see
  // `selectAfter`.
  selectAfter(editor, monaco, selection, `${bang}[${selected}](`, placeholder);
}

/**
 * Opens a `[[reference]]` to another note and hands off to the same picker a hand-typed `[[`
 * opens — `NoteMonaco`'s completion provider, triggered directly rather than left for the user to
 * find on their own.
 *
 * **Deliberately left unclosed.** The provider replaces everything between the `[[` and the caret
 * with `Title]]` when a suggestion is accepted (see its `insertText`), so writing the closing
 * bracket here as well would double it the moment a suggestion lands — `[[Title]]]]`. A selection
 * becomes the filter the picker opens with, which also means it becomes the title typed so far, not
 * wrapped text sitting next to a search box.
 */
function applyNoteLink(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  model: MonacoEditorNS.ITextModel,
  selection: Selection,
): void {
  const selected = model.getValueInRange(selection);
  editor.executeEdits("md-tool", [{ range: selection, text: `[[${selected}` }]);

  // Single-line by construction — a note title is not a thing anyone is typing across a line
  // break — so the caret is just past `[[` plus whatever was selected.
  const lastBreak = selected.lastIndexOf("\n");
  editor.setPosition({
    lineNumber: selection.startLineNumber + countLines(selected),
    column:
      lastBreak === -1 ? selection.startColumn + 2 + selected.length : selected.length - lastBreak + 2,
  });

  editor.trigger("md-tool", "editor.action.triggerSuggest", {});
}

// ---------------------------------------------------------------------------

/** One edit spanning the whole block, so the change is one undo step rather than one per line. */
function replaceLines(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  monaco: Monaco,
  from: number,
  to: number,
  lines: string[],
  model: MonacoEditorNS.ITextModel,
): void {
  const range = new monaco.Range(from, 1, to, model.getLineMaxColumn(to));
  editor.executeEdits("md-tool", [{ range, text: lines.join("\n") }]);
  editor.setSelection(new monaco.Selection(from, 1, to, lines[lines.length - 1].length + 1));
}

/**
 * Selects `text`, given the text inserted before it and where the insert started.
 *
 * The arithmetic is the part that was wrong twice: `startColumn + offset` is only a valid column
 * while `before` contains no newline. With a multi-line selection — select two lines, press Link —
 * the placeholder lands on a *later* line, the computed column runs past the end of the first one,
 * and Monaco clamps the selection to an empty caret somewhere inside the label. The first keystroke
 * then corrupts the link instead of replacing `url`.
 *
 * So the line is counted out of `before` and the column is measured from its last newline, exactly
 * as `applyBlock` already did.
 */
function selectAfter(
  editor: MonacoEditorNS.IStandaloneCodeEditor,
  monaco: Monaco,
  selection: Selection,
  before: string,
  text: string,
): void {
  const lineNumber = selection.startLineNumber + countLines(before);
  const lastBreak = before.lastIndexOf("\n");
  const column =
    lastBreak === -1 ? selection.startColumn + before.length : before.length - lastBreak;
  editor.setSelection(new monaco.Selection(lineNumber, column, lineNumber, column + text.length));
}

/**
 * Whether a line already carries `prefix`, allowing for leading indentation.
 *
 * The task prefix is the one that needs more than a `startsWith`: `- [ ] ` and `- [x] ` are the
 * same construct in two states, so a checked item has to read as *already a task* — otherwise
 * pressing the task button on `- [x] done` prepends a second box and produces
 * `- [ ] - [x] done`.
 */
function hasPrefix(line: string, prefix: string): boolean {
  const rest = line.trimStart();
  if (isTaskPrefix(prefix)) return TASK_MARK.test(rest);
  return rest.startsWith(prefix);
}

function removePrefix(line: string, prefix: string): string {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const rest = line.slice(indent.length);
  if (isTaskPrefix(prefix)) {
    const mark = TASK_MARK.exec(rest);
    // Back to a plain bullet, not to bare text: unchecking "task" on a list item should leave the
    // list item, which is what the button below it is for.
    return mark ? `${indent}- ${rest.slice(mark[0].length)}` : line;
  }
  return rest.startsWith(prefix) ? indent + rest.slice(prefix.length) : line;
}

/** `- [ ] ` or `- [x] ` at the start of a line, in either case. */
const TASK_MARK = /^[-*+] \[[ xX]\] /;

function isTaskPrefix(prefix: string): boolean {
  return TASK_MARK.test(prefix);
}

function stripHeading(line: string): string {
  return line.replace(/^(\s*)#{1,6}\s+/, "$1");
}

/** Which prefixes replace each other. Only headings do; everything else stacks. */
function family(prefix: string): "heading" | "other" {
  return /^#{1,6}\s$/.test(prefix) ? "heading" : "other";
}

function countLines(text: string): number {
  let count = 0;
  for (const character of text) if (character === "\n") count++;
  return count;
}
