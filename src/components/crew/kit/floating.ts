/**
 * What a window that floats over a view is made of, whatever it shows: where it is resized from,
 * what in its header is pressed for itself, the size of the layer it floats in, and following
 * the pointer while it is carried or pulled. The geometry is `lib/floatingRect`.
 */
import { useLayoutEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Area, Edges } from "../../../lib/floatingRect";

/** The eight places a window is resized from: four sides, four corners. */
export const HANDLES: { name: string; edges: Edges; className: string }[] = [
  { name: "n", edges: { top: true }, className: "inset-x-4 top-0 h-1.5 cursor-ns-resize" },
  { name: "s", edges: { bottom: true }, className: "inset-x-4 bottom-0 h-1.5 cursor-ns-resize" },
  { name: "w", edges: { left: true }, className: "inset-y-4 left-0 w-1.5 cursor-ew-resize" },
  { name: "e", edges: { right: true }, className: "inset-y-4 right-0 w-1.5 cursor-ew-resize" },
  { name: "nw", edges: { top: true, left: true }, className: "left-0 top-0 h-4 w-4 cursor-nwse-resize" },
  { name: "ne", edges: { top: true, right: true }, className: "right-0 top-0 h-4 w-4 cursor-nesw-resize" },
  { name: "sw", edges: { bottom: true, left: true }, className: "bottom-0 left-0 h-4 w-4 cursor-nesw-resize" },
  { name: "se", edges: { bottom: true, right: true }, className: "bottom-0 right-0 h-4 w-4 cursor-nwse-resize" },
];

/** What in a header is pressed for itself, and so does not carry the window. */
export const PRESSABLE = "button, a, input, textarea, select, [role='combobox'], [role='listbox'], [role='option']";

/** The size of the layer the windows float in, kept as it changes. */
export function useArea(layer: RefObject<HTMLDivElement | null>): Area | null {
  const [area, setArea] = useState<Area | null>(null);
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const measure = () => setArea({ w: element.clientWidth, h: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layer]);
  return area;
}

/** Follows the pointer from a press until it is let go, wherever it travels meanwhile. */
export function follow(event: ReactPointerEvent<HTMLElement>, onMove: (dx: number, dy: number) => void, onEnd: () => void): void {
  const target = event.currentTarget;
  const { clientX, clientY, pointerId } = event;
  target.setPointerCapture?.(pointerId);
  const move = (e: PointerEvent) => onMove(e.clientX - clientX, e.clientY - clientY);
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    onEnd();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}
