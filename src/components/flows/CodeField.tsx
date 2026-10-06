import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { monaco, OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { useThemeStore } from "../../state/themeStore";

/**
 * A node's code — a shell script, Python, Node or the Code node's JavaScript — in Monaco.
 *
 * Its own module so Monaco arrives with the first code parameter somebody opens, not with the
 * canvas. Models live under the `cf-flow-code:` scheme, one per node and parameter, which is also
 * how the marker filter below knows a model is one of these.
 */

const SCHEME = "cf-flow-code";

const LANGUAGES: Record<string, string> = {
  shell: "shell",
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  json: "json",
  sql: "sql",
  markdown: "markdown",
};

/**
 * The Code node's source is a function *body* — `return items` at the top level, `await` without an
 * `async` around it — which a plain script is not, so the JavaScript service marks both as errors.
 * Those two diagnostics are dropped for this scheme's models; every other one stays.
 */
const BODY_ONLY = new Set([1108, 1375, 1378, 1308]);
let markerFilter = false;

function installMarkerFilter(): void {
  if (markerFilter) return;
  markerFilter = true;
  monaco.editor.onDidChangeMarkers((uris) => {
    for (const uri of uris) {
      if (uri.scheme !== SCHEME) continue;
      const model = monaco.editor.getModel(uri);
      if (!model) continue;
      for (const owner of ["javascript", "typescript"]) {
        const markers = monaco.editor.getModelMarkers({ resource: uri, owner });
        const kept = markers.filter((marker) => !BODY_ONLY.has(Number(typeof marker.code === "object" ? marker.code?.value : marker.code)));
        if (kept.length !== markers.length) monaco.editor.setModelMarkers(model, owner, kept);
      }
    }
  });
}

export default function CodeField({
  bufferKey,
  lang,
  value,
  onChange,
  height = 220,
}: {
  /** Unique per node and parameter: it names the model, and so its undo stack. */
  bufferKey: string;
  lang: string;
  value: string;
  onChange: (next: string) => void;
  height?: number;
}) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(installMarkerFilter, []);
  const language = LANGUAGES[lang] ?? "plaintext";
  const extension = { shell: "sh", python: "py", javascript: "js", typescript: "ts", json: "json", sql: "sql", markdown: "md" }[lang] ?? "txt";

  const onMount: OnMount = (editor) => {
    // ⌘S inside the editor would otherwise reach the browser's "save page".
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {});
  };

  return (
    <div className="cf-flow-code overflow-hidden rounded-md border border-[var(--cf-field-border)]" style={{ height }}>
      <Editor
        height="100%"
        language={language}
        path={`${SCHEME}:/${bufferKey}.${extension}`}
        value={value}
        theme={monacoTheme}
        onMount={onMount}
        onChange={(next) => latest.current(next ?? "")}
        options={{
          ...OVERFLOW_SAFE_OPTIONS,
          minimap: { enabled: false },
          fontSize: 12,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          tabSize: 2,
          lineNumbersMinChars: 3,
          overviewRulerLanes: 0,
          padding: { top: 6, bottom: 6 },
          wordWrap: "on",
          renderLineHighlight: "none",
        }}
      />
    </div>
  );
}
