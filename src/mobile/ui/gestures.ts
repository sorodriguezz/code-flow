import { useEffect, useRef } from "react";
import { navigated } from "../haptics";

/**
 * The two gestures a phone app is expected to have, and this one did not.
 *
 * # Why they are hand-written and not a library
 *
 * Every candidate — a swipe library, a router with transitions, a spring animation package — is
 * 15–60 kB gzipped. The whole rest of this client is about 75 kB. Both gestures below are a
 * pointer-event listener and a `transform`, which is what those libraries do underneath for this
 * case, so the trade is not close.
 *
 * Both use **Pointer Events** rather than touch events: they cover a trackpad on an iPad and a mouse
 * on the desktop browser somebody inevitably opens this in, and `setPointerCapture` means a drag
 * that leaves the element still delivers its `pointerup` — without which a fast swipe that flies off
 * the top of the screen leaves the layer stuck halfway across, mid-drag, forever.
 */

/** How far from the left edge a drag has to start to count as a back gesture, in CSS pixels. Apple's
 *  own edge region is about this wide; wider starts stealing horizontal scrolls inside the screen. */
const EDGE = 28;
/** How far across the screen the drag has to get to commit, as a fraction of the width. */
const COMMIT_FRACTION = 0.4;
/** …or how fast it has to be going when it lets go, in px/ms. A quick flick from the edge means
 *  "back" even if it only travelled a third of the way. */
const COMMIT_VELOCITY = 0.45;
/** …but a flick still has to be a flick. Without a floor, a 20-pixel twitch near the edge clears the
 *  velocity bar trivially — it is fast because it is short — and closes the screen the user was
 *  reading. This is roughly the width of a thumb. */
const COMMIT_MIN = 56;
/** Below this the pointer has not moved enough to say whether it is a swipe or a tap. */
const SLOP = 8;

/**
 * The edge-swipe-to-go-back gesture, applied to one navigation layer.
 *
 * The element is translated in real time while the finger is down, so the screen underneath is
 * revealed as it moves rather than appearing after the fact — which is the entire difference between
 * a gesture that feels like dragging a card and one that feels like a delayed button.
 *
 * # The two ways this is refused
 *
 * A drag that starts more than `EDGE` from the left is ignored outright, so a horizontal scroll
 * inside a wide diff still works. And a drag whose first movement is more vertical than horizontal
 * is released back to the scroll container, so flicking down a long list from near the left edge
 * scrolls it instead of half-dismissing the screen.
 */
export function useSwipeBack(
  ref: React.RefObject<HTMLElement | null>,
  onBack: () => void,
  enabled = true,
  /** Called once the drag is committed to being horizontal, before the first frame is drawn.
   *  `NavLayer` uses it to take its entry animation off the element — see the note on `settle`. */
  onGrab?: () => void,
) {
  // The callbacks, read through refs so the listeners below can be installed once and never see a
  // stale closure. Re-installing them whenever the parent re-renders would cancel a drag in flight.
  const back = useRef(onBack);
  back.current = onBack;
  const grab = useRef(onGrab);
  grab.current = onGrab;

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;

    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let dragging = false;
    /** Set once the direction is known, so the decision is taken once rather than re-litigated on
     *  every move as the angle wanders. */
    let decided: "horizontal" | "vertical" | null = null;
    let pointer = -1;

    /**
     * Lets the layer finish the journey by itself.
     *
     * # Why `.cf-dragging` stays on
     *
     * It used to come off here, and that quietly undid the whole gesture. A live layer carries
     * `.cf-push-in`, which is `animation: … both` — and a CSS animation's own values sit *above* the
     * `style` attribute in the cascade, so the inline transform written on the next line was
     * discarded. `.cf-dragging` is what suppresses that animation (`animation: none !important`);
     * removing it re-adds `animation-name`, which per spec starts a **brand-new** animation from
     * time zero. The layer snapped back to the middle and slid in again, on every release.
     *
     * So the class stays, and the settle is driven by an inline transition instead. `NavLayer` drops
     * `.cf-push-in` for good the moment a drag starts (see `onGrab`), so nothing is left to restart.
     */
    const settle = (toClosed: boolean) => {
      node.style.transition = "transform 220ms var(--ease-nav)";
      node.style.transform = toClosed ? "translate3d(100%, 0, 0)" : "translate3d(0, 0, 0)";
      window.setTimeout(() => {
        node.style.transition = "";
        if (!toClosed) {
          node.style.transform = "";
          node.classList.remove("cf-dragging");
        }
      }, 240);
    };

    /** Everything a released or cancelled drag owes the element, whichever way it ended. */
    const release = () => {
      dragging = false;
      pointer = -1;
      decided = null;
    };

    const onDown = (event: PointerEvent) => {
      // A second finger landing mid-drag used to overwrite `pointer` and reset `decided`, after
      // which every release path bailed out on the id check and left the layer sitting where it was
      // with `.cf-dragging` and an inline transform on it — permanently, with no way to reach the
      // screen underneath. Pinch-zoom is enabled on this client, so two fingers on a diff is an
      // ordinary thing to do.
      if (dragging || !event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.clientX > EDGE) return;
      pointer = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startedAt = event.timeStamp;
      dragging = true;
      decided = null;
    };

    const onMove = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointer) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      if (decided === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        decided = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
        if (decided === "vertical") {
          dragging = false;
          return;
        }
        // The layer's entry animation has to go before the first inline transform is written, and
        // it has to go for good — see `settle`.
        grab.current?.();
        // The scroller inside this layer is a descendant, and capture retargets the pointer to
        // *this* element: its own pull-to-refresh would otherwise be left mid-gesture with an
        // indicator drawn and no release event coming. Told rather than left to time out.
        window.dispatchEvent(new CustomEvent("codeflow:gesture-claimed"));
        // Taken only now, and only for a horizontal drag: capturing on `pointerdown` would swallow
        // the scroll gestures that start in the same 28 pixels.
        //
        // Guarded, because capture is an optimisation and not the mechanism: it exists so a flick
        // that leaves the element still delivers its `pointerup`. It throws for a pointer the
        // browser no longer considers active — a touch cancelled by the OS between the down and the
        // first move — and losing the whole gesture over that would leave the layer stuck mid-drag.
        try {
          node.setPointerCapture(event.pointerId);
        } catch {
          /* the listeners below still fire on the element; only the off-element case is lost */
        }
        node.classList.add("cf-dragging");
      }

      // Never to the left of where it started. Dragging a screen *further in* than it already is
      // has no meaning and looks like a bug.
      node.style.transform = `translate3d(${Math.max(0, dx)}px, 0, 0)`;
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      const wasHorizontal = dragging && decided === "horizontal";
      release();
      if (!wasHorizontal) return;
      const dx = Math.max(0, event.clientX - startX);
      const elapsed = Math.max(1, event.timeStamp - startedAt);
      const commit =
        dx > node.clientWidth * COMMIT_FRACTION ||
        (dx > COMMIT_MIN && dx / elapsed > COMMIT_VELOCITY);
      // Animated out first and the route dropped after, so the layer does not vanish from under the
      // finger. The delay matches `--ease-nav`'s duration in `mobile.css`.
      settle(commit);
      if (commit) {
        navigated();
        window.setTimeout(() => back.current(), 180);
      }
    };

    const onCancel = () => {
      const wasHorizontal = dragging && decided === "horizontal";
      release();
      // Unconditionally, even for a pointer this handler does not recognise: the one thing that must
      // never happen is a layer left translated off-centre with no gesture behind it.
      if (wasHorizontal || node.classList.contains("cf-dragging")) settle(false);
    };

    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onCancel);
    return () => {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onCancel);
    };
  }, [ref, enabled]);
}

