import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { monaco, OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { complete, dropText, type AssistData, type AssistField, type SuggestionKind } from "../../lib/flows/exprAssist";
import type { TranslationKey } from "../../lib/i18n/translations";
import { releasedOver, useFlowFieldDragStore } from "../../state/flowFieldDragStore";
import { useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";
import { useFlowAssist } from "./assist";

/**
 * A node's code — a shell script, Python, Node or the Code node's JavaScript — in Monaco.
 *
 * Its own module so Monaco arrives with the first code parameter somebody opens, not with the
 * canvas. Models live under the `cf-flow-code:` scheme, one per node and parameter, which is also
 * how the marker filter and the suggestions below know a model is one of these.
 *
 * **It helps write the code** the way the text boxes do (`exprAssist`): the input's fields after
 * `$json.` or `item["`, a template's loop variables, the SQL node's columns — each in the dialect
 * the field is read in — and a field dragged from the input lands where it is let go, written in
 * that dialect too.
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

/** What a flow code model suggests, by model URI — registered by the field showing it. */
interface AssistTarget {
  field: AssistField;
  data: AssistData;
  want: (name: string) => void;
  translate: (key: TranslationKey, params?: Record<string, string | number>) => string;
}
const targets = new Map<string, () => AssistTarget | null>();
let completionInstalled = false;

const ITEM_KIND: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
  field: monaco.languages.CompletionItemKind.Field,
  variable: monaco.languages.CompletionItemKind.Variable,
  function: monaco.languages.CompletionItemKind.Function,
  method: monaco.languages.CompletionItemKind.Method,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  node: monaco.languages.CompletionItemKind.Module,
  snippet: monaco.languages.CompletionItemKind.Snippet,
};

/** An insert as snippet text: the caret as `$0`, and the `$`, `}` and `\` it holds read literally. */
function snippet(insert: string, caret: number | undefined): string {
  const escape = (text: string) => text.replace(/[\\$}]/g, (c) => `\\${c}`);
  return caret === undefined ? escape(insert) : `${escape(insert.slice(0, caret))}$0${escape(insert.slice(caret))}`;
}

/**
 * One provider per language, answering only for `cf-flow-code:` models — the main editor's models
 * are never asked anything (Monaco only asks a provider about a trigger character it declared, so
 * the space and brace triggers cost those editors nothing either).
 */
function installCompletion(): void {
  if (completionInstalled) return;
  completionInstalled = true;
  for (const language of new Set([...Object.values(LANGUAGES), "plaintext"])) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: [".", "$", "{", "(", "'", '"', "[", "|", " ", "%"],
      provideCompletionItems(model, position) {
        const target = model.uri.scheme === SCHEME ? targets.get(model.uri.toString())?.() : null;
        if (!target) return { suggestions: [] };
        const text = model.getValue();
        const done = complete(text, model.getOffsetAt(position), target.field, target.data);
        if (done?.wants) target.want(done.wants);
        if (!done) return { suggestions: [] };
        const range = (from: number, to: number) => monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to));
        return {
          suggestions: done.items.map((item, index) => {
            const from = item.from ?? done.from;
            return {
              label: { label: item.label, description: item.sample ?? (item.detail && item.detail.length > 2 ? item.detail : undefined) },
              kind: ITEM_KIND[item.kind],
              detail: item.detail,
              documentation: item.doc ? target.translate(item.doc as TranslationKey, item.docArgs) : undefined,
              insertText: snippet(item.insert, item.caret),
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range: range(from, item.to ?? done.to),
              // Matched against what the range covers — which, for `.campo` → `["un campo"]`, starts at the dot.
              filterText: text.slice(from, done.from) + item.label,
              sortText: String(index).padStart(4, "0"),
              command: item.again ? { id: "editor.action.triggerSuggest", title: "" } : undefined,
            };
          }),
        };
      },
    });
  }
}

