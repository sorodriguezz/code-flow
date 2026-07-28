import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import type { editor as MonacoEditorNS, languages as MonacoLanguages } from "monaco-editor";
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { useApiStore } from "../../state/apiStore";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { monaco } from "../../lib/monacoSetup";
import { resolveRequest, sendResolved } from "../../lib/api/send";
import {
  GQL_OPERATIONS,
  INTROSPECTION_QUERY,
  fieldSkeleton,
  parseIntrospection,
  renderTypeRef,
  rootType,
  typeAtCursor,
  variablesSkeleton,
  type GqlField,
  type GqlOperation,
  type GqlType,
  type GraphqlSchema,
} from "../../lib/api/graphql";
import type { ApiRequestSpec, GraphqlBody } from "../../types/api";

const EDITOR_OPTIONS: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
  ...OVERFLOW_SAFE_OPTIONS,
  minimap: { enabled: false },
  fontSize: 12,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  tabSize: 2,
  renderLineHighlight: "none",
  overviewRulerLanes: 0,
  padding: { top: 8, bottom: 8 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
};

const VARIABLES_MIN = 80;
const VARIABLES_MAX = 400;
const EXPLORER_WIDTH = 264;

// ---------------------------------------------------------------------------
// Monaco wiring — global, so it happens once for the whole app
// ---------------------------------------------------------------------------

/**
 * Model URI → tab id. Completion providers are registered per *language*, not per editor, so this
 * is the only way the provider can tell which tab's schema it should be answering from.
 */
const schemaOwners = new Map<string, string>();

function queryModelPath(tabId: string): string {
  return `cf-api:/graphql/${tabId}.graphql`;
}

function variablesModelPath(tabId: string): string {
  return `cf-api:/graphql/${tabId}.variables.json`;
}

/**
 * Monaco ships a `graphql` grammar in its basic languages, so this only fills in for a build that
 * doesn't — without it, `language="graphql"` would silently fall back to plain text and the query
 * editor would lose every colour with no error anywhere.
 */
function ensureGraphqlLanguage() {
  if (monaco.languages.getLanguages().some((language) => language.id === "graphql")) return;

  monaco.languages.register({ id: "graphql", extensions: [".graphql", ".gql"] });
  monaco.languages.setLanguageConfiguration("graphql", {
    comments: { lineComment: "#" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider("graphql", {
    keywords: ["query", "mutation", "subscription", "fragment", "on", "true", "false", "null"],
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"""/, { token: "string", next: "@blockString" }],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/\$[A-Za-z_]\w*/, "variable"],
        [/@[A-Za-z_]\w*/, "annotation"],
        [/\d+(\.\d+)?/, "number"],
        [/[A-Za-z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/[:,!=|&.]/, "operator"],
      ],
      blockString: [
        [/"""/, { token: "string", next: "@pop" }],
        [/./, "string"],
      ],
    },
  });
}

let completionsInstalled = false;

function installGraphqlCompletions() {
  if (completionsInstalled) return;
  completionsInstalled = true;
  ensureGraphqlLanguage();

  monaco.languages.registerCompletionItemProvider("graphql", {
    provideCompletionItems: (model, position) => {
      const tabId = schemaOwners.get(model.uri.toString());
      const schema = tabId ? useApiRuntimeStore.getState().graphqlSchemas[tabId] : undefined;
      if (!schema) return { suggestions: [] };

      const before = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const type = typeAtCursor(schema, before);
      // No suggestions at all beats a list of every field in the schema: a wrong completion that
      // looks authoritative is worse than Monaco's own word-based fallback.
      if (!type) return { suggestions: [] };

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions: MonacoLanguages.CompletionItem[] = type.fields.map((field) => ({
        label: field.name,
        kind:
          field.args.length > 0
            ? monaco.languages.CompletionItemKind.Method
            : monaco.languages.CompletionItemKind.Field,
        detail: renderTypeRef(field.type),
        documentation: field.description,
        insertText: field.name,
        range,
      }));
      suggestions.push({
        label: "__typename",
        kind: monaco.languages.CompletionItemKind.Field,
        detail: "String!",
        insertText: "__typename",
        range,
      });
      return { suggestions };
    },
  });
}

installGraphqlCompletions();

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `""`, `{}` and whitespace all mean "the user hasn't put anything here yet". */
function isBlankVariables(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed === "{}";
}

