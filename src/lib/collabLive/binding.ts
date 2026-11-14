import * as Y from "yjs";
import type { editor as MonacoEditorNS, IRange } from "monaco-editor";
import type { LiveDoc } from "./session";
import { deltaToEdits, minimalEdit } from "./text";

/**
 * A Monaco model kept on one text with a live document, and the other people's cursors drawn in
 * every editor showing it.
 *
 * Written here rather than taken from `y-monaco` for one reason: this editor's buffer is a controlled
 * value (`@monaco-editor/react`), so a reload from disk after an agent's turn reaches the model as a
 * single whole-buffer replacement. Passed through as is, that would delete and re-insert the whole
 * text in the shared document, erasing what someone else typed in that instant and throwing every
 * cursor to the end. Here it becomes the smallest replacement (`minimalEdit`) first.
 *
 * Remote changes go in with `pushEditOperations`, so the undo stack stays consistent with the text
 * (an undo may then undo what someone else typed, the way it does in most shared editors).
 */

/** Origin of changes made by typing in this window's model. */
const TYPED = Symbol("cf-live-typed");

/** Files larger than this are not compared whole after every keystroke. */
const CHECK_LIMIT = 512 * 1024;

interface Cursor {
  person?: string;
  nick?: string;
  hue?: number;
  sel?: { a: unknown; h: unknown } | null;
}

export class ModelBinding {
  private applying = false;
  private bound = false;
  private disposed = false;
  private readonly editors = new Map<MonacoEditorNS.IStandaloneCodeEditor, { decorations: MonacoEditorNS.IEditorDecorationsCollection; off: () => void }>();
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly model: MonacoEditorNS.ITextModel,
    readonly live: LiveDoc,
  ) {
    void live.ready.then(() => this.bind());
  }

  private bind(): void {
    if (this.disposed || this.model.isDisposed()) return;
    // Whoever answered decides the text; with nobody there, this buffer is the session's first copy.
    if (this.live.text.length === 0) this.live.seed(this.model.getValue());
    else this.setModel(this.live.text.toString());

    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === TYPED) return;
      this.applyToModel(event);
    };
    this.live.text.observe(observer);
    this.offs.push(() => this.live.text.unobserve(observer));

    const typed = this.model.onDidChangeContent((event) => {
      if (this.applying) return;
      this.applyToDoc(event);
    });
    this.offs.push(() => typed.dispose());

    const redraw = () => this.drawCursors();
    this.live.awareness.on("change", redraw);
    this.offs.push(() => this.live.awareness.off("change", redraw));
    this.bound = true;
    this.drawCursors();
  }

  private applyToModel(event: Y.YTextEvent): void {
    if (this.model.isDisposed()) return;
    const edits = deltaToEdits(event.delta as never);
    if (edits.length === 0) return;
    // Every range against the model as it is now, before any of them applies — which is how
    // `pushEditOperations` reads a list of edits, and how `deltaToEdits` counts.
    const operations = edits.map((edit) => ({
      range: this.rangeOf(edit.index, edit.remove),
      text: edit.insert,
      forceMoveMarkers: true,
    }));
    this.applying = true;
    try {
      this.model.pushEditOperations([], operations, () => null);
    } finally {
      this.applying = false;
    }
    this.checkAgreement();
  }

  private applyToDoc(event: MonacoEditorNS.IModelContentChangedEvent): void {
    const text = this.live.text;
    const whole =
      event.isFlush ||
      (event.changes.length === 1 && event.changes[0].rangeOffset === 0 && event.changes[0].rangeLength === text.length && text.length > 0);
    if (whole) {
      this.live.replaceWith(this.model.getValue(), TYPED);
      return;
    }
    // From the end backwards, so the earlier offsets still count in the text as it was.
    const changes = [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
    this.live.doc.transact(() => {
      for (const change of changes) {
        if (change.rangeLength > 0) text.delete(change.rangeOffset, change.rangeLength);
        if (change.text) text.insert(change.rangeOffset, change.text);
      }
    }, TYPED);
    this.checkAgreement();
  }

  /** A guard against drifting apart (an end-of-line normalisation, say): the model wins locally. */
  private checkAgreement(): void {
    if (this.model.isDisposed() || this.model.getValueLength() > CHECK_LIMIT) return;
    const value = this.model.getValue();
    if (value !== this.live.text.toString()) this.live.replaceWith(value, TYPED);
  }

  /** Makes the model's text `next` with the smallest replacement, as a remote change. */
  private setModel(next: string): void {
    const edit = minimalEdit(this.model.getValue(), next);
    if (!edit) return;
    this.applying = true;
    try {
      this.model.pushEditOperations([], [{ range: this.rangeOf(edit.index, edit.remove), text: edit.insert, forceMoveMarkers: true }], () => null);
    } finally {
      this.applying = false;
    }
  }

  private rangeOf(index: number, length: number): IRange {
    const start = this.model.getPositionAt(index);
    const end = this.model.getPositionAt(index + length);
    return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
  }

  // -------------------------------------------------------------------------
  // Cursors
  // -------------------------------------------------------------------------

  addEditor(editor: MonacoEditorNS.IStandaloneCodeEditor): void {
    if (this.editors.has(editor)) return;
    const decorations = editor.createDecorationsCollection([]);
    const moved = editor.onDidChangeCursorSelection(() => {
      if (!this.bound || !editor.hasTextFocus() || editor.getModel() !== this.model) return;
      const selection = editor.getSelection();
      if (!selection) return;
      const anchor = this.model.getOffsetAt(selection.getStartPosition());
      const head = this.model.getOffsetAt(selection.getEndPosition());
      const reversed = selection.getDirection() === 1;
      const [a, h] = reversed ? [head, anchor] : [anchor, head];
      this.live.awareness.setLocalStateField("sel", {
        a: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.live.text, a)),
        h: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.live.text, h)),
      });
    });
    this.editors.set(editor, { decorations, off: () => moved.dispose() });
    this.drawCursors();
  }

  removeEditor(editor: MonacoEditorNS.IStandaloneCodeEditor): void {
    const entry = this.editors.get(editor);
    if (!entry) return;
    entry.off();
    entry.decorations.clear();
    this.editors.delete(editor);
  }

  get editorCount(): number {
    return this.editors.size;
  }

  private drawCursors(): void {
    if (!this.bound || this.model.isDisposed()) return;
    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = [];
    const rules: string[] = [];
    for (const [client, raw] of this.live.awareness.getStates()) {
      if (client === this.live.doc.clientID) continue;
      const state = raw as Cursor;
      if (!state.sel) continue;
      const a = this.absolute(state.sel.a);
      const h = this.absolute(state.sel.h);
      if (a === null || h === null) continue;
      const hue = Number.isFinite(state.hue) ? Number(state.hue) : 200;
      const [from, to] = a <= h ? [a, h] : [h, a];
      if (from !== to) {
        decorations.push({ range: this.rangeOf(from, to - from), options: { className: `cf-live-sel-${client}` } });
      }
      decorations.push({
        range: this.rangeOf(h, 0),
        options: { beforeContentClassName: `cf-live-caret-${client}`, stickiness: 1 },
      });
      rules.push(cursorRules(client, hue, state.nick ?? ""));
    }
    setCursorStyles(this.live.id, rules.join("\n"));
    for (const [editor, entry] of this.editors) {
      if (editor.getModel() === this.model) entry.decorations.set(decorations);
      else entry.decorations.clear();
    }
  }

  private absolute(json: unknown): number | null {
    if (!json) return null;
    try {
      const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), this.live.doc);
      return position && position.type === this.live.text ? Math.min(position.index, this.model.getValueLength()) : null;
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const editor of [...this.editors.keys()]) this.removeEditor(editor);
    setCursorStyles(this.live.id, "");
  }
}

