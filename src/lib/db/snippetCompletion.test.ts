import { describe, expect, it, vi } from "vitest";

const providers: Record<string, any> = {};

vi.mock("../monacoSetup", () => ({
  monaco: {
    languages: {
      CompletionItemKind: { Snippet: 27 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (language: string, provider: unknown) => {
        providers[language] = provider;
        return { dispose() {} };
      },
    },
  },
}));
vi.mock("../../state/dbPrefsStore", () => ({
  ensureDbPrefsLoaded: () => {},
  useDbPrefsStore: { getState: () => ({ snippets: [{ prefix: "sel", body: "SELECT $0", description: "SELECT … FROM", language: "sql" }] }) },
}));

import { installSnippetCompletions } from "./snippetCompletion";

/** The snippets offered with the caret at the end of `text`. */
function offered(text: string): string[] {
  const word = /\w*$/.exec(text)![0];
  const column = text.length + 1;
  const model = {
    uri: { scheme: "cf-db" },
    getWordUntilPosition: () => ({ word, startColumn: column - word.length, endColumn: column }),
    getValueInRange: ({ startColumn, endColumn }: { startColumn: number; endColumn: number }) => text.slice(startColumn - 1, endColumn - 1),
  };
  return providers.sql.provideCompletionItems(model, { lineNumber: 1, column }).suggestions.map((s: { label: { label: string } }) => s.label.label);
}

describe("console snippets", () => {
  installSnippetCompletions();

  it("are offered where a statement can start", () => {
    expect(offered("se")).toEqual(["sel"]);
    expect(offered("")).toEqual(["sel"]);
  });

  it("are not offered right after a dot, where a name goes", () => {
    expect(offered("select * from capas.")).toEqual([]);
    expect(offered("select * from capas.se")).toEqual([]);
  });
});
