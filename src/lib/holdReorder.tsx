import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { setDragCursor } from "./pointerDrag";

/**
 * Press an item for [`HOLD_MS`], then drag it somewhere else in the list.
 *
 * The gesture only — deliberately not the preview. What a reorder should *look* like while it is
 * happening depends on the list: a rail of identical 32px icons can slide its neighbours out of the
 * way and read perfectly, and the sidebar's repositories cannot, because the open one is unfolded
 * to several hundred pixels of branches and shuffling blocks that size around is noise rather than
 * feedback. So this owns the timer, the arming, the slot measurement, the target and the click that
 * has to be swallowed afterwards, and hands the caller the numbers to draw whatever suits it.
 *
 * Hand-rolled on pointer events for the reason every drag in this app is: Tauri installs a native
 * drag-and-drop handler on the webview that swallows the HTML5 events before the page sees them.
 * See `pointerDrag.ts`.
 *
 * Why a hold and not the few pixels of travel `pointerDrag`'s `DRAG_THRESHOLD` asks for elsewhere:
 * the lists this is used on are ones you *click*. Every icon on the app rail is a door, every row
 * in the sidebar is a repository you are trying to open, and both are clicked constantly and
 * rearranged about once. A threshold makes a slip during the common gesture quietly perform the
 * rare one. Settings keeps the threshold because there the rows carry an explicit drag handle,
 * which is a grip that means nothing else.
 */

/**
 * How long an item must be held before it can be moved.
 *
 * Long enough that a slow click is still a click, short enough not to feel like the control has
 * stopped answering. It started at two seconds, which held that line comfortably but made the
 * deliberate gesture a wait, and came down through 1.25s to a flat second.
 *
 * A second is roughly where the two pressures meet, and it is the floor rather than a waypoint: an
 * ordinary click is well under 200ms and even a deliberate one rarely passes 500ms, so there is
 * still headroom — but it is now within reach of someone who presses and hesitates. What keeps that
 * safe is not the duration alone: `HOLD_SLOP` cancels the count the moment the pointer drifts, and
 * the indicator is drawing throughout, so a hesitation that is about to become a reorder says so
 * before it does. Going materially below this would start trading those two guards away.
 *
 * The single source of truth for the three lists that use it, and for [`HoldProgress`] — the
 * indicator is handed this value inline as its `animation-duration`, so the wait and the thing
 * drawing the wait cannot drift apart.
 */
export const HOLD_MS = 1000;

/**
 * How long a press is left unanswered before the indicator appears.
 *
 * The indicator used to be mounted on `pointerdown`, which meant *every* click on every one of these
 * items flashed a ring that started filling and vanished a moment later. A click is around 100ms, so
 * what the user saw was a flicker on a control they had merely used — the gesture announcing itself
 * to people who were not making it, on the app rail's most-clicked buttons, all day.
 *
 * A quarter of a second is comfortably past an ordinary click (~100ms) and past a slow one, and it
 * is still early enough that a press being *held* is answered long before anyone would conclude the
 * button is dead. What it buys is that the announcement now only reaches the person it is for.
 *
 * The wait itself is unchanged at [`HOLD_MS`]: this only moves when the drawing starts, so the
 * indicator sweeps [`HOLD_PROGRESS_MS`] and still finishes exactly as the item lifts.
 */
const HOLD_REVEAL_MS = 250;

/**
 * How long the indicator has to sweep — the hold minus the silence before it.
 *
 * Handed to the animation inline, so the drawing and the timer it draws cannot drift apart: a full
 * ring means the item is lifting *now*, not "some time after this filled up".
 */
export const HOLD_PROGRESS_MS = HOLD_MS - HOLD_REVEAL_MS;

/** How far the pointer may drift during the hold and still count as a press on one item. */
const HOLD_SLOP = 6;

