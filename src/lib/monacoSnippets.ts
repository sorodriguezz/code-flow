import * as monaco from "monaco-editor";
import { snippetsFor } from "../state/snippetsStore";

/**
 * The snippets, as completions.
 *
 * # Why a provider and not a keybinding
 *
 * "Type `clg`, press Tab" is a macro; this is a *completion* — the prefix shows up in the same
 * dropdown as everything else, with its description beside it and a preview of what it will write,
 * and it is accepted the same way. That is what makes it discoverable: you find out `clg` exists
 * because it appeared while you were typing `cl`, not because you read a list of shortcuts.
 *
 * # Insertion is Monaco's own snippet mode
 *
 * `InsertAsSnippet` is what turns `${1:name}` into a selected placeholder and Tab into "next stop".
 * Without that flag the body is inserted as literal text, dollars and all — which is the difference
 * between a snippet and a paste.
 *
 * # Registered once, for every language
 *
 * Same shape as `installGoToDefinition`, and the same caveat: the language list is snapshotted here,
 * so this runs after every language the app registers of its own (ObjectScript). The provider reads
 * the store at *call* time, so a snippet added in settings is offered on the next keystroke — there
 * is nothing to re-register when the list changes.
 */
let installed = false;

export function installSnippets() {
  if (installed) return;
  installed = true;

  monaco.languages.registerCompletionItemProvider(
    monaco.languages.getLanguages().map((language) => language.id),
    {
      provideCompletionItems: (model, position) => {
        const snippets = snippetsFor(model.getLanguageId());
        if (snippets.length === 0) return { suggestions: [] };
        // The word under the caret is what the prefix replaces. Monaco does the filtering from
        // there, so `cl` narrows to `clg` without this having to match anything itself.
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        return {
          suggestions: snippets.map((snippet) => ({
            label: snippet.prefix,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: snippet.description || undefined,
            // What it will actually write, with the tab stops taken out — a preview, not the source.
            documentation: { value: `\`\`\`\n${preview(snippet.body)}\n\`\`\`` },
            insertText: snippet.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        };
      },
    },
  );
}

/** `${1:name}` → `name`, `$1`/`$0` → nothing: the body as it will read once the stops are filled. */
function preview(body: string): string {
  return body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{?\d+\}?/g, "");
}
