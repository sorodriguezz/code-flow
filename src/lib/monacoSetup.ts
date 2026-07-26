import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { ALL_THEMES, monacoThemeName } from "./codeThemes";
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
    rules: [
      { token: "", foreground: bare(theme.tokens.variable), background: bare(theme.ui.bg) },
      { token: "comment", foreground: bare(theme.tokens.comment), fontStyle: "italic" },
      { token: "keyword", foreground: bare(theme.tokens.keyword) },
      { token: "keyword.json", foreground: bare(theme.tokens.constant) },
      { token: "string", foreground: bare(theme.tokens.string) },
      { token: "string.key", foreground: bare(theme.tokens.variable) },
      { token: "string.value", foreground: bare(theme.tokens.string) },
      { token: "number", foreground: bare(theme.tokens.number) },
      { token: "regexp", foreground: bare(theme.tokens.string) },
      { token: "type", foreground: bare(theme.tokens.type) },
      { token: "type.identifier", foreground: bare(theme.tokens.type) },
      { token: "constant", foreground: bare(theme.tokens.constant) },
      { token: "function", foreground: bare(theme.tokens.fn) },
      { token: "identifier", foreground: bare(theme.tokens.variable) },
      { token: "variable", foreground: bare(theme.tokens.variable) },
      { token: "variable.predefined", foreground: bare(theme.tokens.constant) },
      { token: "operator", foreground: bare(theme.tokens.operator) },
      { token: "delimiter", foreground: bare(theme.ui.textMuted) },
      { token: "tag", foreground: bare(theme.tokens.tag) },
      { token: "metatag", foreground: bare(theme.tokens.tag) },
      { token: "attribute.name", foreground: bare(theme.tokens.attribute) },
      { token: "attribute.value", foreground: bare(theme.tokens.string) },
      { token: "annotation", foreground: bare(theme.tokens.attribute) },
    ],
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

export { monaco };
