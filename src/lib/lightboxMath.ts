export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const FIT: View = { scale: 1, x: 0, y: 0 };

export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/**
 * Zooms by `factor` keeping the point under the pointer where it is — which is what makes a wheel zoom
 * feel like looking closer at what you are pointing at, instead of at the middle of the picture.
 * `px`/`py` are the pointer's offset from the picture's centre, in screen pixels.
 */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = clampZoom(view.scale * factor);
  const ratio = scale / view.scale;
  return { scale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

/** A wheel notch as a zoom factor: smooth for a trackpad, bounded for a mouse. */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-Math.max(-120, Math.min(120, deltaY)) * 0.0025);
}

/** Back to fit when zoomed out far enough that panning has nothing to pan. */
export function settle(view: View): View {
  return view.scale <= 1 ? { scale: view.scale, x: 0, y: 0 } : view;
}