/** Monaco's own drop caret — on the editor at runtime, not in its typings. */
type DropIndicator = { showDropIndicatorAt?: (position: monaco.IPosition) => void; removeDropIndicator?: () => void };

export default function CodeField({
  bufferKey,
  lang,
  value,
  onChange,
  assist = null,
  height = 220,
}: {
  /** Unique per node and parameter: it names the model, and so its undo stack. */
  bufferKey: string;
  lang: string;
  value: string;
  onChange: (next: string) => void;
  /** How the field is read, for suggestions and dropped fields; `null` for neither. */
  assist?: AssistField | null;
  height?: number;
}) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const t = useT();
  const flowAssist = useFlowAssist();
  const latest = useRef(onChange);
  latest.current = onChange;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useFlowFieldDragStore((s) => s.drag);
  const [over, setOver] = useState(false);
  useEffect(installMarkerFilter, []);
  useEffect(installCompletion, []);
  const language = LANGUAGES[lang] ?? "plaintext";
  const extension = { shell: "sh", python: "py", javascript: "js", typescript: "ts", json: "json", sql: "sql", markdown: "md" }[lang] ?? "txt";
  const path = `${SCHEME}:/${bufferKey}.${extension}`;

  // What this model suggests is read when Monaco asks, so it is always the latest input.
  const target = useRef<AssistTarget | null>(null);
  target.current = assist && flowAssist ? { field: assist, data: flowAssist.data, want: flowAssist.want, translate: t } : null;
  useEffect(() => {
    const key = monaco.Uri.parse(path).toString();
    targets.set(key, () => target.current);
    return () => {
      targets.delete(key);
    };
  }, [path]);

  // A field dragged from the input: the editor lights up under it and takes it where it is let go.
  const dialect = assist?.dialect;
  const expressions = assist?.expressions ?? false;
  useEffect(() => {
    const editor = editorRef.current as (monaco.editor.IStandaloneCodeEditor & DropIndicator) | null;
    if (!drag || !dialect) {
      setOver(false);
      editor?.removeDropIndicator?.();
      return;
    }
    const aim = (event: PointerEvent) => {
      const inside = releasedOver(box.current, event);
      setOver(inside);
      const position = inside ? editor?.getTargetAtClientPoint(event.clientX, event.clientY)?.position : null;
      if (position) editor?.showDropIndicatorAt?.(position);
      else editor?.removeDropIndicator?.();
    };
    const drop = (event: PointerEvent) => {
      const model = editor?.getModel();
      if (!editor || !model || !releasedOver(box.current, event)) return;
      editor.removeDropIndicator?.();
      const position = editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position ?? editor.getPosition();
      useFlowFieldDragStore.getState().end();
      if (!position) return;
      const at = model.getOffsetAt(position);
      const dropped = dropText(drag.path, { dialect, expressions }, model.getValue(), at);
      if (!dropped) return;
      // One undoable edit, and the caret after it to keep writing.
      editor.executeEdits("cf-flow-drop", [{ range: monaco.Range.fromPositions(position, position), text: dropped.insert, forceMoveMarkers: true }]);
      editor.setPosition(model.getPositionAt(at + dropped.insert.length));
      editor.focus();
    };
    window.addEventListener("pointermove", aim, true);
    window.addEventListener("pointerup", drop, true);
    return () => {
      window.removeEventListener("pointermove", aim, true);
      window.removeEventListener("pointerup", drop, true);
      editor?.removeDropIndicator?.();
    };
  }, [drag, dialect, expressions]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    // ⌘S inside the editor would otherwise reach the browser's "save page".
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {});
  };

  return (
    <div
      ref={box}
      className={`cf-flow-code overflow-hidden rounded-md border border-[var(--cf-field-border)] ${over ? "cf-flow-drop" : ""}`}
      style={{ height }}
    >
      <Editor
        height="100%"
        language={language}
        path={path}
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
