/**
 * Drag and drop for the Agents view, on pointer events rather than HTML5 drag: the ghost is ours
 * to draw, it works the same with a pen, and a touch drag starts after a short press so scrolling
 * a list never turns into a drag by accident.
 *
 * A source calls `useDragSource(payload)` and spreads the handlers; a target calls
 * `useDropTarget(id, accepts, onDrop)` and spreads its attributes. One `DragLayer` per view draws
 * the ghost and resolves the drop by hit-testing under the pointer.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

export type DragPayload =
  | { kind: "agent"; id: string }
  | { kind: "team"; id: string }
  | { kind: "card"; id: string }
  | { kind: "ticket"; id: string }
  | { kind: "node"; id: string }
  | { kind: "template"; id: string };

interface DropHandler {
  accepts: (payload: DragPayload) => boolean;
  onDrop: (payload: DragPayload, point: { x: number; y: number }) => void;
}

const targets = new Map<string, DropHandler>();

interface DragState {
  payload: DragPayload | null;
  ghost: ReactNode;
  x: number;
  y: number;
  over: string | null;
}

export const useDragStore = create<DragState>(() => ({ payload: null, ghost: null, x: 0, y: 0, over: null }));

function targetAt(x: number, y: number, payload: DragPayload): string | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el) {
    const id = el.dataset?.crewDrop;
    if (id) {
      const handler = targets.get(id);
      if (handler && handler.accepts(payload)) return id;
    }
    el = el.parentElement;
  }
  return null;
}

/** Spread on whatever can be dragged. `ghost` is what follows the pointer. A click that never moved
 * stays a click: the drag only starts past a few pixels (or a long press on touch). */
export function useDragSource(payload: DragPayload, ghost: () => ReactNode) {
  const start = useRef<{ x: number; y: number; touch: boolean; timer: number | null; on: boolean } | null>(null);
  const suppressClick = useRef(false);

  const begin = (x: number, y: number) => {
    if (!start.current) return;
    start.current.on = true;
    document.body.classList.add("select-none");
    useDragStore.setState({ payload, ghost: ghost(), x, y, over: targetAt(x, y, payload) });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("input,textarea,select,[data-no-drag]")) return;
    const touch = e.pointerType === "touch";
    start.current = { x: e.clientX, y: e.clientY, touch, timer: null, on: false };
    if (touch) start.current.timer = window.setTimeout(() => begin(e.clientX, e.clientY), 260);

    const move = (ev: PointerEvent) => {
      const s = start.current;
      if (!s) return;
      const dist = Math.hypot(ev.clientX - s.x, ev.clientY - s.y);
      if (!s.on) {
        if (s.touch) {
          if (dist > 8) cleanup();
          return;
        }
        if (dist < 5) return;
        begin(ev.clientX, ev.clientY);
      }
      useDragStore.setState({ x: ev.clientX, y: ev.clientY, over: targetAt(ev.clientX, ev.clientY, payload) });
    };
    const preventScroll = (ev: TouchEvent) => {
      if (start.current?.on) ev.preventDefault();
    };
    const up = (ev: PointerEvent) => {
      const s = start.current;
      if (s?.on) {
        suppressClick.current = true;
        const over = targetAt(ev.clientX, ev.clientY, payload);
        if (over) targets.get(over)?.onDrop(payload, { x: ev.clientX, y: ev.clientY });
      }
      cleanup();
    };
    const cleanup = () => {
      if (start.current?.timer) window.clearTimeout(start.current.timer);
      start.current = null;
      document.body.classList.remove("select-none");
      useDragStore.setState({ payload: null, ghost: null, over: null });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("touchmove", preventScroll);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("touchmove", preventScroll, { passive: false });
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
  };

  return { onPointerDown, onClickCapture };
}

/** Spread on a drop target. Returns whether something it accepts is over it right now. */
export function useDropTarget(id: string, accepts: (payload: DragPayload) => boolean, onDrop: DropHandler["onDrop"]) {
  const handler = useRef<DropHandler>({ accepts, onDrop });
  handler.current = { accepts, onDrop };
  useEffect(() => {
    const proxy: DropHandler = {
      accepts: (p) => handler.current.accepts(p),
      onDrop: (p, point) => handler.current.onDrop(p, point),
    };
    targets.set(id, proxy);
    return () => {
      if (targets.get(id) === proxy) targets.delete(id);
    };
  }, [id]);
  const over = useDragStore((s) => s.over === id);
  const dragging = useDragStore((s) => (s.payload ? accepts(s.payload) : false));
  return { props: { "data-crew-drop": id }, over, dragging };
}

/** Draws the ghost under the pointer. One per view. */
export function DragLayer() {
  const { payload, ghost, x, y } = useDragStore();
  if (!payload || !ghost) return null;
  return createPortal(
    <div className="pointer-events-none fixed left-0 top-0 z-[100]" style={{ transform: `translate(${x + 10}px, ${y + 8}px)` }}>
      <div className="-rotate-3 scale-105 rounded-[12px] shadow-[var(--cf-shadow-modal)]">{ghost}</div>
    </div>,
    document.body,
  );
}
