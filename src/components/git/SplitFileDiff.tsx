import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import type { FileDiffInfo } from "../../types/domain";
import { useThemeStore } from "../../state/themeStore";
import { languageForPath } from "../../lib/monacoLanguage";
import { reconstructSides } from "../../lib/diffText";
// The side effects Monaco needs before the first `<DiffEditor>` mounts — the bundled copy handed to
// `@monaco-editor/react` (so nothing is fetched from a CDN), the language workers, and the 21 theme
// definitions. `main.tsx` used to import this at startup; it doesn't any more, precisely so that a
// session which never opens a diff in split mode never pays for Monaco at all. Every module that
// puts an editor on screen now has to say so itself, and this is that statement for this one.
import "../../lib/monacoSetup";

/**
 * How far outside the viewport a file's editor is kept alive — both the lead time before it scrolls
 * in and the slack before it is let go on the way out.
 *
 * Three viewports either way, as a percentage of the root so it scales with the window rather than
 * meaning "half a screen" on a laptop and "a sixth" on a monitor. It is deliberately far wider than
 * the 800px of lead time this used to be, because it is now doing a second job: an editor that
 * leaves this band is torn down, and the reason it was never torn down before was the fear of
 * ping-pong — rebuilding on every wobble of the scroll wheel. Three viewports is well past any
 * gesture a wheel or trackpad produces, so leaving the band means the user really has gone
 * somewhere else in the diff.
 */
const LIVE_MARGIN = "300% 0px";

/**
 * One file's side-by-side pane, mounted only once it is near the viewport.
 *
 * **This lives in its own module because it is the only thing in the diff that needs Monaco.**
 * Unified is `DiffView`'s default mode and draws plain DOM, so a user who never presses the split
 * toggle should never load a 4 MB editor — and could not avoid it while this component sat in the
 * same file as the unified renderer, which the commit list and the Changes panel both import
 * statically. `DiffView` now pulls this in with `lazy()` behind its own `<Suspense>`, whose fallback
 * is the same empty pane this component renders before it intersects, so the split view looks
 * exactly as it did.
 *
 * Every file used to get its own `DiffEditor` the moment split mode opened, all of them at once.
 * Each one is two Monaco models, a diff computed in a worker, a tokenizer pass over the whole file
 * and — with `automaticLayout` — its own resize observer. On a commit that touches a lockfile that
 * is tens of thousands of lines through a JSON tokenizer *before the first frame*, which is why the
 * view arrived already stuck: the work was not slow to scroll, it was all being done up front for
 * panes that were nowhere near the screen.
 *
 * Reconstructing the two sides is deferred with it. That is where the big strings get built, and
 * building them for a file nobody has scrolled to is the same waste one step earlier.
 *
 * **And it is given back again.** This used to be one-way — "once up it stays up", on the reasoning
 * that rebuilding an editor on the way back trades a one-off cost for a repeating one. The
 * reasoning holds; what it missed is the other end of it. Scrolling once through a 60-file
 * changeset left 60 live editors — 120 Monaco models, 60 diff worker jobs, two reconstructed file
 * texts each — alive for as long as the window was, tens of megabytes for panes the user had passed
 * ten minutes ago. So they are released, but only past `LIVE_MARGIN`, which is wide enough that
 * "back and forth" never crosses it.
 *
 * What survives the round trip is the *view*: the editor's scroll position, its folds and its
 * collapsed unchanged regions are saved the moment before it goes and restored when it comes back,
 * so returning to a file lands where you left it rather than at the top. The pane's own height is
 * fixed by `splitHeightOf` and is the same whether the editor is up or not, so the outer scroll
 * position never moves underneath any of this.
 */
export function SplitFileDiff({ file, height }: { file: FileDiffInfo; height: number }) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const holderRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  const path = file.new_path ?? file.old_path ?? "";
  /** The live editor, while there is one — only so its view state can be taken before it is let go. */
  const editorRef = useRef<MonacoEditorNS.IStandaloneDiffEditor | null>(null);
  /** Where this file was left: scroll, folds, collapsed regions. Outlives the editor on purpose. */
  const viewStateRef = useRef<MonacoEditorNS.IDiffEditorViewState | null>(null);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        // Saved here rather than in an unmount cleanup because here is the last moment the editor
        // is still mounted and still owns its models — by the time React has torn the subtree down
        // there is nothing left to ask.
        if (!visible && editorRef.current) {
          viewStateRef.current = editorRef.current.saveViewState() ?? viewStateRef.current;
          editorRef.current = null;
        }
        setLive(visible);
      },
      { rootMargin: LIVE_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sides = useMemo(() => (live ? reconstructSides(file) : null), [live, file]);

  return (
    <div ref={holderRef} style={{ height }}>
      {sides ? (
        <DiffEditor
          height="100%"
          language={languageForPath(path)}
          original={sides.original}
          modified={sides.modified}
          theme={monacoTheme}
          onMount={(editor) => {
            editorRef.current = editor;
            // Only ever set by a previous life of this same pane, so there is no chance of restoring
            // one file's position into another's.
            if (viewStateRef.current) editor.restoreViewState(viewStateRef.current);
          }}
          options={{
            readOnly: true,
            fontSize: 13,
            renderSideBySide: true,
            // Monaco silently collapses side-by-side into a unified-looking layout below ~900px
            // wide (e.g. inside a modal) unless told not to — the whole point of this toggle is
            // an actual two-pane view, so never let it fall back on its own.
            useInlineViewWhenSpaceIsLimited: false,
            automaticLayout: true,
            // A generated lockfile can take Monaco's differ arbitrarily long. Past this it falls
            // back to a coarser result, which for a file you are scrolling past is the right
            // trade — an approximate diff beats a frozen pane.
            maxComputationTime: 2000,
            scrollBeyondLastLine: false,
          }}
        />
      ) : (
        <div className="h-full bg-[var(--cf-bg)]" />
      )}
    </div>
  );
}