/** How far the list has to be pulled past its top before letting go refreshes. */
const PULL_THRESHOLD = 72;
/** Everything past the threshold moves at a fraction of the finger, so the gesture has an obvious
 *  end rather than dragging the whole list into the middle of the screen. */
const PULL_RESISTANCE = 0.45;

/**
 * Pull down at the top of a list to re-read it.
 *
 * # Why this client needs one even though nothing here is polled
 *
 * It is push-based, and that is exactly the problem: when the live connection is the only thing
 * keeping the screen true, a user who suspects it has gone stale has no way to check. The header
 * says "Reconectando…" or it says nothing, and neither is something you can *act* on. This is the
 * gesture every phone user already tries first, and until now it did nothing on any screen.
 *
 * Returns nothing and takes the scroll container: the indicator it drives is drawn by
 * `PullToRefresh`, which owns both.
 */
export function usePullToRefresh(
  scroller: React.RefObject<HTMLElement | null>,
  indicator: React.RefObject<HTMLElement | null>,
  onRefresh: () => void | Promise<unknown>,
  enabled = true,
) {
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const node = scroller.current;
    if (!node || !enabled) return;

    let startY = 0;
    let pulling = false;
    let armed = false;
    let busy = false;
    let pointer = -1;

    const draw = (distance: number) => {
      const el = indicator.current;
      if (!el) return;
      el.style.transform = `translate3d(0, ${distance}px, 0)`;
      el.style.opacity = String(Math.min(1, distance / PULL_THRESHOLD));
      // Turns over as it approaches the threshold, so the gesture says when it will fire rather
      // than only reporting afterwards that it did.
      el.style.setProperty("--cf-pull", String(Math.min(1, distance / PULL_THRESHOLD)));
    };

    const reset = () => {
      const el = indicator.current;
      if (!el) return;
      el.style.transition = "transform 220ms var(--ease-out-soft), opacity 180ms linear";
      el.style.transform = "";
      el.style.opacity = "0";
      window.setTimeout(() => {
        if (indicator.current) indicator.current.style.transition = "";
      }, 240);
    };

    const onDown = (event: PointerEvent) => {
      // Only from a genuine top. Starting the gesture mid-list and having it engage the moment the
      // list happens to reach the top is how a fast flick upward ends in a refresh.
      if (busy || node.scrollTop > 0) return;
      pointer = event.pointerId;
      startY = event.clientY;
      pulling = true;
      armed = false;
    };

    const onMove = (event: PointerEvent) => {
      if (!pulling || event.pointerId !== pointer) return;
      const dy = event.clientY - startY;
      if (dy <= 0 || node.scrollTop > 0) {
        if (armed) {
          armed = false;
          reset();
        }
        return;
      }
      armed = true;
      draw(dy < PULL_THRESHOLD ? dy : PULL_THRESHOLD + (dy - PULL_THRESHOLD) * PULL_RESISTANCE);
    };

    const onUp = (event: PointerEvent) => {
      if (!pulling || event.pointerId !== pointer) return;
      pulling = false;
      if (!armed) return;
      const dy = event.clientY - startY;
      reset();
      if (dy < PULL_THRESHOLD) return;
      busy = true;
      navigated();
      void Promise.resolve(refresh.current()).finally(() => {
        busy = false;
      });
    };

    node.addEventListener("pointerdown", onDown, { passive: true });
    node.addEventListener("pointermove", onMove, { passive: true });
    node.addEventListener("pointerup", onUp, { passive: true });
    node.addEventListener("pointercancel", onUp, { passive: true });
    return () => {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };
  }, [scroller, indicator, enabled]);
}
