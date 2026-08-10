import { useMemo } from "react";
import Editor from "@monaco-editor/react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
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
 * **`javascript` and not `json`.** What comes back is Mongo's own notation, not JSON —
 * `ObjectId("…")` and `ISODate("…")` are calls, and the JSON tokenizer has nowhere to put them. The
 * console's editor is set the same way for the same reason. Validation decorations are off because
 * several documents in one buffer are not one valid program and never will be; the point here is
 * the colours, and a screen of red squiggles under correct output is worse than none.
 *
 * Shared by the console and the data tab so the two read identically. That is the whole reason it
 * is a module and not a local component: a document looked at from a `find()` and the same document
 * looked at by opening the collection should not be two different screens.
 */
export function DocumentsView({ id, documents }: { id: string; documents: string[] }) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const text = useMemo(() => documents.join("\n"), [documents]);
  const shown = text.length > DOCUMENTS_DISPLAY_LIMIT ? text.slice(0, DOCUMENTS_DISPLAY_LIMIT) : text;

  return (
    <div className="min-h-0 flex-1">
      <Editor
        height="100%"
        // Its own model per tab — two tabs showing documents must not share one buffer — and the
        // `cf-db:` scheme keeps these out of the file models' way.
        path={`cf-db:/result/${id}.js`}
        language="javascript"
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
