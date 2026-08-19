import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { ALL_THEMES, monacoThemeName, tokenRulesFor } from "./codeThemes";
import { installGoToDefinition } from "./goToDefinition";
import { installSnippets } from "./monacoSnippets";
import { registerObjectScript } from "./monacoObjectScript";
// Subpaths go through the package's own `exports` map (`./*` → `./esm/vs/*.js`), so these are
// the mapped specifiers, not the on-disk paths.
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

/** Imported for its side effects from `main.tsx`, before anything renders.
 *
 * Two things happen here, and both have to happen exactly once, at startup:
 *
 * 1. **Monaco is bundled, not fetched.** `@monaco-editor/react` defaults to pulling the editor
 *    from a CDN at runtime — which means the Editor, the diff views and conflict resolution all
 *    silently need an internet connection in what is otherwise an offline-capable desktop app.
 *    Handing `loader` our own bundled copy removes that dependency entirely.
 * 2. **Its language workers are wired up.** Bundled Monaco has no idea how to spawn its web
 *    workers; without this it falls back to running language services on the UI thread (or
 *    logging "You must define MonacoEnvironment.getWorkerUrl"), which is what makes a large file
 *    feel like it's chewing gum.
 */

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

/** Monaco's token rules want a bare hex (`ff79c6`); its `colors` map wants the `#`. */
function bare(hex: string): string {
  return hex.replace("#", "");
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

// Monaco's TypeScript worker type-checks each open file *in isolation*: no tsconfig, no
// node_modules, no sibling files. Every relative import therefore resolves to nothing and the
// editor paints red squiggles under `export * from "./types"` (TS2792) and every library import
// in the project — errors about a project it cannot see, not about the code. Syntax validation
// stays on, since that part it can actually judge. Real, project-aware diagnostics are what a
// language server is for; when one is wired up, this is the line that goes away.
const isolatedFileDiagnostics = { noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true };
monaco.typescript.typescriptDefaults.setDiagnosticsOptions(isolatedFileDiagnostics);
monaco.typescript.javascriptDefaults.setDiagnosticsOptions(isolatedFileDiagnostics);

// Every scheme is registered up front rather than on demand: `defineTheme` is cheap (it just
// stores a rule list), and having them all present means switching themes — or mounting an
// editor that already has one selected — can never race a definition that hasn't happened yet.
for (const theme of ALL_THEMES) {
  monaco.editor.defineTheme(monacoThemeName(theme.id), {
    base: theme.mode === "dark" ? "vs-dark" : "vs",
    // Inherit so anything the palette doesn't name (regex literals, embedded languages) still
    // gets a sensible color from Monaco's own base theme instead of falling back to plain text.
    inherit: true,
    // Same rule list the code-snapshot renderer paints from — see `tokenRulesFor`. Only the
    // catch-all needs the extra `background`, which is a Monaco-only concern.
    rules: tokenRulesFor(theme).map((rule) => ({
      token: rule.token,
      foreground: bare(rule.foreground),
      ...(rule.fontStyle ? { fontStyle: rule.fontStyle } : {}),
      ...(rule.token === "" ? { background: bare(theme.ui.bg) } : {}),
    })),
    colors: {
      "editor.background": theme.ui.bg,
      "editor.foreground": theme.tokens.variable,
      "editorLineNumber.foreground": theme.ui.textMuted,
      "editorLineNumber.activeForeground": theme.ui.text,
      "editorCursor.foreground": theme.ui.text,
      "editor.lineHighlightBackground": theme.ui.surfaceRaised,
      // Alpha so the selection tints the code rather than hiding it.
      "editor.selectionBackground": `${theme.ui.border}cc`,
      "editor.inactiveSelectionBackground": `${theme.ui.border}80`,
      "editorIndentGuide.background1": theme.ui.border,
      "editorWhitespace.foreground": theme.ui.border,
      "editorWidget.background": theme.ui.surface,
      "editorWidget.border": theme.ui.border,
      "editorSuggestWidget.background": theme.ui.surface,
      "editorGutter.background": theme.ui.bg,
      "diffEditor.insertedTextBackground": "#22c55e22",
      "diffEditor.removedTextBackground": "#ef444422",
      "scrollbarSlider.background": `${theme.ui.border}99`,
      "minimap.background": theme.ui.bg,
    },
  });
}

/**
 * Decorators get a token of their own, because Monaco's TypeScript grammar has none.
 *
 * `@Controller()` tokenizes as **`invalid`** followed by `type.identifier`: `@` is not in the
 * grammar's `symbols` set and no rule claims it, so it falls through to the catch-all every Monarch
 * grammar ends with. Themes paint `invalid` in whatever they reserve for broken syntax — red, in all
 * of ours — so a perfectly good NestJS or Angular file shows a red `@` against an amber name on
 * every decorator, in every theme. That is why this is fixed in the grammar rather than in a
 * palette: no colour choice can make "invalid" mean "decorator".
 *
 * The rule goes on the *front* of the shared `common` state so it beats the identifier rules, and it
 * is added to the very definition object Monaco is about to hand Monarch — language modules are
 * singletons, so mutating one is enough — with an explicit re-register for the case where the
 * language was already compiled by the time this runs.
 *
 * `annotation` is a token the palettes already colour (see `tokenRulesFor`), so nothing else has to
 * change. Strings and comments keep their tokens: both are separate tokenizer states, so `'@x'` and
 * `// @param` never reach this rule. Checked against monaco 0.56 with `editor.tokenize`.
 */
async function tokenizeDecorators() {
  for (const id of ["typescript", "javascript"]) {
    // `loader` is how Monaco itself fetches the grammar the first time the language is needed. It
    // is on the registry entry but not on its public type, hence the cast.
    const entry = monaco.languages
      .getLanguages()
      .find((language) => language.id === id) as
      | (monaco.languages.ILanguageExtensionPoint & {
          loader?: () => Promise<{ language?: monaco.languages.IMonarchLanguage }>;
        })
      | undefined;
    const language = (await entry?.loader?.())?.language;
    const common = (language?.tokenizer as { common?: unknown[] } | undefined)?.common;
    if (!language || !Array.isArray(common)) continue;
    // TypeScript and JavaScript share pieces of one definition, so the second pass would otherwise
    // insert a duplicate rule.
    if (common.some((rule) => Array.isArray(rule) && rule[1] === "annotation")) continue;
    common.unshift([/@[a-zA-Z_$][\w$]*/, "annotation"]);
    monaco.languages.setMonarchTokensProvider(id, language);
  }
}

void tokenizeDecorators();

export { monaco };

// ObjectScript, for `.cls` / `.mac` / `.int` / `.inc`. Registered *above* `installGoToDefinition`,
// which snapshots the language list at call time — a language registered after it gets no
// Ctrl/Cmd+click, which is exactly why `graphql` has none.
registerObjectScript();

// Ctrl/Cmd+click to jump to a definition. Registered here, once, because both halves of it (the
// definition provider and the editor opener) are global to Monaco rather than per-instance —
// see `installGoToDefinition`.
installGoToDefinition();

// The user's own snippets, offered in the completion dropdown of every language. Registered after
// `registerObjectScript` for the same reason as the line above — the language list is read here.
installSnippets();

/**
 * Options every embedded editor needs so its overlay widgets aren't clipped.
 *
 * Monaco renders the find widget, hovers and suggestions *inside* the editor's own DOM. Every
 * editor in this app sits in a pane that clips (`overflow-hidden` on the panel, plus the flex
 * columns above it), so those widgets get cut at the pane edge — and the part that gets cut is
 * the right-hand end, which is where the find widget keeps its close button.
 *
 * `fixedOverflowWidgets` moves them into a fixed-position container on `document.body`, outside
 * every clipping ancestor. Spread this into an editor's `options` rather than repeating the flag,
 * so a new editor can't quietly reintroduce the same bug.
 */
export const OVERFLOW_SAFE_OPTIONS = { fixedOverflowWidgets: true } as const;
