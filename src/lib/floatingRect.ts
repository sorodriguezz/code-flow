/**
 * The geometry of a window that floats inside an area of the app: where it starts, how it moves
 * and grows, and how it is kept whole inside that area when the area itself changes size.
 *
 * Pure numbers, in the area's own pixels (0,0 is its top-left corner).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Area {
  w: number;
  h: number;
}

/** Which sides a resize pulls: one for an edge, two for a corner. */
export interface Edges {
  left?: boolean;
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
}

export const MIN_W = 380;
export const MIN_H = 340;
/** The air a window keeps from the area's sides when it is placed or maximised. */
export const GAP = 12;
/** Kept free under a window that is placed for the first time: where the minimised ones sit. */
export const SHELF = 56;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Where a window opens: down by the right side, tall enough to read, clear of the shelf. */
export function defaultRect(area: Area): Rect {
  const w = clamp(580, Math.min(MIN_W, area.w), area.w - GAP * 2);
  const h = clamp(700, Math.min(MIN_H, area.h), area.h - GAP - SHELF);
  return { x: Math.max(0, area.w - w - GAP), y: Math.max(0, area.h - h - SHELF), w, h };
}

/** The whole area but its margins — and but the shelf, when something sits on it. */
export function maximizedRect(area: Area, shelf = false): Rect {
  return { x: GAP, y: GAP, w: Math.max(0, area.w - GAP * 2), h: Math.max(0, area.h - GAP - (shelf ? SHELF : GAP)) };
}

/** `rect` made to fit `area`: no larger than it, and all of it inside. */
export function fitRect(rect: Rect, area: Area): Rect {
  const w = clamp(rect.w, Math.min(MIN_W, area.w), area.w);
  const h = clamp(rect.h, Math.min(MIN_H, area.h), area.h);
  return { x: clamp(rect.x, 0, area.w - w), y: clamp(rect.y, 0, area.h - h), w, h };
}

/** `rect` carried by `dx`,`dy`, stopping at the area's sides. */
export function moveRect(rect: Rect, dx: number, dy: number, area: Area): Rect {
  return fitRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, area);
}

/**
 * `rect` with the pulled sides moved by `dx`,`dy`. The opposite side stays where it is, so a
 * window dragged smaller than its minimum stops growing smaller instead of sliding away.
 */
export function resizeRect(rect: Rect, edges: Edges, dx: number, dy: number, area: Area): Rect {
  let { x, y, w, h } = rect;
  const minW = Math.min(MIN_W, area.w);
  const minH = Math.min(MIN_H, area.h);
  if (edges.right) w = clamp(rect.w + dx, minW, area.w - rect.x);
  if (edges.bottom) h = clamp(rect.h + dy, minH, area.h - rect.y);
  if (edges.left) {
    const right = rect.x + rect.w;
    x = clamp(rect.x + dx, 0, right - minW);
    w = right - x;
  }
  if (edges.top) {
    const bottom = rect.y + rect.h;
    y = clamp(rect.y + dy, 0, bottom - minH);
    h = bottom - y;
  }
  return { x, y, w, h };
}
