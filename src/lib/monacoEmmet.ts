import type * as Monaco from "monaco-editor";
import { emmetCSS, emmetHTML, emmetJSX } from "emmet-monaco-es";
import { useEditorDisplayStore } from "../state/editorDisplayStore";

/**
 * Emmet in the code editor, as VS Code has it built in: `div.card>ul>li*3` offered as a completion
 * and expanded with Tab in HTML (and the template languages that are HTML), CSS/SCSS/Less, and JSX.
 *
 * The package registers ordinary completion providers. Each is wrapped before Monaco sees it, for two
 * reasons: the switch in Settings (`editorDisplayStore.emmet`) silences them without a reload, and
 * the JSX one only answers in `.jsx`/`.tsx` files — this app opens both under Monaco's plain
 * `javascript`/`typescript` ids (`monacoLanguage`), and Emmet in a `.ts` file would offer to turn
 * every identifier into a tag.
 */

let installed = false;

const JSX_FILE = /\.(jsx|tsx)$/i;

function gated(monaco: typeof Monaco, onlyJsx: boolean): typeof Monaco {
  const languages = {
    ...monaco.languages,
    registerCompletionItemProvider: (
      selector: Monaco.languages.LanguageSelector,
      provider: Monaco.languages.CompletionItemProvider,
    ) =>
      monaco.languages.registerCompletionItemProvider(selector, {
        ...provider,
        provideCompletionItems: (model, position, context, token) => {
          if (!useEditorDisplayStore.getState().emmet) return undefined;
          if (onlyJsx && !JSX_FILE.test(model.uri.path)) return undefined;
          return provider.provideCompletionItems(model, position, context, token);
        },
      }),
  };
  return { ...monaco, languages } as typeof Monaco;
}

export function installEmmet(monaco: typeof Monaco): void {
  if (installed) return;
  installed = true;
  emmetHTML(gated(monaco, false), ["html", "php", "handlebars", "razor", "vue", "xml"]);
  emmetCSS(gated(monaco, false), ["css", "scss", "less"]);
  emmetJSX(gated(monaco, true), ["javascript", "typescript"]);
}
