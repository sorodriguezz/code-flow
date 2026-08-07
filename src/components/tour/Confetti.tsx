import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** How long the burst lasts before the canvas takes itself down, in ms. */
const DURATION = 3400;
const COUNT = 190;
/** Downward acceleration, in px per frame², at the 60fps the timings below are written for. */
const GRAVITY = 0.16;
/** Per-frame velocity retained. Slows the initial burst into a drift rather than a straight line. */
const DRAG = 0.985;

/** Deliberately not the theme's accent: the accent is what every *control* in the app is painted
 * in, and a celebration in the same colour reads as more interface. These are their own thing. */
const COLORS = ["#6366f1", "#22d3ee", "#f472b6", "#facc15", "#4ade80", "#fb923c", "#a78bfa"];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Half-width of the strip, in px. Height is twice this — confetti is a rectangle, not a dot. */
  size: number;
  color: string;
  /** Rotation about the strip's own centre, and about the axis facing the viewer. */
  spin: number;
  spinRate: number;
  /** Phase of the flutter that makes each strip turn edge-on and briefly disappear. */
  wobble: number;
  wobbleRate: number;
}

function makePiece(width: number, height: number): Piece {
  // Launched from just off the top edge across the full width, rather than from two cannons at the
  // bottom corners: the app's own chrome lives at the edges, and a burst that starts there covers
  // the thing the user has just been walked through.
  const x = Math.random() * width;
  const y = -20 - Math.random() * height * 0.35;
  return {
    x,
    y,
    vx: (Math.random() - 0.5) * 3.4,
    vy: 1 + Math.random() * 3,
    size: 3 + Math.random() * 4,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    spin: Math.random() * Math.PI * 2,
    spinRate: (Math.random() - 0.5) * 0.24,
    wobble: Math.random() * Math.PI * 2,
    wobbleRate: 0.06 + Math.random() * 0.1,
  };
}

/**
 * The finale.
 *
 * A canvas rather than a few hundred DOM nodes, and its own component rather than something the
 * overlay draws: it plays *after* the tour has closed and the app has been put back, so it has to
 * outlive the thing that started it.
 *
 * Silently does nothing when the OS asks for reduced motion — a full-screen particle burst is the
 * exact effect that setting exists to turn off — but still calls `onDone` on the same schedule, so
 * nothing downstream has to know which of the two happened.
 */
export function Confetti({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // In a ref, not a dependency: `onDone` is an inline arrow at the call site and would restart the
  // animation on every parent render if the effect depended on it.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const timer = window.setTimeout(() => doneRef.current(), DURATION);
    const canvas = canvasRef.current;
    if (reduced || !canvas) return () => window.clearTimeout(timer);

    const ctx = canvas.getContext("2d");
    if (!ctx) return () => window.clearTimeout(timer);

    // Backing store at device resolution, drawing in CSS pixels — otherwise 4px strips are a blur
    // on the retina displays this app mostly runs on.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = window.innerWidth;
    let height = window.innerHeight;
    const size = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener("resize", size);

    const pieces = Array.from({ length: COUNT }, () => makePiece(width, height));
    const start = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, width, height);
      // Fades over the last third rather than vanishing on the final frame — the strips still
      // falling when the timer expires would otherwise be cut off mid-air.
      const fade = elapsed > DURATION * 0.62 ? Math.max(0, 1 - (elapsed - DURATION * 0.62) / (DURATION * 0.38)) : 1;

      for (const p of pieces) {
        p.vy = p.vy * DRAG + GRAVITY;
        p.vx *= DRAG;
        p.x += p.vx;
        p.y += p.vy;
        p.spin += p.spinRate;
        p.wobble += p.wobbleRate;

        if (p.y - p.size > height) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        // The flutter: scaling one axis by a cosine is a cheap stand-in for a strip tumbling in
        // three dimensions, and it is what keeps a field of rectangles from looking like a grid.
        ctx.scale(1, Math.cos(p.wobble));
        ctx.globalAlpha = fade;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size, -p.size * 2, p.size * 2, p.size * 4);
        ctx.restore();
      }

      if (elapsed < DURATION) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, []);

  return createPortal(
    <canvas
      ref={canvasRef}
      aria-hidden
      // Above the overlay's own layer: the tour has closed by the time this runs, but a stray
      // menu or modal reopened underneath it should not cut through the celebration.
      className="pointer-events-none fixed inset-0 z-[100010]"
    />,
    document.body,
  );
}
