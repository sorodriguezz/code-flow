import { useLayoutEffect, type RefObject } from "react";

/**
 * Sizes a composer's box to its text, up to `max` pixels — past that it scrolls inside instead.
 *
 * Height is reset to `auto` before it is read, because `scrollHeight` of a box already sized to its
 * content only ever reports that size: without the reset the box grows and never shrinks, which is
 * invisible until someone deletes a paragraph.
 *
 * # Never measured while it is not drawn
 *
 * A box inside a hidden tab or view (`display: none` — the assistant's kept-alive tabs, the app's
 * stay-mounted views) has no layout, and its `scrollHeight` is 0. Writing that down set `height:
 * 0px`, and the box came back as a strip of padding with the model row right under it: the field
 * looked gone under the model settings until a keystroke measured it again. Whatever changes the
 * text while it is hidden — a conversation switched from another window, a question handed back by
 * the queue — is measured when the box is shown instead, by the observer below.
 *
 * # Measured again when the width changes
 *
 * The same text wraps to another number of lines in a panel dragged narrower or widened, and being
 * shown at all is a width change from nothing. Done on the next frame: changing the observed box's
 * height inside its own callback is the "ResizeObserver loop" error, which `diagnostics` would write
 * to the app log on every resize.
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, max: number): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) fit(el, max);
  }, [ref, value, max]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = -1;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      if (next === width) return;
      width = next;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit(el, max));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref, max]);
}

function fit(el: HTMLTextAreaElement, max: number): void {
  // No boxes at all: hidden, here or above. Its last height stands until it is shown again.
  if (el.getClientRects().length === 0) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}
