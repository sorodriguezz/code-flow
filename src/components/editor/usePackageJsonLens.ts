import { useEffect, useId, useRef } from "react";
import type { editor as MonacoEditorNS, IDisposable, languages } from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import { dependencyBlocks, scriptLines, scriptsBlockLine } from "../../lib/packageJsonSpans";
import { isOutdated, npmLatestVersions, updateKind, type LatestVersion } from "../../lib/npm";
import { PACKAGE_JSON } from "../../lib/packageScripts";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * What a `package.json` gets on top of being JSON: a run button beside every script, and a box over
 * each dependency block that can tell you what is out of date.
 *
 * # Why the annotations live here and not in `EditorPane`
 *
 * `EditorPane` is already the largest component in the app and owns eleven kinds of decoration.
 * These are the first that are about *one filename* rather than about the editor, and they are the
 * first that talk to the network. Kept apart, the pane gains one call and the rules for what a
 * manifest shows stay somewhere they can be read in one sitting.
 *
 * # Nothing is fetched until it is asked for
 *
 * The box appears immediately and says how many dependencies the block holds; the versions arrive
 * only when the lens is clicked. IntelliJ checks on open, and for a tool that already indexes your
 * project that is free — here it would mean every `package.json` you glance at silently posting your
 * dependency list to a third party, on a machine that may be offline or on someone's metered
 * connection. One click is a small price for that not happening behind your back, and the answer is
 * cached for as long as the file stays open.
 *
 * # The line numbers come from a scanner, not from `JSON.parse`
 *
 * See `lib/packageJsonSpans`. Parsing throws away every position, and the keys being annotated —
 * `dependencies`, `build` — are spelled exactly like keys nested inside `jest` and `pnpm.overrides`
 * that must not be annotated.
 */

/** What the hook needs from the pane. */
interface Options {
  /**
   * The file on screen.
   *
   * Only used to know when the cached versions stop applying — *what* gets annotated is decided
   * against the editor's own model, so a pane showing something else can never borrow these. See
   * the note on the lens effect's dependencies.
   */
  activePath: string | null;
  /**
   * The arrow beside `name` was pressed, at `at`.
   *
   * It reports rather than runs, and that is the whole of the change: the arrow opens the menu in
   * `EditorPane` — run it, run it with another manager, copy the line — the way a gutter arrow does
   * in every editor that has one. A click that started a build with no way to say *how* was the one
   * shape this control could not take.
   *
   * The point comes with it because the menu opens **at the arrow**, where the question was asked.
   */
  onScriptArrow: (name: string, at: { x: number; y: number }) => void;
  /** Opens the add-dependency picker for this block. */
  onAddDependency: (block: string) => void;
  /** Which manager the run arrows will use, and where that came from. */
  manager: { manager: string; source: "explicit" | "lockfile" | "fallback" };
  /** Sets the manager explicitly, or `null` to go back to detecting it. */
  onChooseManager: (manager: string | null) => void;
  /** Translations, passed in so this file does not reach for a store. Typed as the app's own `t`
   *  rather than loosely, so a key that does not exist is a compile error here too. */
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/** The registry answer for the manifest on screen, keyed by package name. */
type Versions = Map<string, LatestVersion>;

export function usePackageJsonLens(
  editor: MonacoEditorNS.IStandaloneCodeEditor | null,
  monaco: Monaco | null,
  { activePath, onScriptArrow, onAddDependency, manager, onChooseManager, t }: Options,
) {
  /** Latest versions for the manifest on screen. Cleared when the file changes — the answer is
   *  about *this* manifest's packages and carrying it over would annotate the wrong lines. */
  const versions = useRef<Versions>(new Map());
  /** Blocks whose lookup is in flight, so a second click cannot start a second batch. */
  const loading = useRef<Set<string>>(new Set());
  /** The `→ 1.2.3` at the end of each dependency line, and the gutter mark on the ones whose range
   *  refuses that version. One collection: they are drawn and cleared together. */
  const versionMarks = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null);
  /** Bumped to make Monaco re-ask the provider once an answer lands. */
  const refresh = useRef<(() => void) | null>(null);
  /** Redraws the marks above. Held in a ref so the file-change effect can ask for it without owning
   *  the collection. */
  const redraw = useRef<(() => void) | null>(null);
  /**
   * A suffix that makes this instance's command ids its own.
   *
   * Command ids are global to the Monaco instance, and this hook runs once per editor pane. With two
   * panes open both registered `cf.npm.check`, and the registry answers with one of them — so
   * pressing "check versions" in one pane could run the *other* pane's handler, filling a map the
   * pane you are looking at never reads. Scoped ids keep each pane's lenses wired to its own state.
   */
  const scope = useId();
  /** Held in refs so the provider — registered once — always calls the current ones. */
  const actions = useRef({ onScriptArrow, onAddDependency, manager, onChooseManager, t });
  actions.current = { onScriptArrow, onAddDependency, manager, onChooseManager, t };

