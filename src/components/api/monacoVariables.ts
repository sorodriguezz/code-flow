/**
 * `{{variable}}` support for the API client's Monaco editors — the raw body, GraphQL, the gRPC
 * message and the stream composers — so they behave like every `VariableInput` field does:
 *
 * - typing `{{` completes from the environment, the collection, Globals and the dynamic variables;
 * - each token is tinted accent when the current scopes resolve it and danger when nothing does;
 * - hovering a token shows what it is worth and which scope it came from.
 *
 * The providers are registered once per language and answer only for models an editor claimed
 * through `useEditorVariables`. Monaco providers are global, and the same `javascript` language
 * also backs the scripts editor and the IDE, where `{{` means nothing.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS, IRange, languages as MonacoLanguages } from "monaco-editor";
import { monaco } from "../../lib/monacoSetup";
import {
  DYNAMIC_VARIABLES,
  findUnresolved,
  listVariables,
  lookupVariable,
  type VariableContext,
} from "../../lib/api/variables";
import { useApiStore } from "../../state/apiStore";
import { translate } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { VariableScope } from "../../types/api";

/** Every language an API editor can be set to. `text` is the body's own id for plain text, which
 * Monaco does not know and loads as `plaintext` — both are listed so either name is covered. */
const LANGUAGES = ["json", "xml", "html", "javascript", "plaintext", "text", "graphql"];

const TOKEN_SCAN = /\{\{([^{}]*)\}\}/g;

const SCOPE_LABELS: Record<VariableScope, TranslationKey> = {
  local: "api.scope.local",
  data: "api.scope.data",
  environment: "api.scope.environment",
  collection: "api.scope.collection",
  global: "api.scope.global",
};

const SECRET_MASK = "••••••";

/** Model URI → the context that editor resolves against right now. */
const owners = new Map<string, () => VariableContext | null>();

function contextFor(model: MonacoEditorNS.ITextModel): VariableContext | null {
  return owners.get(model.uri.toString())?.() ?? null;
}

/** Secret values stay masked here as they are in the environment editor. */
function isSecret(name: string, scope: VariableScope, ctx: VariableContext): boolean {
  const list =
    scope === "environment" ? ctx.environment : scope === "collection" ? ctx.collection : scope === "global" ? ctx.global : [];
  return list.some((variable) => variable.enabled && variable.key === name && variable.secret);
}

function shownValue(name: string, value: string, scope: VariableScope, ctx: VariableContext): string {
  return isSecret(name, scope, ctx) ? SECRET_MASK : value;
}