/** CSS of one remote cursor: the selection tint, the caret and the nick over it. */
export function cursorRules(client: number, hue: number, nick: string): string {
  const label = nick.replace(/[\\"]/g, "\\$&").replace(/[\n\r]/g, " ").slice(0, 40);
  return [
    `.cf-live-sel-${client}{background:hsla(${hue},75%,55%,.22);}`,
    `.cf-live-caret-${client}{position:relative;border-left:2px solid hsl(${hue},70%,50%);margin-left:-1px;}`,
    `.cf-live-caret-${client}::after{content:"${label}";position:absolute;left:-2px;top:-1.35em;padding:0 4px;border-radius:3px 3px 3px 0;` +
      `font:600 10px/1.35em system-ui,sans-serif;white-space:nowrap;color:#fff;background:hsl(${hue},70%,45%);pointer-events:none;z-index:5;}`,
  ].join("");
}

/** One stylesheet per document, rewritten as cursors come and go. */
const sheets = new Map<string, HTMLStyleElement>();

function setCursorStyles(doc: string, css: string): void {
  let sheet = sheets.get(doc);
  if (!css) {
    sheet?.remove();
    sheets.delete(doc);
    return;
  }
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.dataset.cfLive = "";
    document.head.appendChild(sheet);
    sheets.set(doc, sheet);
  }
  if (sheet.textContent !== css) sheet.textContent = css;
}
