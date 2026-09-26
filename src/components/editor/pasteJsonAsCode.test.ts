import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The editor half of Paste JSON as Code, against a fake editor small enough to read: clipboard,
 * checks and dialogs mocked, quicktype real, and the assertion made on the buffer the edit leaves.
 */

const dialogs = vi.hoisted(() => ({
  name: "Order" as string | null,
  confirm: true,
  prompts: [] as string[],
  confirms: [] as string[],
  toasts: [] as string[],
}));

vi.mock("../../state/languageStore", () => ({
  translate: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));
vi.mock("../../state/promptStore", () => ({
  promptAction: async (message: string) => {
    dialogs.prompts.push(message);
    return dialogs.name;
  },
}));
vi.mock("../../state/confirmStore", () => ({
  confirmAction: async (message: string) => {
    dialogs.confirms.push(message);
    return dialogs.confirm;
  },
}));
vi.mock("../../state/toastStore", () => ({
  pushErrorToast: (message: string) => dialogs.toasts.push(message),
}));

const { PASTE_JSON_ACTION, canPasteJsonHere, offerPasteTarget, pasteJsonAsCode, pasteJsonInFocusedEditor } =
  await import("./pasteJsonAsCode");

interface Range {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Just enough of a Monaco editor and its model for the paste to run against, applying edits for real. */
function fakeEditor(text: string, language: string, caret: { line: number; column?: number }) {
  let value = text;
  let disposed = false;
  const lines = () => value.split("\n");
  const offset = (line: number, column: number) =>
    lines()
      .slice(0, line - 1)
      .reduce((sum, l) => sum + l.length + 1, 0) +
    column -
    1;
  const model = {
    getLanguageId: () => language,
    getOptions: () => ({ insertSpaces: true, tabSize: 2 }),
    getValue: () => value,
    getLineCount: () => lines().length,
    getLineMaxColumn: (line: number) => lines()[line - 1].length + 1,
    getValueInRange: (r: Range) => value.slice(offset(r.startLineNumber, r.startColumn), offset(r.endLineNumber, r.endColumn)),
    isDisposed: () => disposed,
  };
  const column = caret.column ?? 1;
  const selection = { startLineNumber: caret.line, startColumn: column, endLineNumber: caret.line, endColumn: column };
  let shown: typeof model | null = model;
  const editor = {
    getModel: () => shown,
    getSelection: () => selection,
    pushUndoStop: vi.fn(),
    executeEdits: vi.fn((_source: string, edits: { range: Range; text: string }[]) => {
      // Last position first, so earlier offsets stay valid; at one position the earlier edit ends up first.
      const placed = edits.map((edit, i) => ({ ...edit, i, at: offset(edit.range.startLineNumber, edit.range.startColumn) }));
      for (const edit of placed.sort((a, b) => b.at - a.at || b.i - a.i)) {
        const end = offset(edit.range.endLineNumber, edit.range.endColumn);
        value = value.slice(0, edit.at) + edit.text + value.slice(end);
      }
      return true;
    }),
    getPosition: () => null,
    revealPosition: vi.fn(),
    focus: vi.fn(),
    trigger: vi.fn(),
  };
  return {
    editor,
    text: () => value,
    /** The tab going away while a dialog is open. */
    leave: () => {
      shown = null;
      disposed = true;
    },
  };
}

const monaco = {
  languages: { getLanguages: () => [{ id: "markdown", aliases: ["Markdown"] }] },
  Selection: class {},
};

function clipboard(read: () => Promise<string>) {
  const readText = vi.fn(read);
  vi.stubGlobal("navigator", { clipboard: { readText } });
  return readText;
}

// The editor and monaco fakes stand in for the real interfaces, which have hundreds of members.
const paste = (fake: ReturnType<typeof fakeEditor>, path = "shop/order.go") =>
  pasteJsonAsCode(fake.editor as never, monaco as never, path);

const JSON_ORDER = JSON.stringify({ id: 7, created_at: "2024-01-01T00:00:00Z", note: "gift" });

beforeEach(() => {
  dialogs.name = "Order";
  dialogs.confirm = true;
  dialogs.prompts = [];
  dialogs.confirms = [];
  dialogs.toasts = [];
});

describe("pasteJsonAsCode", () => {
  it("reads the clipboard before anything else is awaited", async () => {
    const readText = clipboard(async () => JSON_ORDER);
    const running = paste(fakeEditor("", "go", { line: 1 }));
    // Synchronously: a gesture does not survive an `await`, and WebKit wants one for the read.
    expect(readText).toHaveBeenCalledTimes(1);
    await running;
  });

  it("writes the types at the caret and the import the file lacks into its import block, in one undo step", async () => {
    clipboard(async () => JSON_ORDER);
    const file = ["package shop", "", "import (", '\t"fmt"', ")", "", "func main() {", '\tfmt.Println("x")', "}", ""].join("\n");
    const fake = fakeEditor(file, "go", { line: 10 });
    await paste(fake);
    expect(dialogs.toasts).toEqual([]);
    expect(dialogs.prompts).toEqual(["pasteJson.namePrompt"]);
    expect(fake.text()).toBe(
      [
        "package shop",
        "",
        "import (",
        '\t"fmt"',
        ")",
        'import "time"',
        "",
        "func main() {",
        '\tfmt.Println("x")',
        "}",
        "type Order struct {",
        "\tID        int64     `json:\"id\"`",
        "\tCreatedAt time.Time `json:\"created_at\"`",
        "\tNote      string    `json:\"note\"`",
        "}",
        "",
      ].join("\n"),
    );
    expect(fake.editor.executeEdits).toHaveBeenCalledTimes(1);
    expect(fake.editor.pushUndoStop).toHaveBeenCalledTimes(2);
    expect(fake.editor.focus).toHaveBeenCalled();
  });

  it("says so, and edits nothing, when the clipboard does not hold JSON", async () => {
    clipboard(async () => "{ id: 7, }");
    const fake = fakeEditor("", "typescript", { line: 1 });
    await paste(fake);
    expect(dialogs.toasts).toHaveLength(1);
    expect(dialogs.toasts[0]).toMatch(/^pasteJson\.notJson /);
    expect(dialogs.prompts).toEqual([]);
    expect(fake.editor.executeEdits).not.toHaveBeenCalled();
  });

  it("tells an empty clipboard and an unreadable one apart", async () => {
    clipboard(async () => "  \n");
    await paste(fakeEditor("", "typescript", { line: 1 }));
    clipboard(async () => {
      throw new Error("NotAllowedError");
    });
    await paste(fakeEditor("", "typescript", { line: 1 }));
    expect(dialogs.toasts).toEqual(["pasteJson.emptyClipboard", "pasteJson.clipboardFailed"]);
  });

  it("offers TypeScript for a language it does not write, and writes nothing if refused", async () => {
    clipboard(async () => JSON_ORDER);
    dialogs.confirm = false;
    const refused = fakeEditor("", "markdown", { line: 1 });
    await paste(refused, "notes/api.md");
    expect(dialogs.confirms).toEqual(['pasteJson.unsupported {"language":"Markdown"}']);
    expect(refused.editor.executeEdits).not.toHaveBeenCalled();

    dialogs.confirm = true;
    const accepted = fakeEditor("", "markdown", { line: 1 });
    await paste(accepted, "notes/api.md");
    expect(accepted.text()).toContain("export interface Order {");
  });

  it("does nothing when the name is not given", async () => {
    clipboard(async () => JSON_ORDER);
    dialogs.name = null;
    const fake = fakeEditor("", "typescript", { line: 1 });
    await paste(fake);
    expect(fake.editor.executeEdits).not.toHaveBeenCalled();
    expect(dialogs.toasts).toEqual([]);
  });

  it("writes nothing into a file that left the screen while the name was being typed", async () => {
    clipboard(async () => JSON_ORDER);
    const fake = fakeEditor("", "typescript", { line: 1 });
    // The prompt is the one step that waits on the user; the tab closes during it.
    dialogs.name = "Order";
    const running = paste(fake);
    fake.leave();
    await running;
    expect(fake.editor.executeEdits).not.toHaveBeenCalled();
    expect(dialogs.toasts).toEqual(["pasteJson.fileGone"]);
  });

  it("reports JSON with nothing to declare instead of pasting imports alone", async () => {
    clipboard(async () => "[]");
    const fake = fakeEditor("", "csharp", { line: 1 });
    await paste(fake, "Order.cs");
    expect(dialogs.toasts).toEqual(["pasteJson.nothing"]);
    expect(fake.editor.executeEdits).not.toHaveBeenCalled();
  });
});

describe("the command palette's way in", () => {
  it("reaches the focused pane's editor, only while it shows a file, through the same action", () => {
    const fake = fakeEditor("", "typescript", { line: 1 });
    const withdraw = offerPasteTarget(() => fake.editor as never);
    expect(canPasteJsonHere()).toBe(true);
    pasteJsonInFocusedEditor();
    expect(fake.editor.trigger).toHaveBeenCalledWith("command-palette", PASTE_JSON_ACTION, null);

    fake.leave();
    expect(canPasteJsonHere()).toBe(false);
    withdraw();
    expect(canPasteJsonHere()).toBe(false);
  });

  it("is not withdrawn by a pane that already lost it to another", () => {
    const first = fakeEditor("", "typescript", { line: 1 });
    const second = fakeEditor("", "typescript", { line: 1 });
    const withdrawFirst = offerPasteTarget(() => first.editor as never);
    const withdrawSecond = offerPasteTarget(() => second.editor as never);
    withdrawFirst();
    pasteJsonInFocusedEditor();
    expect(second.editor.trigger).toHaveBeenCalledTimes(1);
    expect(first.editor.trigger).not.toHaveBeenCalled();
    withdrawSecond();
  });
});