  // A new file is a new set of answers. Both halves are told: the lenses, which is where the count
  // and the "check versions" offer live, and the marks — a `→ 1.2.3` left over from the file you
  // just closed would otherwise sit on this one until its next keystroke.
  useEffect(() => {
    versions.current = new Map();
    loading.current = new Set();
    refresh.current?.();
    redraw.current?.();
  }, [activePath]);

  /**
   * The run buttons, as glyph-margin decorations.
   *
   * A decoration and not a CodeLens: a lens is a line of text *above* the code that pushes every
   * following line down, and a manifest with twelve scripts would grow twelve blank-ish rows and
   * stop looking like the file it is.
   *
   * **The lines-decorations lane, not the glyph margin**, and that is two fixes in one. Visually the
   * glyph margin sits to the *left* of the line numbers, which put the arrow in a different column
   * from the code it runs; this lane is between the numbers and the text, where every editor that
   * has this feature draws it. And functionally the glyph margin already belongs to breakpoints:
   * its `onMouseDown` fires on every click in that lane with no condition, and because Monaco
   * notifies each `onMouseDown` subscriber independently, `stopPropagation` on the DOM event does
   * nothing to it — so pressing the arrow ran the script *and* set a breakpoint.
   */
  useEffect(() => {
    if (!editor || !monaco) return;

    let collection: MonacoEditorNS.IEditorDecorationsCollection | null = null;
    /** The scripts of whatever is on screen, and where they are. Empty for anything else. */
    let lines = new Map<string, number>();

    const draw = () => {
      // Asked of the editor on every pass rather than captured once, for the same reason the lens
      // below is registered per editor: one pane shows many files over its life, and a `lines` map
      // left over from the last one would put arrows on lines that have nothing to do with it —
      // and, worse, would answer a click with the wrong script's name.
      const model = editor.getModel();
      collection?.clear();
      if (!model || model.uri.path.split("/").pop() !== PACKAGE_JSON) {
        collection = null;
        lines = new Map();
        return;
      }
      lines = scriptLines(model.getValue());
      collection = editor.createDecorationsCollection(
        [...lines.entries()].map(([name, line]) => ({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            linesDecorationsClassName: "cf-script-glyph",
            linesDecorationsTooltip: actions.current.t("scripts.runGlyph", { name }),
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })),
      );
    };

    draw();
    // Redrawn on edit, because a script added or a line inserted above one moves every arrow below
    // it — and on a model change, because that is a different file with different scripts. Debounced
    // by Monaco's own change batching rather than a timer: the scan is a single pass over a file
    // measured in kilobytes.
    const changed = editor.onDidChangeModelContent(() => draw());
    const swapped = editor.onDidChangeModel(() => draw());

    const clicked = editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const line = event.target.position?.lineNumber;
      if (!line) return;
      // This lane is shared with the change-peek marks, so a click is ours only when a script is
      // actually on that line. Anything else falls through to whoever else is listening.
      const name = [...lines.entries()].find(([, at]) => at === line)?.[0];
      if (!name) return;
      event.event.stopPropagation();
      actions.current.onScriptArrow(name, { x: event.event.posx, y: event.event.posy });
    });