export interface HoldDrag {
  /** The item being held, by the same key the caller passed to `beginHold`. */
  key: string;
  /** The slot it was picked up from. */
  from: number;
  /** The slot it is over now — a final position, not a gap. */
  to: number;
  /** How far it has been dragged from its own slot, clamped to the list's extent. */
  dy: number;
  /** The average distance between two slots. Meaningful for a list of equal-sized items, which is
   *  the only kind that can use it to preview a reorder by sliding things about. */
  pitch: number;
  /**
   * The slot the item will land in, as a box in the list container's own coordinates — enough to
   * draw a marker in the gap the neighbours have opened up.
   *
   * The gap is always at the *original* position of slot `to`, whichever way the drag went: the
   * items between `from` and `to` have each stepped one slot toward `from`, so the one place
   * nothing is covering is where the held item is going. Which is exactly what a drop marker has to
   * say, and what sliding neighbours alone only implies.
   *
   * Measured once when the item lifts and then indexed, never re-measured — the boxes are moving
   * under the pointer by then. Relative to the container's border box, so the container it is drawn
   * in must be `relative` and must not scroll or carry a border.
   */
  ghost: { top: number; height: number };
}

export interface HoldReorder {
  /** Goes on the element containing the items. Only descendants carrying `data-reorder` are
   *  measured, so an "add" button or a heading sharing the container is not a slot. */
  listRef: (el: HTMLElement | null) => void;
  /** `onPointerDown` for the item at `index`. */
  beginHold: (e: React.PointerEvent, index: number, key: string) => void;
  /** The item whose countdown is running — where [`HoldProgress`] goes. */
  arming: string | null;
  drag: HoldDrag | null;
  /**
   * Whether this click is the one the browser fires after a drag, and so is to be ignored.
   *
   * Reads *and* clears, so it is called once per click, from the handler that would otherwise act
   * on it. A row whose inner controls stop propagation needs the check in each handler that can
   * actually run — only one of them will, which is what keeps a single flag enough.
   */
  swallowsClick: () => boolean;
}

/**
 * How far the item in slot `index` has slid out of its own slot to make room, in pixels.
 *
 * For a list of equal-sized items, which is the only kind that can preview a reorder this way: the
 * items are *translated* rather than re-sorted, and the list only changes for real when the pointer
 * comes up. That is what lets the preview animate — flex children that swap places in the DOM jump,
 * and animating that properly means measuring both layouts — and it is what makes the drop cheap,
 * since the held item is already sitting where its new slot is by the time the order behind it
 * changes. A list of unequal items (the sidebar unfolded, whose open repository carries its
 * branches) has no single pitch to slide by, and shows a line at the drop point instead.
 */
export function slotShift(index: number, drag: HoldDrag): number {
  if (index === drag.from) return 0;
  // Dragging down: everything the item passed moves up one slot, and vice versa.
  if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.pitch;
  if (drag.from > drag.to && index < drag.from && index >= drag.to) return drag.pitch;
  return 0;
}

/**
 * Every slot, in document order: centres in viewport coordinates for hit-testing, and boxes in the
 * container's coordinates for drawing into.
 *
 * One pass rather than two. Both readings come off the same `getBoundingClientRect()` per item, and
 * they are taken at the same instant by construction — measuring the centres and the boxes
 * separately would be two layout reads of a list that is about to start moving.
 */
function measure(list: HTMLElement | null): { centres: number[]; boxes: { top: number; height: number }[] } {
  const items = Array.from(list?.querySelectorAll<HTMLElement>("[data-reorder]") ?? []);
  const origin = list?.getBoundingClientRect().top ?? 0;
  const centres: number[] = [];
  const boxes: { top: number; height: number }[] = [];
  for (const el of items) {
    const box = el.getBoundingClientRect();
    centres.push(box.top + box.height / 2);
    boxes.push({ top: box.top - origin, height: box.height });
  }
  return { centres, boxes };
}

/** The slot whose centre is nearest `y`. Nearest-centre rather than "which box is the pointer in",
 *  so a drag past either end of the list still aims at the end slot instead of at nothing. */
function nearest(slots: number[], y: number): number {
  let best = 0;
  for (let i = 1; i < slots.length; i++) {
    if (Math.abs(y - slots[i]) < Math.abs(y - slots[best])) best = i;
  }
  return best;
}