export function GraphqlPanel({ tabId }: { tabId: string }) {
  const t = useT();
  const graphql = useApiStore(
    (s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.body.graphql ?? null,
  );
  const updateDraft = useApiStore((s) => s.updateDraft);
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const schema = useApiRuntimeStore((s) => s.graphqlSchemas[tabId] ?? null);
  const setGraphqlSchema = useApiRuntimeStore((s) => s.setGraphqlSchema);

  const queryEditorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [variablesHeight, setVariablesHeight] = useState(140);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Claimed for the whole life of the panel rather than on editor mount, so the provider can find
  // the schema even while Monaco is still loading its model.
  useEffect(() => {
    const uri = monaco.Uri.parse(queryModelPath(tabId)).toString();
    schemaOwners.set(uri, tabId);
    return () => {
      schemaOwners.delete(uri);
    };
  }, [tabId]);

  /**
   * Reads the tab back out of the store instead of closing over `graphql`. Inserting a skeleton
   * writes the variables *and* lets Monaco's own `onChange` write the query a tick later; with a
   * closed-over value that second write would carry the pre-insert variables and undo the first.
   */
  const patchGraphql = (patch: Partial<GraphqlBody>) => {
    const tab = useApiStore.getState().openTabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    updateDraft(tabId, {
      body: { ...tab.draft.body, graphql: { ...tab.draft.body.graphql, ...patch } },
    });
  };

  const handleQueryMount: OnMount = (editor) => {
    queryEditorRef.current = editor;
  };

  /**
   * Introspection goes through `resolveRequest`/`sendResolved` like any other send, so it inherits
   * the request's auth, the proxy, the TLS settings and the cookie jar. A bare `fetch` here would
   * work against a public API and fail against every private one — which is most of them.
   */
  const fetchSchema = async () => {
    const store = useApiStore.getState();
    const tab = store.openTabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;

    setFetching(true);
    setError(null);
    try {
      const spec: ApiRequestSpec = {
        ...tab.draft,
        method: "POST",
        body: {
          ...tab.draft.body,
          mode: "graphql",
          graphql: { query: INTROSPECTION_QUERY, variables: "", operationName: "" },
        },
      };
      const resolved = await resolveRequest(
        spec,
        store.variableContext(tab.collectionId),
        store.authChainForTab(tabId),
        store.settings,
        store.cookies,
      );
      const response = await sendResolved(resolved);
      setGraphqlSchema(tabId, parseIntrospection(response.body_text));
    } catch (e) {
      const detail = messageOf(e);
      setError(detail);
      pushErrorToast(t("api.graphql.schemaFailed", { error: detail }));
    } finally {
      setFetching(false);
    }
  };

  const insertSkeleton = (operation: GqlOperation, field: GqlField) => {
    if (!schema || !graphql) return;
    const snippet = fieldSkeleton(schema, operation, field);
    const seed = variablesSkeleton(field);
    // Only seeds variables the user hasn't filled in — overwriting real values to save a few
    // keystrokes is not a trade anyone asked for.
    const variables = seed !== "{}" && isBlankVariables(graphql.variables) ? seed : graphql.variables;

    const editor = queryEditorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      if (variables !== graphql.variables) patchGraphql({ variables });
      // Through Monaco rather than through the draft, so the insert joins the undo stack and one
      // Ctrl+Z takes it back out.
      const selection = editor.getSelection();
      editor.executeEdits("cf-api-graphql", [
        {
          range: selection ?? model.getFullModelRange(),
          text: snippet,
          forceMoveMarkers: true,
        },
      ]);
      editor.pushUndoStop();
      editor.focus();
      return;
    }
    patchGraphql({ query: graphql.query ? `${graphql.query}\n\n${snippet}` : snippet, variables });
  };

  if (!graphql) return null;

  const status = fetching
    ? t("api.graphql.fetchingSchema")
    : error
      ? t("api.graphql.schemaFailed", { error })
      : schema
        ? t("api.graphql.schemaLoaded", { types: schema.types.length })
        : t("api.graphql.noSchema");

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
          <input
            value={graphql.operationName}
            onChange={(e) => patchGraphql({ operationName: e.target.value })}
            placeholder={t("api.graphql.operationName")}
            className="w-48 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-0.5 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
          />
          <button
            onClick={() => void fetchSchema()}
            disabled={fetching}
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-0.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] disabled:opacity-50 dark:hover:bg-white/[0.06]"
          >
            {fetching ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {t("api.graphql.fetchSchema")}
          </button>
          <span
            className={`min-w-0 flex-1 truncate text-[11px] ${
              error ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"
            }`}
            title={status}
          >
            {error && <AlertTriangle size={11} className="mr-1 inline align-[-1px]" />}
            {status}
          </span>
          <button
            onClick={() => setExplorerOpen((open) => !open)}
            title={t("api.graphql.explorer")}
            aria-label={t("api.graphql.explorer")}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
              explorerOpen
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.06] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
            }`}
          >
            {explorerOpen ? <PanelRightClose size={12} /> : <PanelRightOpen size={12} />}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 px-3 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("api.graphql.query")}
          </div>
          <div className="min-h-0 flex-1">
            <Editor
              height="100%"
              path={queryModelPath(tabId)}
              language="graphql"
              value={graphql.query}
              theme={monacoTheme}
              onMount={handleQueryMount}
              onChange={(value) => patchGraphql({ query: value ?? "" })}
              options={EDITOR_OPTIONS}
            />
          </div>

          <ResizeHandle
            axis="y"
            value={variablesHeight}
            min={VARIABLES_MIN}
            max={VARIABLES_MAX}
            // The handle sits above the pane it sizes, so dragging up has to grow it.
            invert
            onChange={setVariablesHeight}
            // Not persisted: the split belongs to this editing session, and `useLayoutStore`
            // has no key for it.
            onCommit={setVariablesHeight}
          />

          <div
            className="flex shrink-0 flex-col border-t border-[var(--cf-border)]"
            style={{ height: variablesHeight }}
          >
            <div className="flex shrink-0 items-center gap-1 px-3 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("api.graphql.variables")}
            </div>
            <div className="min-h-0 flex-1">
              <Editor
                height="100%"
                path={variablesModelPath(tabId)}
                language="json"
                value={graphql.variables}
                theme={monacoTheme}
                onChange={(value) => patchGraphql({ variables: value ?? "" })}
                options={EDITOR_OPTIONS}
              />
            </div>
          </div>
        </div>
      </div>

      {explorerOpen && (
        <div
          className="flex shrink-0 flex-col border-l border-[var(--cf-border)]"
          style={{ width: EXPLORER_WIDTH }}
        >
          {schema ? (
            <SchemaExplorer schema={schema} onInsert={insertSkeleton} />
          ) : (
            <EmptyState
              icon={Boxes}
              title={t("api.graphql.explorer")}
              subtitle={t("api.graphql.noSchema")}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

function SchemaExplorer({
  schema,
  onInsert,
}: {
  schema: GraphqlSchema;
  onInsert: (operation: GqlOperation, field: GqlField) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const needle = search.trim().toLowerCase();

  const roots = useMemo(
    () =>
      GQL_OPERATIONS.map((operation) => ({ operation, type: rootType(schema, operation) }))
        .map((entry) => ({
          operation: entry.operation,
          name: entry.type?.name ?? "",
          fields: (entry.type?.fields ?? []).filter(
            (field) => !needle || field.name.toLowerCase().includes(needle),
          ),
        }))
        .filter((entry) => entry.fields.length > 0),
    [schema, needle],
  );

  const types = useMemo(() => {
    const rootNames = new Set(
      [schema.queryType, schema.mutationType, schema.subscriptionType].filter(
        (name): name is string => name !== null,
      ),
    );
    return schema.types.filter((type) => {
      if (rootNames.has(type.name)) return false;
      if (!needle) return true;
      return (
        type.name.toLowerCase().includes(needle) ||
        type.fields.some((field) => field.name.toLowerCase().includes(needle))
      );
    });
  }, [schema, needle]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        <Search size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("api.graphql.searchPlaceholder")}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)]"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1.5">
        {roots.length === 0 && types.length === 0 && (
          <p className="px-2 py-4 text-[12px] text-[var(--cf-text-muted)]">{t("api.graphql.noMatches")}</p>
        )}

        {roots.map((root) => (
          <div key={root.operation} className="mb-2">
            <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {root.name}
            </div>
            {root.fields.map((field) => (
              <button
                key={field.name}
                onClick={() => onInsert(root.operation, field)}
                title={t("api.graphql.insertField")}
                className="flex w-full items-baseline gap-1.5 rounded px-2 py-0.5 text-left hover:bg-[var(--cf-accent-soft)]"
              >
                <span className="truncate text-[12px] text-[var(--cf-text)]">{field.name}</span>
                <span className="truncate text-[11px] text-[var(--cf-text-muted)]">
                  {renderTypeRef(field.type)}
                </span>
              </button>
            ))}
          </div>
        ))}

        {types.length > 0 && (
          <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("api.graphql.types")}
          </div>
        )}
        {types.map((type) => (
          <TypeRow
            key={type.name}
            type={type}
            open={expanded[type.name] === true}
            onToggle={() =>
              setExpanded((current) => ({ ...current, [type.name]: !current[type.name] }))
            }
          />
        ))}
      </div>
    </>
  );
}

function TypeRow({ type, open, onToggle }: { type: GqlType; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        <span className="truncate text-[12px] text-[var(--cf-text)]">{type.name}</span>
        <span className="ml-auto shrink-0 text-[10px] uppercase text-[var(--cf-text-muted)]">
          {type.kind.replace("_", " ")}
        </span>
      </button>

      {open && (
        <div className="mb-1 ml-3 border-l border-[var(--cf-border)] pl-2">
          {type.description && (
            <p className="py-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{type.description}</p>
          )}
          {type.fields.map((field) => (
            <Member
              key={field.name}
              name={field.name}
              type={renderTypeRef(field.type)}
              description={field.description}
            />
          ))}
          {type.inputFields.map((field) => (
            <Member
              key={field.name}
              name={field.name}
              type={renderTypeRef(field.type)}
              description={field.description}
            />
          ))}
          {type.enumValues.map((value) => (
            <Member key={value.name} name={value.name} type="" description={value.description} />
          ))}
          {/* A union has neither fields nor values — its members are the only thing to show. */}
          {type.kind === "UNION" &&
            type.possibleTypes.map((name) => <Member key={name} name={name} type="" description="" />)}
        </div>
      )}
    </div>
  );
}

function Member({ name, type, description }: { name: string; type: string; description: string }) {
  return (
    <div className="py-0.5">
      <div className="flex items-baseline gap-1.5">
        <span className="truncate text-[12px] text-[var(--cf-text)]">{name}</span>
        {type && <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{type}</span>}
      </div>
      {description && (
        <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{description}</p>
      )}
    </div>
  );
}
