import { useEffect, useMemo } from "react";
import Editor from "@monaco-editor/react";
import { monaco, OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { useThemeStore } from "../../state/themeStore";

/** Past this, a result is not something anyone reads down — and tokenising it costs the frame. The
 *  same ceiling the API client's body viewer uses, for the same reason. */
const DOCUMENTS_DISPLAY_LIMIT = 5 * 1024 * 1024;

/**
 * The documents a Mongo result carries, coloured.
 *
 * A read-only Monaco rather than a `<pre>`, which is what the API client's response body already
 * does: it buys the tokens their colours, plus folding for a five-hundred-document dump and ⌘F
 * inside it, instead of a bespoke highlighter that would have to be kept honest by hand.
 *
 * **JavaScript's colours and not `json`.** What comes back is Mongo's own notation, not JSON —
 * `ObjectId("…")` and `ISODate("…")` are calls, and the JSON tokenizer has nowhere to put them. The
 * console's editor is set the same way for the same reason. Validation decorations are off because
 * several documents in one buffer are not one valid program and never will be; the point here is
 * the colours, and a screen of red squiggles under correct output is worse than none.
 *
 * **The console's JSON view, not the table browser's.** The two diverged when documents became
 * editable: in a data tab a document is something you act on — edit, clone, delete — and those are
 * per-document affordances a single shared buffer has nowhere to put, so that panel draws JSON as
 * cards (`DocumentList` in `json` mode) with the buttons on them. A console result has no one
 * collection to write back to, so there is nothing to put on a card, and what is worth having
 * instead is exactly what an editor gives: ⌘F across five hundred documents, and folding.
 */
/**
 * JavaScript's grammar under a language of its own. Registered as `javascript`, every result model
 * was handed to the TypeScript worker, which parsed and checked up to 5 MB of output on each run —
 * for squiggles this view turns off anyway. A Monarch-only language gets the same colours and
 * folding from the tokenizer alone.
 */
const VIEW_LANGUAGE = "cf-js-view";
let viewLanguage: Promise<void> | null = null;

function registerViewLanguage(): Promise<void> {
  viewLanguage ??= (async () => {
    monaco.languages.register({ id: VIEW_LANGUAGE });
    const entry = monaco.languages.getLanguages().find((language) => language.id === "javascript") as
      | (monaco.languages.ILanguageExtensionPoint & {
          loader?: () => Promise<{ language?: monaco.languages.IMonarchLanguage; conf?: monaco.languages.LanguageConfiguration }>;
        })
      | undefined;
    const grammar = await entry?.loader?.();
    if (grammar?.language) monaco.languages.setMonarchTokensProvider(VIEW_LANGUAGE, grammar.language);
    if (grammar?.conf) monaco.languages.setLanguageConfiguration(VIEW_LANGUAGE, grammar.conf);
  })();
  return viewLanguage;
}

/**
 * Frees the `cf-db:` models of tabs that are gone — console, DDL and result buffers alike. The
 * library disposes only the model on screen when an editor unmounts, so every console ever opened
 * kept its buffer (and every result its megabytes) until the app quit. The text is the store's, not
 * the model's, so a tab that comes back is rebuilt from it.
 */
export function useDbModelSweep(tabIds: string[]): void {
  const key = tabIds.join("\n");
  useEffect(() => {
    const open = new Set(key.split("\n"));
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme !== "cf-db") continue;
      const [, kind, file] = model.uri.path.split("/");
      if (!file || !["console", "ddl", "result"].includes(kind)) continue;
      const id = file.slice(0, file.lastIndexOf(".") > 0 ? file.lastIndexOf(".") : file.length);
      if (!open.has(id)) model.dispose();
    }
  }, [key]);
}

export function DocumentsView({ id, documents }: { id: string; documents: string[] }) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  useEffect(() => void registerViewLanguage(), []);
  const text = useMemo(() => documents.join("\n"), [documents]);
  const shown = text.length > DOCUMENTS_DISPLAY_LIMIT ? text.slice(0, DOCUMENTS_DISPLAY_LIMIT) : text;

  return (
    <div className="min-h-0 flex-1">
      <Editor
        height="100%"
        // Its own model per tab — two tabs showing documents must not share one buffer — and the
        // `cf-db:` scheme keeps these out of the file models' way.
        path={`cf-db:/result/${id}.js`}
        language={VIEW_LANGUAGE}
        value={shown}
        theme={monacoTheme}
        options={{
          ...OVERFLOW_SAFE_OPTIONS,
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          fontSize: 11.5,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          renderLineHighlight: "none",
          renderValidationDecorations: "off",
          folding: true,
          lineNumbers: "off",
          overviewRulerLanes: 0,
          padding: { top: 6, bottom: 6 },
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            alwaysConsumeMouseWheel: false,
          },
          // Every entry in the default menu edits a buffer this one refuses.
          contextmenu: false,
        }}
      />
    </div>
  );
}