export function useHoldReorder(commit: (from: number, to: number) => void): HoldReorder {
  const [arming, setArming] = useState<string | null>(null);
  const [drag, setDrag] = useState<HoldDrag | null>(null);
  const suppressClick = useRef(false);
  const list = useRef<HTMLElement | null>(null);

  // The one memoised thing here: a ref callback whose identity changed every render would detach
  // and reattach the container on every render. Everything else is a plain closure, which is what
  // keeps `commit` current without a ref to shadow it.
  const listRef = useCallback((el: HTMLElement | null) => {
    list.current = el;
  }, []);

  const swallowsClick = useCallback(() => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  }, []);

  /**
   * Driven from `window` rather than from the item, so it keeps tracking once the pointer leaves
   * the list — which for a 44px rail or a folded sidebar is most of any real drag.
   */
  const beginHold = (e: React.PointerEvent, index: number, key: string) => {
    // Left button only: the others have nothing to reorder with.
    if (e.button !== 0) return;
    // A fresh press is never suppressed. The flag is set on the way out of a drag and cleared by
    // the click that follows it — but a drag cancelled with Escape and released somewhere that
    // fires no click never gets one, and the flag would sit there and eat the next real click.
    suppressClick.current = false;
    const origin = { x: e.clientX, y: e.clientY };
    /** Slot centres, measured when the hold completes and then left alone. Items move under the
     *  pointer as the preview updates, and hit-testing against boxes that are themselves moving is
     *  what makes a list flicker between two orders. */
    let slots: number[] = [];
    /** The same slots as boxes to draw in — see `HoldDrag.ghost`. */
    let boxes: { top: number; height: number }[] = [];
    let timer: number | null = null;
    /** The countdown's *appearance*, which lands a quarter of a second before anything else does.
     *  Its own handle because `stop()` has to be able to cancel a press that ends inside that
     *  quarter second — which is every ordinary click on one of these items. */
    let revealTimer: number | null = null;
    let armed = false;
    let to = index;
    let dy = 0;

    const stop = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (revealTimer !== null) window.clearTimeout(revealTimer);
      revealTimer = null;
      setArming(null);
      if (armed) setDragCursor(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };

    const onMove = (ev: PointerEvent) => {
      if (!armed) {
        // Still counting down, and a pointer that wanders off was never a press on this item.
        //
        // `stop()` rather than merely clearing the timer: a press that has drifted can never arm
        // again, so leaving the handlers attached bought nothing and cost a `Math.hypot` plus a
        // redundant `setArming(null)` dispatch on *every remaining pointermove* of that press —
        // per-event work on the highest-frequency event there is, for a gesture already over.
        //
        // It stays a plain click, which is the point: `armed` is false, so `stop()` skips the drag
        // cursor and nothing sets `suppressClick`.
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) > HOLD_SLOP) stop();
        return;
      }
      const nextTo = nearest(slots, ev.clientY);
      // Clamped to the list's own extent: an item draggable to the bottom of the window would be an
      // item with nowhere left to go, since where it lands is decided by `nearest` regardless.
      const nextDy = Math.round(
        Math.min(
          Math.max(ev.clientY - origin.y, slots[0] - slots[index]),
          slots[slots.length - 1] - slots[index],
        ),
      );
      // Pointer moves arrive continuously; a pixel nobody can see is not worth a render.
      if (nextTo === to && nextDy === dy) return;
      to = nextTo;
      dy = nextDy;
      setDrag((d) => (d ? { ...d, to, dy, ghost: boxes[to] ?? d.ghost } : d));
    };

    const onUp = () => {
      const rearranged = armed && to !== index;
      if (armed) suppressClick.current = true;
      stop();
      setDrag(null);
      // Only when the gesture actually changed something: a hold that ends where it started is a
      // hold the user thought better of, and it should cost no write.
      if (rearranged) commit(index, to);
    };

    /** Escape, or a pointer the system took away, puts the item back where it was picked up. */
    const onCancel = () => {
      if (armed) suppressClick.current = true;
      stop();
      setDrag(null);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onCancel();
    };

    timer = window.setTimeout(() => {
      timer = null;
      const measured = measure(list.current);
      slots = measured.centres;
      boxes = measured.boxes;
      // Nothing to swap with — leave the press a plain click rather than starting a drag with no
      // second slot to end in.
      if (slots.length < 2 || index >= slots.length) {
        stop();
        return;
      }
      armed = true;
      setArming(null);
      setDragCursor(true);
      setDrag({
        key,
        from: index,
        to: index,
        dy: 0,
        // Averaged rather than taken from the first gap, so a rule or a badge landing between two
        // items one day doesn't quietly make every shift the wrong height.
        pitch: (slots[slots.length - 1] - slots[0]) / (slots.length - 1),
        ghost: boxes[index],
      });
    }, HOLD_MS);

    // Not `setArming(key)` on the spot: the indicator waits out `HOLD_REVEAL_MS`, so an ordinary
    // click never puts one on screen at all. The countdown itself started above and is unaffected.
    revealTimer = window.setTimeout(() => {
      revealTimer = null;
      setArming(key);
    }, HOLD_REVEAL_MS);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  };

  return { listRef, beginHold, arming, drag, swallowsClick };
}

