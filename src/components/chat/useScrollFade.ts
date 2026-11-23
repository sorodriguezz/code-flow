import { useEffect, type RefObject } from "react";

/**
 * Keeps `data-fade-top` / `data-fade-bottom` on a scroller while there is more to scroll that way,
 * for `.cf-scroll-fade` (`index.css`) to fade that edge.
 *
 * Written straight onto the element rather than through state: it changes on every scroll event,
 * and a transcript re-rendered per scrolled pixel is the jank this exists to avoid. `content` is
 * the element that grows — an answer streaming in makes the bottom scrollable without any scroll
 * event, so its size is watched too.
 */
export function useScrollFade(scroller: RefObject<HTMLElement | null>, content?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = el.scrollTop > 1;
      const bottom = el.scrollHeight - el.clientHeight - el.scrollTop > 1;
      if (top) el.dataset.fadeTop = "";
      else delete el.dataset.fadeTop;
      if (bottom) el.dataset.fadeBottom = "";
      else delete el.dataset.fadeBottom;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    if (content?.current) observer.observe(content.current);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [scroller, content]);
}
