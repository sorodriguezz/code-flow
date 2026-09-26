import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { ALL_THEMES, monacoThemeName, tokenRulesFor } from "./codeThemes";
import { installGoToDefinition } from "./goToDefinition";
import { installSnippets } from "./monacoSnippets";
import { installInlineCompletion } from "./inlineCompletion";
import { registerDbmlLanguage } from "./monacoDbml";
import { registerObjectScript } from "./monacoObjectScript";
import { registerCsvLanguages } from "./monacoCsv";
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
  const base = theme.mode === "dark" ? "vs-dark" : "vs";
  // Same rule list the code-snapshot renderer paints from — see `tokenRulesFor`. Only the
  // catch-all needs the extra `background`, which is a Monaco-only concern.
  const rules = tokenRulesFor(theme).map((rule) => ({
    token: rule.token,
    foreground: bare(rule.foreground),
    ...(rule.fontStyle ? { fontStyle: rule.fontStyle } : {}),
    ...(rule.token === "" ? { background: bare(theme.ui.bg) } : {}),
  }));
  const colors = {
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
  };
  monaco.editor.defineTheme(monacoThemeName(theme.id), {
    base,
    // Inherit so anything the palette doesn't name (regex literals, embedded languages) still
    // gets a sensible color from Monaco's own base theme instead of falling back to plain text.
    inherit: true,
    rules,
    colors,
  });
  // The same scheme for a see-through window (`lib/windowGlass`): the editor's own grounds cleared,
  // so the sheet under it shows through as it does everywhere else in the window. What floats over
  // code keeps a ground — the suggest, hover and find widgets. The current line becomes a tint
  // rather than a solid bar across the glass.
  //
  // The sticky-scroll band is frosted by `index.css`, which paints it once on `.sticky-widget`; its
  // own colours are cleared here because Monaco paints them on the gutter, the lines box and every
  // line inside it (`background-color: inherit`) — a see-through colour stacks three deep, and the
  // solid surface it had read as a black (or white) bar across the glass, the line numbers of the
  // code under it showing through its clear gutter. No shadow under it or under the scrolled top
  // edge either: `scrollbar.shadow` is pure black on a dark base, a dark line on the glass.
  //
  // The catch-all rule keeps its opaque `background` all the same: Monaco copies `editor.background`
  // into the token theme's default background, whose colour map has no alpha — `#00000000` arrives
  // there as black — and the overview ruler falls back to that default when it has no colour of
  // its own. The rule wins over the copy (it comes later), and the ruler gets its own clear colour.
  monaco.editor.defineTheme(monacoThemeName(theme.id, true), {
    base,
    inherit: true,
    rules,
    colors: {
      ...colors,
      "editor.background": "#00000000",
      "editorGutter.background": "#00000000",
      "minimap.background": "#00000000",
      "editorOverviewRuler.background": "#00000000",
      "editor.lineHighlightBackground": `${theme.ui.surfaceRaised}99`,
      "editorStickyScroll.background": "#00000000",
      "editorStickyScrollGutter.background": "#00000000",
      "editorStickyScrollHover.background": `${theme.ui.surfaceRaised}99`,
      "editorStickyScroll.border": theme.ui.border,
      "editorStickyScroll.shadow": "#00000000",
      "scrollbar.shadow": "#00000000",
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
// DBML, for `.dbml` files in the editor and for the Diagrams workspace's schema editor. Cheap:
// a Monarch grammar and four snippets, with no dependency on `@dbml/core`. See `monacoDbml.ts`.
registerDbmlLanguage();
// `.csv` / `.tsv` / `.psv`, one colour per column, one language per separator. Above the two
// installers for the same reason as the two lines above: a plain-text file got snippets and
// Ctrl/Cmd+click before it had a language of its own, and should keep both. See `monacoCsv.ts`.
registerCsvLanguages();

// Ctrl/Cmd+click to jump to a definition. Registered here, once, because both halves of it (the
// definition provider and the editor opener) are global to Monaco rather than per-instance —
// see `installGoToDefinition`.
installGoToDefinition();

// The user's own snippets, offered in the completion dropdown of every language. Registered after
// `registerObjectScript` for the same reason as the line above — the language list is read here.
installSnippets();

// Ghost text from the model on this machine, in the three editors it is wanted in — see `SURFACES`
// in `useInlineCompletion`. Here rather than in `EditorPane` because it is not the code editor's
// feature any more: the DBML workbench and the database console get it too, and installing it from
// a pane means it is missing until that pane has been opened. The provider declines every model
// that is not one of the three, and declines all of them while the feature is off.
installInlineCompletion(monaco);

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

/**
 * The face a code editor draws in: JetBrains Mono, the app's own mono (`--font-mono` in
 * `index.css`), so the code in an editor and the hashes, paths and keys around it are one face.
 *
 * A string for Monaco's `fontFamily` option rather than the CSS variable: Monaco measures glyphs by
 * the family name it is given, and `var(--font-mono)` is not a name. The tail is the same fallback
 * ladder the variable ends in. Deliberately *not* folded into `OVERFLOW_SAFE_OPTIONS` — that one is
 * about clipping, and an editor that wants another face (the notes editor draws prose in the UI
 * sans) must be able to take the overflow fix without this.
 */
export const CODE_FONT_FAMILY = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

/**
 * Monaco measures a font once, the first time an editor asks for it, and caches the widths per
 * family — while the bundled face is an `@font-face` that the webview only fetches once something
 * uses it. An editor that mounted before the file arrived measured the *fallback's* advance widths
 * and would draw its cursor and selections at those, over text drawn in the real face: a caret that
 * drifts a little further off with every column.
 *
 * So the face is asked for up front (regular and italic, which some themes use for comments), and
 * Monaco's cache is thrown away once, when the fonts have settled. `load` rather than only
 * `document.fonts.ready`, which resolves at once when nothing has requested the face yet — the
 * exact case this exists for. Guarded, because the test environment has no `FontFaceSet`.
 */
if (typeof document !== "undefined" && document.fonts) {
  void Promise.all([
    document.fonts.load('13px "JetBrains Mono Variable"'),
    document.fonts.load('italic 13px "JetBrains Mono Variable"'),
  ])
    .then(() => document.fonts.ready)
    .then(() => monaco.editor.remeasureFonts())
    .catch(() => {});
}