/**
 * The wait, drawn.
 *
 * Without it the hold is a control that looks like it missed the click — which is the single thing
 * most likely to make someone let go a moment before the gesture arrives. It is also the gesture's
 * only announcement on screen.
 *
 * Two shapes because the targets are two shapes, and a determinate indicator has to sit on the
 * thing it is timing. `ring` traces the edge of a square control and leaves the glyph identifying
 * it alone; on a wide row that same circle would be a small disc marooned in the middle, so `bar`
 * sweeps the row's full width instead. Both are the same fact drawn to fit.
 *
 * Mounted by the caller only once [`HOLD_REVEAL_MS`] has passed, so this draws a press somebody is
 * holding rather than flickering on every click — see the note there. It sweeps
 * [`HOLD_PROGRESS_MS`], the remainder, and so still fills exactly as the item lifts.
 *
 * The host element needs `relative` and, for `bar`, its own rounded clipping.
 */
export function HoldProgress({ shape }: { shape: "ring" | "bar" }) {
  if (shape === "bar") {
    return (
      <span
        aria-hidden
        className="cf-hold-bar pointer-events-none absolute inset-y-0 left-0 w-full origin-left rounded-[inherit] bg-[var(--cf-accent)] opacity-[0.14]"
        style={{ animationDuration: `${HOLD_PROGRESS_MS}ms` }}
      />
    );
  }
  return (
    <svg
      aria-hidden
      viewBox="0 0 32 32"
      className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
    >
      {/* `pathLength` lets the keyframes count to 100 without knowing the radius. */}
      <circle
        cx="16"
        cy="16"
        r="14"
        pathLength={100}
        fill="none"
        stroke="var(--cf-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        className="cf-hold-ring"
        style={{ animationDuration: `${HOLD_PROGRESS_MS}ms` }}
      />
    </svg>
  );
}

/**
 * Everything except the list, dimmed — the moment the item lifts, and not a frame before.
 *
 * The hold and the drag are two different states of the same gesture, and until now they looked
 * nearly alike: the ring filled, the icon grew a shadow, and the rest of the window carried on as if
 * nothing had happened. So "am I dragging yet?" was answered by a shadow the width of a hairline, on
 * a 32px button, in the corner of the eye. This answers it with the whole window.
 *
 * It is also what turns the list into a *destination*. A drag has to say where the thing may be put
 * down, and the honest answer for this gesture is "back in this list, nowhere else" — dropping the
 * scrim over everything else and leaving the list lit says exactly that, without inventing a drop
 * zone that does not exist.
 *
 * `pointer-events-none`, always: the drag is driven from `window` listeners and the scrim must not
 * become the target of the pointer that is mid-gesture. It is decoration, and it has to stay
 * decoration even while it covers the screen.
 *
 * The caller raises its own list above this — `z-[9998]` here, so a `z-[9999]` on the container is
 * what lights it. A portal rather than a fixed child of the list, so no `overflow` or stacking
 * context between the list and the window can clip it down to the list's own box.
 */
export function HoldScrim({ active }: { active: boolean }) {
  if (!active) return null;
  return createPortal(
    <div aria-hidden className="cf-hold-scrim pointer-events-none fixed inset-0 z-[9998] bg-black/55" />,
    document.body,
  );
}
