import { useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { Code2, Plus, Search } from "lucide-react";
import { monaco } from "../../lib/monacoSetup";
import { SCRIPT_SNIPPETS } from "../../lib/api/sandbox";
import { useApiStore } from "../../state/apiStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";

/** Own URI scheme, like `cf-editor:` for repo files. It is also what tells the `pm.*` completion
 * provider that a model is a script buffer and not somebody's open `.js` file. */
const SCRIPT_SCHEME = "cf-api-script";

// ---------------------------------------------------------------------------
// pm.* completions
// ---------------------------------------------------------------------------

interface PmEntry {
  label: string;
  /** `${1:…}` placeholders are honoured — every entry is inserted as a snippet. */
  insertText: string;
  detail: string;
  callable: boolean;
}

/**
 * The sandbox's API, as the editor sees it. Descriptions are English-only on purpose: they name
 * functions from Postman's `pm` API, which is not translated in any client that implements it —
 * translating `pm.response.code` into "código" would make the docs harder to match, not easier.
 */
const PM_API: PmEntry[] = [
  { label: "pm.test", insertText: 'pm.test("${1:name}", function () {\n\t$0\n});', detail: "Register an assertion block", callable: true },
  { label: "pm.expect", insertText: "pm.expect(${1:value})", detail: "Chai-style expectation", callable: true },
  { label: "pm.response.code", insertText: "pm.response.code", detail: "number — HTTP status code", callable: false },
  { label: "pm.response.status", insertText: "pm.response.status", detail: "string — HTTP status text", callable: false },
  { label: "pm.response.responseTime", insertText: "pm.response.responseTime", detail: "number — round trip in ms", callable: false },
  { label: "pm.response.json", insertText: "pm.response.json()", detail: "Parse the body as JSON", callable: true },
  { label: "pm.response.text", insertText: "pm.response.text()", detail: "The body as text", callable: true },
  { label: "pm.response.headers.get", insertText: 'pm.response.headers.get("${1:Content-Type}")', detail: "One response header", callable: true },
  { label: "pm.response.to.have.status", insertText: "pm.response.to.have.status(${1:200})", detail: "Assert the status code", callable: true },
  { label: "pm.response.to.have.header", insertText: 'pm.response.to.have.header("${1:Content-Type}")', detail: "Assert a header is present", callable: true },
  { label: "pm.response.to.have.jsonBody", insertText: "pm.response.to.have.jsonBody()", detail: "Assert the body parses as JSON", callable: true },
  { label: "pm.response.to.have.jsonSchema", insertText: "pm.response.to.have.jsonSchema(${1:schema})", detail: "Assert the body matches a JSON schema", callable: true },
  { label: "pm.response.to.be.ok", insertText: "pm.response.to.be.ok", detail: "Assert a 2xx status", callable: false },
  { label: "pm.environment.get", insertText: 'pm.environment.get("${1:key}")', detail: "Read an environment variable", callable: true },
  { label: "pm.environment.set", insertText: 'pm.environment.set("${1:key}", ${2:value})', detail: "Write an environment variable", callable: true },
  { label: "pm.environment.unset", insertText: 'pm.environment.unset("${1:key}")', detail: "Remove an environment variable", callable: true },
  { label: "pm.environment.has", insertText: 'pm.environment.has("${1:key}")', detail: "Is the variable defined?", callable: true },
  { label: "pm.collectionVariables.get", insertText: 'pm.collectionVariables.get("${1:key}")', detail: "Read a collection variable", callable: true },
  { label: "pm.collectionVariables.set", insertText: 'pm.collectionVariables.set("${1:key}", ${2:value})', detail: "Write a collection variable", callable: true },
  { label: "pm.globals.get", insertText: 'pm.globals.get("${1:key}")', detail: "Read a global variable", callable: true },
  { label: "pm.globals.set", insertText: 'pm.globals.set("${1:key}", ${2:value})', detail: "Write a global variable", callable: true },
  { label: "pm.variables.get", insertText: 'pm.variables.get("${1:key}")', detail: "Read with full precedence", callable: true },
  { label: "pm.variables.replaceIn", insertText: 'pm.variables.replaceIn("${1:{{baseUrl}}}")', detail: "Interpolate {{variables}} in a string", callable: true },
  { label: "pm.request.headers.upsert", insertText: 'pm.request.headers.upsert("${1:Authorization}", ${2:value})', detail: "Add or replace a request header", callable: true },
  { label: "pm.request.url", insertText: "pm.request.url", detail: "string — the URL about to be sent", callable: false },
  { label: "pm.request.method", insertText: "pm.request.method", detail: "string — the HTTP method", callable: false },
  { label: "pm.sendRequest", insertText: "await pm.sendRequest(${1:options})", detail: "Send an extra HTTP request", callable: true },
  { label: "pm.info.requestName", insertText: "pm.info.requestName", detail: "string — the request's name", callable: false },
  { label: "pm.info.iteration", insertText: "pm.info.iteration", detail: "number — runner iteration index", callable: false },
  { label: "pm.visualizer.set", insertText: "pm.visualizer.set(${1:template}, ${2:data})", detail: "Render a custom response view", callable: true },
  { label: "postman.setNextRequest", insertText: 'postman.setNextRequest("${1:name}")', detail: "Jump to another request in a run", callable: true },
];

/**
 * Registered once, at module scope: Monaco's provider registry is global, so doing this per mount
 * would stack a fresh copy of the whole catalogue on every panel that ever opened, and the
 * suggestion list would show each entry as many times as scripts had been visited.
 *
 * Scoped to script models by URI rather than to the `javascript` language as a whole — the code
 * editor opens real `.js` files with the same language id, and `pm.test` has no business being
 * offered there.
 *
 * The flag lives on `globalThis` rather than in a module-scope `let` because a hot reload replaces
 * this module while leaving Monaco's registry alone, which is precisely the duplicate-suggestions
 * case this guards against.
 */
const registry = globalThis as typeof globalThis & { __cfApiScriptCompletions?: boolean };
if (!registry.__cfApiScriptCompletions) {
  registry.__cfApiScriptCompletions = true;
  monaco.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      if (model.uri.scheme !== SCRIPT_SCHEME) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: PM_API.map((entry) => ({
          label: entry.label,
          // `label` carries the dots, which Monaco's default filter would otherwise refuse to
          // match against the single word before the caret.
          filterText: entry.label,
          kind: entry.callable
            ? monaco.languages.CompletionItemKind.Function
            : monaco.languages.CompletionItemKind.Property,
          insertText: entry.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: entry.detail,
          range,
        })),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ScriptsPanel({ tabId, kind }: { tabId: string; kind: "pre" | "post" }) {
  const t = useT();
  const tab = useApiStore((s) => s.openTabs.find((entry) => entry.id === tabId));
  const updateDraft = useApiStore((s) => s.updateDraft);
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const [filter, setFilter] = useState("");

  const value = (kind === "pre" ? tab?.draft.preScript : tab?.draft.postScript) ?? "";

  const onMount: OnMount = (instance) => {
    editorRef.current = instance;
  };

  /** Inserts through Monaco's edit stack rather than by rewriting the whole string, so the
   * snippet lands at the caret, joins the undo history and leaves the selection after it. */
  const insert = (code: string) => {
    const instance = editorRef.current;
    if (!instance) return;
    const selection = instance.getSelection();
    const position = instance.getPosition();
    if (!selection || !position) return;
    // Dropping a whole assertion block into the middle of an existing line would produce code the
    // user then has to untangle; starting on a fresh line is what they meant.
    const text = position.column > 1 ? `\n${code}\n` : `${code}\n`;
    instance.executeEdits("cf-api-snippet", [{ range: selection, text, forceMoveMarkers: true }]);
    instance.pushUndoStop();
    instance.focus();
  };

  const query = filter.trim().toLowerCase();
  const snippets = query === "" ? SCRIPT_SNIPPETS : SCRIPT_SNIPPETS.filter((s) => s.label.toLowerCase().includes(query));

  if (!tab) return <div className="h-full" />;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
          <Code2 size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="text-[11px] text-[var(--cf-text)]">
            {t(kind === "pre" ? "api.scripts.preRequest" : "api.scripts.postResponse")}
          </span>
          <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{t("api.scripts.docsHint")}</span>
        </div>
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            language="javascript"
            path={`${SCRIPT_SCHEME}:/${tabId}/${kind}.js`}
            value={value}
            theme={monacoTheme}
            onMount={onMount}
            onChange={(next) =>
              updateDraft(tabId, kind === "pre" ? { preScript: next ?? "" } : { postScript: next ?? "" })
            }
            options={{
            ...OVERFLOW_SAFE_OPTIONS,
              minimap: { enabled: false },
              fontSize: 12,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              tabSize: 4,
              lineNumbersMinChars: 3,
              overviewRulerLanes: 0,
              padding: { top: 8, bottom: 8 },
            }}
          />
        </div>
      </div>

      <div className="flex w-56 shrink-0 flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)]">
        <div className="shrink-0 px-2 py-1.5">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("api.scripts.snippets")}
          </p>
          <div className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-1">
            <Search size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("api.snippet.filter")}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)]"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {snippets.map((snippet) => (
            <button
              key={snippet.label}
              type="button"
              onClick={() => insert(snippet.code)}
              title={t("api.scripts.insertSnippet")}
              className="group flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-accent-soft)] hover:text-[var(--cf-accent)]"
            >
              <Plus size={11} className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-100" />
              <span className="min-w-0 flex-1">{snippet.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