/** Wraps text in a Markdown code span that survives backticks inside it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

let installed = false;

function installProviders() {
  if (installed) return;
  installed = true;

  for (const language of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ["{"],
      provideCompletionItems: (model, position) => {
        const ctx = contextFor(model);
        if (!ctx) return { suggestions: [] };

        const line = model.getLineContent(position.lineNumber);
        const before = line.slice(0, position.column - 1);
        const start = before.lastIndexOf("{{");
        if (start === -1) return { suggestions: [] };
        if (/[{}]/.test(before.slice(start + 2))) return { suggestions: [] };

        // Re-editing `{{ba|}}` or `{{DO|MINIO}}` replaces the whole token, closing braces and the
        // tail of the name included — the same rule `VariableInput` follows.
        const after = line.slice(position.column - 1);
        const close = after.indexOf("}}");
        const tail = close !== -1 && !/[{}\s"'<>]/.test(after.slice(0, close)) ? close + 2 : 0;

        const range: IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: start + 1,
          endColumn: position.column + tail,
        };

        const defined = listVariables(ctx).map(
          (variable, index): MonacoLanguages.CompletionItem => ({
            label: { label: variable.name, description: translate(SCOPE_LABELS[variable.scope]) },
            kind: monaco.languages.CompletionItemKind.Variable,
            detail: shownValue(variable.name, variable.value, variable.scope, ctx),
            insertText: `{{${variable.name}}}`,
            filterText: `{{${variable.name}}}`,
            // Defined variables first, in resolution order; the generators after them.
            sortText: `0${String(index).padStart(4, "0")}`,
            range,
          }),
        );
        const dynamic = DYNAMIC_VARIABLES.map(
          (item, index): MonacoLanguages.CompletionItem => ({
            label: { label: item.name, description: translate("api.env.dynamicVariables") },
            kind: monaco.languages.CompletionItemKind.Function,
            detail: item.example,
            documentation: item.description,
            insertText: `{{${item.name}}}`,
            filterText: `{{${item.name}}}`,
            sortText: `1${String(index).padStart(4, "0")}`,
            range,
          }),
        );
        return { suggestions: [...defined, ...dynamic] };
      },
    });

    monaco.languages.registerHoverProvider(language, {
      provideHover: (model, position) => {
        const ctx = contextFor(model);
        if (!ctx) return null;
        const line = model.getLineContent(position.lineNumber);
        for (const match of line.matchAll(TOKEN_SCAN)) {
          const startColumn = (match.index ?? 0) + 1;
          const endColumn = startColumn + match[0].length;
          if (position.column < startColumn || position.column > endColumn) continue;
          const name = match[1].trim();
          if (name === "") return null;

          const found = lookupVariable(name, ctx);
          const dynamic = found ? undefined : DYNAMIC_VARIABLES.find((item) => item.name === name);
          const heading = found
            ? `**${codeSpan(name)}** · ${translate(SCOPE_LABELS[found.scope])}`
            : dynamic
              ? `**${codeSpan(name)}** · ${translate("api.env.dynamicVariables")}`
              : `**${codeSpan(name)}** · ${translate("api.env.unresolved")}`;
          const body = found
            ? codeSpan(shownValue(name, found.value, found.scope, ctx))
            : dynamic
              ? `${dynamic.description} — ${codeSpan(dynamic.example)}`
              : "";
          return {
            range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn, endColumn },
            contents: body ? [{ value: heading }, { value: body }] : [{ value: heading }],
          };
        }
        return null;
      },
    });
  }
}

/** The tint for every token in the model, resolved against `ctx`. */
function decorationsFor(model: MonacoEditorNS.ITextModel, ctx: VariableContext): MonacoEditorNS.IModelDeltaDecoration[] {
  const text = model.getValue();
  if (!text.includes("{{")) return [];
  const verdicts = new Map<string, boolean>();
  const out: MonacoEditorNS.IModelDeltaDecoration[] = [];
  for (const match of text.matchAll(TOKEN_SCAN)) {
    const name = match[1].trim();
    if (name === "") continue;
    let resolved = verdicts.get(name);
    if (resolved === undefined) {
      resolved = findUnresolved(`{{${name}}}`, ctx).length === 0;
      verdicts.set(name, resolved);
    }
    const start = model.getPositionAt(match.index ?? 0);
    const end = model.getPositionAt((match.index ?? 0) + match[0].length);
    out.push({
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      options: { inlineClassName: resolved ? "cf-api-var-resolved" : "cf-api-var-unresolved" },
    });
  }
  return out;
}

/**
 * The variable scopes a tab's editors resolve against, rebuilt whenever the environments, the
 * collections or the active environment change. Rebuilt rather than selected: `variableContext`
 * assembles a fresh object per call, and a selector that never returns the same reference twice
 * makes `useSyncExternalStore` re-render forever.
 */
export function useVariableContext(collectionId: string | null): VariableContext {
  const collections = useApiStore((s) => s.collections);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  return useMemo(
    () => useApiStore.getState().variableContext(collectionId),
    [collectionId, collections, environments, activeEnvironmentId], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/**
 * Wires `{{variable}}` completion, highlighting and hover into one Monaco editor. Pass the result
 * as the editor's `onMount` (or call it from yours). `null` switches it all off.
 *
 * Follows the editor across model swaps — `@monaco-editor/react` keeps one editor and changes its
 * model when `path` changes, which is how one body editor serves every tab.
 */
export function useEditorVariables(ctx: VariableContext | null): OnMount {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const repaint = useRef<() => void>(() => {});
  const teardown = useRef<(() => void) | null>(null);

  useEffect(() => {
    repaint.current();
  }, [ctx]);

  useEffect(() => () => teardown.current?.(), []);

  return useCallback<OnMount>((editor) => {
    installProviders();
    teardown.current?.();

    const decorations = editor.createDecorationsCollection();
    const getContext = () => ctxRef.current;
    let claimed: string | null = null;

    const release = () => {
      if (claimed && owners.get(claimed) === getContext) owners.delete(claimed);
      claimed = null;
    };
    const claim = () => {
      release();
      const model = editor.getModel();
      claimed = model ? model.uri.toString() : null;
      if (claimed) owners.set(claimed, getContext);
    };
    const paint = () => {
      const model = editor.getModel();
      const current = ctxRef.current;
      if (!model || !current) {
        decorations.clear();
        return;
      }
      decorations.set(decorationsFor(model, current));
    };

    claim();
    paint();
    const subscriptions = [
      editor.onDidChangeModel(() => {
        claim();
        paint();
      }),
      editor.onDidChangeModelContent(paint),
    ];
    repaint.current = paint;

    const dispose = () => {
      subscriptions.forEach((subscription) => subscription.dispose());
      release();
      repaint.current = () => {};
      teardown.current = null;
    };
    subscriptions.push(editor.onDidDispose(dispose));
    teardown.current = dispose;
  }, []);
}