    return () => {
      changed.dispose();
      swapped.dispose();
      clicked.dispose();
      collection?.clear();
    };
  }, [editor, monaco]);

  /**
   * The dependency box: one CodeLens over each block's own line.
   *
   * A lens here and a glyph for the scripts, because the two are different shapes of thing. This one
   * is about a *block* — it belongs above it, it carries words rather than an icon, and there are at
   * most four of them in a file, so the rows it adds cost nothing.
   */
  useEffect(() => {
    if (!editor || !monaco) return;

    const disposables: IDisposable[] = [];

    /**
     * The newest published version of each dependency, printed at the end of its own line.
     *
     * The box counts; this says *which*, and *what to*. A heading reading "4 out of date" over
     * fifteen rows is a number you cannot act on — you still have to find the four by hand and then
     * look each one up to learn what it should say instead, which is the work the box was supposed
     * to have done.
     *
     * # Two decorations per line, and why the first attempt drew nothing
     *
     * The version is **injected text** anchored at the line's last column — the same mechanism the
     * blame annotation in `EditorPane` uses, and for the same reasons: it renders past the end of
     * the line without moving anything to its left, and it is not model content, so `getValue`, a
     * copy and the code-snapshot capture never see it.
     *
     * The note that used to sit here concluded Monaco would not render injected text in this app at
     * all. It does — what was missing is **`showIfCollapsed`**. `getInjectedTextInInterval` in
     * `TextModel` ends with `.filter(i => i.options.showIfCollapsed || !i.range.isEmpty())`, so an
     * `after` hung on a zero-width range without that flag is dropped before the view ever asks for
     * it: the decoration is created, its options survive `getAllDecorations`, and nothing is drawn.
     * Checked against this project's monaco (0.56) in a bench — without the flag the model reports
     * zero injected decorations, with it the span appears as `mtk1 cf-dep-latest`.
     *
     * That `mtk1` is also why the colour in `index.css` is `!important`: the span carries the
     * theme's own token class alongside ours, from a stylesheet injected after that file.
     *
     * The mark stays a second decoration on its own whole-line range, because the two are different
     * shapes — one is a point past the end of the line, the other is the line.
     *
     * # The in-range ones get the number too, without the colour
     *
     * `^1.14.0` against a published `1.20.2` is not a problem: the caret already accepts it, and an
     * install takes it without this file changing. But "what is current?" is precisely what was
     * asked when the check was clicked, so the version is printed, dimmed, with no dot and no tint.
     * Only what a range *refuses* is amber. See `updateKind`.
     */
    const drawVersions = () => {
      const model = editor.getModel();
      // The model, not `activePath`: this effect now outlives any one file, so what is on screen is
      // the only thing that can say whether these marks belong. A JSON file that is not a manifest
      // gets an empty collection, which is also how the old ones are cleared.
      if (!model || model.uri.path.split("/").pop() !== PACKAGE_JSON) {
        versionMarks.current?.clear();
        versionMarks.current = null;
        return;
      }
      const raw = model.getValue();
      const lines = raw.split("\n");
      const decorations: MonacoEditorNS.IModelDeltaDecoration[] = [];
      for (const block of dependencyBlocks(raw)) {
        const pinned = pinnedRanges(lines, block.entries);
        for (const [name, line] of block.entries) {
          const found = versions.current.get(name);
          const range = pinned.get(name);
          if (!found || found.error || !range) continue;
          const kind = updateKind(range, found.latest);
          if (kind === "none") continue;
          const stale = kind === "outOfRange";
          // Monaco's own count of where the line ends, rather than `lines[line - 1].length`, which
          // would be off by one and by whatever a `\r` at the end of the line does.
          const column = model.getLineMaxColumn(line);
          decorations.push({
            range: new monaco.Range(line, column, line, column),
            options: {
              after: {
                content: `  → ${found.latest}`,
                inlineClassName: stale ? "cf-dep-latest cf-dep-latest-stale" : "cf-dep-latest",
                // Otherwise End and the arrow keys step into a version that is not in the file,
                // which would make a decoration feel like text you can put a cursor in.
                cursorStops: monaco.editor.InjectedTextCursorStops.None,
              },
              // Required, not decorative: this range is zero-width, and Monaco drops injected text
              // on an empty range without it. See the note above.
              showIfCollapsed: true,
              // What the number means, kept off the line itself: the two cases look different but a
              // dimmed `→ 1.20.2` still owes an explanation of why it is not flagged.
              hoverMessage: {
                value: actions.current.t(stale ? "npm.hoverOutOfRange" : "npm.hoverInRange", {
                  name,
                  range,
                  latest: found.latest,
                }),
              },
              // Typing at the end of an annotated line is the common case here — that is where a
              // version is edited — and the default stickiness would drag the number along with it.
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          });
          if (!stale) continue;
          decorations.push({
            range: new monaco.Range(line, 1, line, 1),
            options: {
              // The same lane and the same mechanism as the run arrows.
              linesDecorationsClassName: "cf-dep-outdated",
              linesDecorationsTooltip: `${name}: ${range} → ${found.latest}`,
              // Whole-line tint as well, so "which ones" is answerable by looking down the block
              // rather than by reading every version at the right-hand edge.
              isWholeLine: true,
              className: "cf-dep-outdated-line",
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          });
        }
      }
      versionMarks.current?.clear();
      versionMarks.current = editor.createDecorationsCollection(decorations);
    };

    /** Asks the registry about one block and redraws when the answer lands. */
    const check = async (block: string, names: string[]) => {
      if (loading.current.has(block)) return;
      loading.current.add(block);
      refresh.current?.();
      try {
        for (const row of await npmLatestVersions(names)) versions.current.set(row.name, row);
      } catch {
        // A failed batch leaves the block un-annotated rather than showing a wrong answer. The lens
        // returns to offering the check, so the way to retry is the way you started.
      } finally {
        loading.current.delete(block);
        refresh.current?.();
        drawVersions();
      }
    };

    /**
     * The lens actions, registered **globally** rather than on the editor.
     *
     * `editor.addCommand` binds a command to one editor instance and hands back a generated id.
     * A CodeLens is drawn by a provider registered on `monaco.languages` — global — and its click
     * resolves the id against the global command service, where an editor-scoped command may simply
     * not be found. The entry then renders as a link that does nothing when pressed, which is what
     * the manager options did: `pnpm` and `yarn` were on screen and inert.
     *
     * `registerCommand` puts them where the lens looks. Fixed ids, disposed with the effect, so a
     * remount replaces rather than accumulates.
     */
    const commands = {
      check: `cf.npm.check.${scope}`,
      add: `cf.npm.add.${scope}`,
      manager: `cf.npm.manager.${scope}`,
    };
    disposables.push(
      monaco.editor.registerCommand(commands.check, (_ctx: unknown, block: string, names: string[]) =>
        void check(block, names),
      ),
      monaco.editor.registerCommand(commands.add, (_ctx: unknown, block: string) =>
        actions.current.onAddDependency(block),
      ),
      monaco.editor.registerCommand(commands.manager, (_ctx: unknown, next: string | null) =>
        actions.current.onChooseManager(next),
      ),
    );

    const provider: languages.CodeLensProvider = {
      // Monaco's `IEvent<this>`: the listener takes the provider and nothing else, and `self` is
      // only the `thisArg` to call it with. This is how an answer that arrives from the network
      // gets the lenses redrawn without touching the model.
      onDidChange: (listener, self) => {
        refresh.current = () => listener.call(self, provider);
        return { dispose: () => (refresh.current = null) };
      },
      provideCodeLenses: (model) => {
        // Registered for the whole `json` language, so every other JSON file passes through here,
        // and one provider exists per editor pane. Two gates, and both are needed:
        //
        // * the filename, because `dependencies` boxes belong to manifests and nothing else;
        // * `model === editor.getModel()`, because the answer is drawn from *this* pane's state —
        //   its cached versions, its in-flight checks. Monaco asks every registered provider, so
        //   without this a second pane would answer for a manifest it is not showing and the file
        //   would draw every lens twice, one set of them wired to a map nobody is filling.
        const name = model.uri.path.split("/").pop();
        if (name !== PACKAGE_JSON || model !== editor.getModel()) {
          return { lenses: [], dispose: () => undefined };
        }

        const raw = model.getValue();
        // Split once for the whole pass, not once per package.
        const lines = raw.split("\n");
        const lenses: languages.CodeLens[] = [];

        /**
         * Which package manager the run arrows will use, over the `scripts` key.
         *
         * This is the only place the choice can be made now. It used to live on a header row above
         * the script list in the file tree; that list is gone — the arrows in the gutter replaced it
         * — and the picker would have gone with it, leaving the manager detectable but never
         * overridable. It belongs here anyway: the decision is about the block underneath it, and
         * this is where the scripts now are.
         *
         * The label says where the answer came from, because "pnpm" alone cannot distinguish a
         * lockfile that was found from a fallback that guessed.
         */
        const scriptsLine = scriptsBlockLine(raw);
        if (scriptsLine !== null) {
          const at = new monaco.Range(scriptsLine, 1, scriptsLine, 1);
          const { manager, source } = actions.current.manager;
          lenses.push({
            range: at,
            command: {
              id: "",
              title: actions.current.t(
                source === "explicit"
                  ? "npm.managerChosen"
                  : source === "lockfile"
                    ? "npm.managerFromLock"
                    : "npm.managerFallback",
                { manager },
              ),
            },
          });
          for (const option of ["pnpm", "yarn", "npm"]) {
            if (option === manager) continue;
            lenses.push({
              range: at,
              command: {
                id: commands.manager,
                title: option,
                arguments: [option],
              },
            });
          }
          // Only offered once a choice has been made, because it is what undoes one.
          if (source === "explicit") {
            lenses.push({
              range: at,
              command: {
                id: commands.manager,
                title: actions.current.t("npm.managerAuto"),
                arguments: [null],
              },
            });
          }
        }

        for (const block of dependencyBlocks(raw)) {
          const names = [...block.entries.keys()];
          const pinned = pinnedRanges(lines, block.entries);
          const range = new monaco.Range(block.line, 1, block.line, 1);
          const answered = names.filter((entry) => versions.current.has(entry));
          const busy = loading.current.has(block.name);

          lenses.push({
            range,
            command: {
              id: "",
              title: actions.current.t("npm.lensCount", { n: String(names.length) }),
            },
          });

          if (busy) {
            lenses.push({ range, command: { id: "", title: actions.current.t("npm.lensChecking") } });
          } else if (answered.length === 0) {
            lenses.push({
              range,
              command: {
                id: commands.check,
                title: actions.current.t("npm.lensCheck"),
                arguments: [block.name, names],
              },
            });
          } else {
            // Counted from what the registry actually answered, so a package it could not resolve
            // is neither "outdated" nor quietly folded into "up to date".
            const stale = names.filter((entry) => {
              const found = versions.current.get(entry);
              const range = pinned.get(entry);
              return found && range ? isOutdated(range, found.latest) : false;
            });
            const failed = answered.filter((entry) => versions.current.get(entry)?.error);
            lenses.push({
              range,
              command: {
                id: commands.check,
                title:
                  stale.length > 0
                    ? actions.current.t("npm.lensOutdated", { n: String(stale.length) })
                    : actions.current.t("npm.lensCurrent"),
                arguments: [block.name, names],
              },
            });
            if (failed.length > 0) {
              lenses.push({
                range,
                command: { id: "", title: actions.current.t("npm.lensFailed", { n: String(failed.length) }) },
              });
            }
          }

          lenses.push({
            range,
            command: {
              id: commands.add,
              title: actions.current.t("npm.lensAdd"),
              arguments: [block.name],
            },
          });
        }

        return { lenses, dispose: () => undefined };
      },
    };

    redraw.current = drawVersions;
    disposables.push(monaco.languages.registerCodeLensProvider("json", provider));
    // Whatever is already known, drawn now: the effect also runs on a remount, and the versions from
    // a check made before it would otherwise be cleared with the old collection and never come back.
    drawVersions();
    // Both events, and both on the *editor* rather than on one model: lines move when the file is
    // edited, and the file itself changes under this editor every time a tab is clicked.
    disposables.push(
      editor.onDidChangeModelContent(() => drawVersions()),
      editor.onDidChangeModel(() => drawVersions()),
    );

    return () => {
      for (const item of disposables) item.dispose();
      versionMarks.current?.clear();
      versionMarks.current = null;
      refresh.current = null;
      redraw.current = null;
    };
    /**
     * **Not keyed to the open file**, and that is the fix for lens rows landing on the wrong one.
     *
     * With `isManifest` in here, every tab switch away from a manifest unregistered the provider.
     * That fires the language registry's own change event, which makes each editor schedule a
     * *debounced* recompute of its lenses — and the model swap for the new tab lands inside that
     * window. What Monaco then had was a recompute belonging to the manifest and a view showing the
     * next file, so the lens widgets stayed, unanchored, drawn straight over whatever code was
     * underneath. Reproduced exactly that way against monaco 0.56, and gone the moment the
     * registration stops moving.
     *
     * Registered once per editor instead, deciding per model. The provider is cheap on a file it has
     * nothing to say about — one filename comparison — and Monaco already clears a model's lenses
     * when the model changes, which is the path that was working all along.
     */
  }, [editor, monaco, scope]);

}

/**
 * The version each entry of a block is pinned at, read straight off its line.
 *
 * Takes the already-split lines and returns the whole block at once. Written per-package first, it
 * re-scanned the document and re-split it for *every* dependency — a full pass each, thirty-odd
 * times per block, on every keystroke that redraws a lens. The line is known already; the value is
 * the quoted half after the colon.
 */
function pinnedRanges(lines: string[], entries: Map<string, number>): Map<string, string> {
  const ranges = new Map<string, string>();
  for (const [name, line] of entries) {
    const match = /:\s*"([^"]*)"/.exec(lines[line - 1] ?? "");
    if (match) ranges.set(name, match[1]);
  }
  return ranges;
}
