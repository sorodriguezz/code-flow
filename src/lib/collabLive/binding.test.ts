import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { ModelBinding } from "./binding";
import { LiveDoc, REMOTE } from "./session";

/**
 * Two people's buffers kept on one text: a fake Monaco model each (the handful of methods the binding
 * uses), a document each, and the updates carried between the documents the way the channel does.
 */

type Listener = (event: MonacoEditorNS.IModelContentChangedEvent) => void;

class FakeModel {
  private listeners: Listener[] = [];
  constructor(private value: string) {}

  getValue() {
    return this.value;
  }
  getValueLength() {
    return this.value.length;
  }
  isDisposed() {
    return false;
  }
  getPositionAt(offset: number) {
    const before = this.value.slice(0, Math.max(0, Math.min(offset, this.value.length)));
    const lines = before.split("\n");
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  }
  getOffsetAt(position: { lineNumber: number; column: number }) {
    const lines = this.value.split("\n");
    let offset = 0;
    for (let i = 0; i < position.lineNumber - 1; i++) offset += lines[i].length + 1;
    return offset + position.column - 1;
  }
  onDidChangeContent(fn: Listener) {
    this.listeners.push(fn);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== fn)) };
  }
  pushEditOperations(_: unknown, operations: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[]) {
    const edits = operations.map((op) => {
      const start = this.getOffsetAt({ lineNumber: op.range.startLineNumber, column: op.range.startColumn });
      const end = this.getOffsetAt({ lineNumber: op.range.endLineNumber, column: op.range.endColumn });
      return { start, end, text: op.text };
    });
    // All against the text as it was, applied from the end.
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      this.value = this.value.slice(0, edit.start) + edit.text + this.value.slice(edit.end);
    }
    const changes = [...edits]
      .sort((a, b) => b.start - a.start)
      .map((e) => ({ rangeOffset: e.start, rangeLength: e.end - e.start, text: e.text }));
    this.emit({ changes, isFlush: false } as never);
    return null;
  }
  /** Typing: one change at an offset. */
  type(offset: number, remove: number, text: string) {
    this.value = this.value.slice(0, offset) + text + this.value.slice(offset + remove);
    this.emit({ changes: [{ rangeOffset: offset, rangeLength: remove, text }], isFlush: false } as never);
  }
  /** What `@monaco-editor/react` does when the `value` prop changes: one whole-buffer replace. */
  replaceAll(next: string) {
    const length = this.value.length;
    this.value = next;
    this.emit({ changes: [{ rangeOffset: 0, rangeLength: length, text: next }], isFlush: false } as never);
  }
  private emit(event: MonacoEditorNS.IModelContentChangedEvent) {
    for (const l of [...this.listeners]) l(event);
  }
}

/** Carries every local update of each document to the other, as the channel would. */
function wire(a: LiveDoc, b: LiveDoc) {
  a.doc.on("update", (u: Uint8Array, origin: unknown) => origin !== REMOTE && Y.applyUpdate(b.doc, u, REMOTE));
  b.doc.on("update", (u: Uint8Array, origin: unknown) => origin !== REMOTE && Y.applyUpdate(a.doc, u, REMOTE));
}

async function pair(textA: string, textB: string) {
  vi.useFakeTimers();
  const file = { repoKey: "r", path: "a.ts" };
  const docA = new LiveDoc("d", file);
  const docB = new LiveDoc("d", file);
  wire(docA, docB);
  const modelA = new FakeModel(textA);
  const modelB = new FakeModel(textB);
  const bindingA = new ModelBinding(modelA as never, docA);
  const bindingB = new ModelBinding(modelB as never, docB);
  await vi.advanceTimersByTimeAsync(1000);
  vi.useRealTimers();
  return { modelA, modelB, docA, docB, bindingA, bindingB };
}

describe("ModelBinding", () => {
  it("seeds one copy when both open the same file at once", async () => {
    const { modelA, modelB, docA } = await pair("let x = 1;\n", "let x = 1;\n");
    expect(docA.text.toString()).toBe("let x = 1;\n");
    expect(modelA.getValue()).toBe("let x = 1;\n");
    expect(modelB.getValue()).toBe("let x = 1;\n");
  });

  it("carries typing both ways, concurrent edits included", async () => {
    const { modelA, modelB } = await pair("hello world\n", "hello world\n");
    modelA.type(5, 0, ",");
    expect(modelB.getValue()).toBe("hello, world\n");
    modelB.type(modelB.getValueLength() - 1, 0, "!");
    expect(modelA.getValue()).toBe("hello, world!\n");
  });

  it("turns a whole-buffer reload into the smallest change, keeping the other's typing", async () => {
    const { modelA, modelB, docA, docB } = await pair("a\nb\nc\n", "a\nb\nc\n");
    // B types at the top; A's agent rewrote line c on disk and A's buffer reloads it whole.
    modelB.type(0, 0, "// note\n");
    modelA.replaceAll("// note\na\nb\nC!\n");
    expect(modelA.getValue()).toBe("// note\na\nb\nC!\n");
    expect(modelB.getValue()).toBe("// note\na\nb\nC!\n");
    expect(docA.text.toString()).toBe(docB.text.toString());
  });

  it("takes the session's text over its own when someone already had the file open", async () => {
    vi.useFakeTimers();
    const file = { repoKey: "r", path: "a.ts" };
    const docA = new LiveDoc("d", file);
    const modelA = new FakeModel("v1\n");
    new ModelBinding(modelA as never, docA);
    await vi.advanceTimersByTimeAsync(1000);
    modelA.type(2, 0, " edited");
    // B arrives with an older disk; A's document answers.
    const docB = new LiveDoc("d", file);
    wire(docA, docB);
    Y.applyUpdate(docB.doc, Y.encodeStateAsUpdate(docA.doc), REMOTE);
    docB.markSynced();
    const modelB = new FakeModel("v1\n");
    new ModelBinding(modelB as never, docB);
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    expect(modelB.getValue()).toBe("v1 edited\n");
    modelB.type(0, 0, ">");
    expect(modelA.getValue()).toBe(">v1 edited\n");
  });

  it("merges what the sync round brings only when its author is not in the document", async () => {
    const { modelA, docA } = await pair("x\n", "x\n");
    docA.replaceWith("x\ny\n", "sync");
    expect(modelA.getValue()).toBe("x\ny\n");
  });
});
