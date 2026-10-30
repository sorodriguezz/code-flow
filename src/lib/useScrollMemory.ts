import { useLayoutEffect, type RefObject } from "react";

/**
 * Scroll positions that survive leaving a view and coming back.
 *
 * Two mechanisms share this file because they share the rules:
 * - `useScrollMemory(key, ref)` — one scroller, keyed. For lists that unmount when you leave (or
 *   remount when their data does) and want to land where they were.
 * - `ScrollLedger` — every scroller inside a view that stays mounted but hidden (`display: none`
 *   drops the layout box and with it the scroll offset). Driven by `common/KeepScroll`.
 *
 * Rules, both: a position belongs to one workspace and one repository (the key / scope carries both),
 * so a list never restores another project's offset onto its own rows; and the memory is capped, so a
 * long session cannot grow it without bound.
 */

/** The map key for a remembered scroller: `workspace:view:subKey`. A missing workspace is `-`. */
export function scrollKey(workspaceId: string | null | undefined, view: string, subKey = ""): string {
  return `${workspaceId ?? "-"}:${view}:${subKey}`;
}

export interface ScrollPos {
  top: number;
  left: number;
}

/** A capped, least-recently-used map of positions. */
export class ScrollMemory {
  private readonly map = new Map<string, ScrollPos>();
  constructor(private readonly cap = 200) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): ScrollPos | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // Touch: most recently used moves to the back.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, pos: ScrollPos): void {
    this.map.delete(key);
    // Top is the default; keeping an entry for it only spends the cap.
    if (pos.top <= 0 && pos.left <= 0) return;
    this.map.set(key, pos);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/** Minimal shape of a scroller, so the logic is testable without a DOM. */
export interface ScrollerLike {
  scrollTop: number;
  scrollLeft: number;
  isConnected: boolean;
}

/** Scrollers of one hidden-but-mounted view, with the scope each position was recorded in. */
export class ScrollLedger<E extends ScrollerLike = HTMLElement> {
  private readonly entries = new Map<E, ScrollPos & { scope: string }>();
  constructor(private readonly cap = 200) {}

  get size(): number {
    return this.entries.size;
  }

  record(el: E, scope: string): void {
    this.entries.delete(el);
    if (el.scrollTop > 0 || el.scrollLeft > 0) {
      this.entries.set(el, { top: el.scrollTop, left: el.scrollLeft, scope });
    }
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Puts back what was recorded in `scope`; forgets removed elements and other scopes' entries. */
  restore(scope: string): number {
    let applied = 0;
    for (const [el, pos] of [...this.entries]) {
      if (!el.isConnected || pos.scope !== scope) {
        this.entries.delete(el);
        continue;
      }
      if (el.scrollTop !== pos.top) el.scrollTop = pos.top;
      if (el.scrollLeft !== pos.left) el.scrollLeft = pos.left;
      applied++;
    }
    return applied;
  }
}

const memory = new ScrollMemory();

/**
 * Remembers `ref`'s scroll offset under `key` and restores it when the element mounts again.
 *
 * Saved on scroll (one rAF-throttled write) and on unmount. Restored in a layout effect, retried for
 * a few frames until the content is tall enough to scroll that far — lists fill after their first
 * paint. `key === null` turns it off (nothing to key on yet). The element should be mounted when the
 * hook runs and stay the same element for the key's life.
 */
export function useScrollMemory(key: string | null, ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || key === null) return;
    const saved = memory.get(key);
    let tries = 0;
    let raf = 0;
    const apply = () => {
      if (!saved) return;
      el.scrollTop = saved.top;
      el.scrollLeft = saved.left;
      const reached = Math.abs(el.scrollTop - saved.top) < 2 || el.scrollHeight - el.clientHeight >= saved.top;
      if (!reached && tries++ < 12) raf = requestAnimationFrame(apply);
    };
    apply();
    let pending = 0;
    const onScroll = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        memory.set(key, { top: el.scrollTop, left: el.scrollLeft });
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(pending);
      // An unmounted element reads 0; the last scroll event's write is the truth, so only a
      // still-attached element is trusted here.
      if (el.isConnected) memory.set(key, { top: el.scrollTop, left: el.scrollLeft });
    };
  }, [key, ref]);
}

/** Exposed for tests. */
export const __scrollMemory = memory;
