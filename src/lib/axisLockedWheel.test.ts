import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GESTURE_GAP_MS, dominantAxis, lockWheelAxis, type WheelScroller } from "./axisLockedWheel";

function scroller(overflowsSideways = true) {
  let listener: ((event: WheelEvent) => void) | null = null;
  const element: WheelScroller = {
    scrollTop: 0,
    scrollLeft: 0,
    scrollWidth: overflowsSideways ? 400 : 200,
    clientWidth: 200,
    clientHeight: 300,
    addEventListener: (_type, fn) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = null;
    },
  };
  const wheel = (deltaX: number, deltaY: number, extra: Partial<WheelEvent> = {}) => {
    const event = { deltaX, deltaY, deltaMode: 0, ctrlKey: false, preventDefault: vi.fn(), ...extra };
    listener?.(event as unknown as WheelEvent);
    return event.preventDefault;
  };
  return { element, wheel, attached: () => listener !== null };
}

describe("dominantAxis", () => {
  it("picks the axis moved further along, vertical on a tie", () => {
    expect(dominantAxis(1, 8)).toBe("y");
    expect(dominantAxis(-9, 2)).toBe("x");
    expect(dominantAxis(3, -3)).toBe("y");
  });
});

describe("lockWheelAxis", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops the sideways drift of a mostly vertical swipe", () => {
    const { element, wheel } = scroller();
    lockWheelAxis(element);
    expect(wheel(0, 10)).not.toHaveBeenCalled(); // pure vertical: left to the browser
    const prevented = wheel(4, 10);
    expect(prevented).toHaveBeenCalled();
    expect(element.scrollTop).toBe(10);
    expect(element.scrollLeft).toBe(0);
  });

  it("keeps the gesture's axis even when a later event leans the other way", () => {
    const { element, wheel } = scroller();
    lockWheelAxis(element);
    wheel(12, 2);
    wheel(3, 9);
    expect(element.scrollLeft).toBe(15);
    expect(element.scrollTop).toBe(0);
  });

  it("picks a new axis once the wheel has been quiet", () => {
    const { element, wheel } = scroller();
    lockWheelAxis(element);
    wheel(12, 2);
    vi.advanceTimersByTime(GESTURE_GAP_MS + 1);
    wheel(3, 9);
    expect(element.scrollTop).toBe(9);
  });

  it("leaves a scroller with nothing to scroll sideways, and pinches, alone", () => {
    const narrow = scroller(false);
    lockWheelAxis(narrow.element);
    expect(narrow.wheel(4, 10)).not.toHaveBeenCalled();
    const wide = scroller();
    lockWheelAxis(wide.element);
    expect(wide.wheel(4, 10, { ctrlKey: true })).not.toHaveBeenCalled();
  });

  it("detaches", () => {
    const { element, attached } = scroller();
    const undo = lockWheelAxis(element);
    undo();
    expect(attached()).toBe(false);
  });
});
