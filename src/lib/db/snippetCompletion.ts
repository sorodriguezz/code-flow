import type { languages as MonacoLanguages } from "monaco-editor";
import { monaco } from "../monacoSetup";
import { ensureDbPrefsLoaded, useDbPrefsStore } from "../../state/dbPrefsStore";
import { snippetsFor } from "./snippets";

/**
 * Offers the console's snippets in the completion list, beside the catalog's names.
 *
 * A provider of its own rather than a branch in `sqlCompletion`: the Mongo and Redis consoles get
 * snippets too, and those languages have no catalog provider. Same selector score as the SQL one,
 * so Monaco asks both and merges the lists. Only for `cf-db:` models — the editor's `.sql` files
 * are someone's repository, not this console.
 */
const LANGUAGES: { monaco: string; console: "sql" | "javascript" | "redis" }[] = [
  { monaco: "sql", console: "sql" },
  { monaco: "javascript", console: "javascript" },
  { monaco: "shell", console: "redis" },
];

let installed = false;

export function installSnippetCompletions(): void {
  if (installed) return;
  installed = true;
  ensureDbPrefsLoaded();
  for (const language of LANGUAGES) {
    const provider: MonacoLanguages.CompletionItemProvider = {
      provideCompletionItems(model, position) {
        if (model.uri.scheme !== "cf-db") return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions = snippetsFor(useDbPrefsStore.getState().snippets, language.console).map((snippet) => ({
          label: { label: snippet.prefix, description: snippet.description },
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: { value: "```\n" + snippet.body + "\n```" },
          // Ahead of keywords that share the letters: a prefix is typed on purpose.
          sortText: `0${snippet.prefix}`,
          range,
        }));
        return { suggestions };
      },
    };
    monaco.languages.registerCompletionItemProvider(language.monaco, provider);
  }
}
