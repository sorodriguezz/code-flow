import type { editor, IDisposable } from "monaco-editor";

/**
 * Repaints an editor in the same frame its size changed, instead of the frame after.
 *
 * `automaticLayout` relays the editor from a `ResizeObserver` callback, and the relayout applies the
 * new size to the DOM at once — including the minimap's two canvases, whose `height` attribute is set
 * there (`InnerMinimap._applyLayout`). Setting a canvas's size wipes it. The drawing that refills it is
 * Monaco's ordinary render, which it schedules for the *next* animation frame. A resize observer runs
 * after this frame's animation callbacks and before its paint, so every frame of a resize painted the
 * minimap blank and the next one drew it back: the flicker you see dragging the window's bottom edge,
 * or anything else that changes the editor's height every frame (a panel sliding open beside it).
 *
 * A microtask runs before that paint — right after the observer callback returns — and by then the
 * layout has gone through the whole view synchronously, so `render()` there draws the new size into the
 * canvases that were just cleared. A resize that lands outside an observer (Monaco defers a second one
 * in the same frame to its own animation frame) is covered the same way: the microtask still runs before
 * the paint that frame produces.
 *
 * One render per layout change and only then, so a still editor pays nothing.
 */
export function paintOnLayout(ed: editor.ICodeEditor): IDisposable {
  let queued = false;
  return ed.onDidLayoutChange(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // `render()` itself returns early for an editor without a model or a view — closed tab,
      // disposed pane — so there is nothing to guard here beyond what Monaco already does.
      ed.render();
    });
  });
}
