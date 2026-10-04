import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
} from "react";
import type { MenuItem } from "../common/ContextMenu";
import type { Translate } from "../../state/languageStore";

/**
 * The laser pointer the Diagrams app draws over its editors: hold the button down over a drawing and
 * a stroke follows the pointer, let go and it fades away. For walking somebody through a diagram —
 * circling a box, underlining the line a relationship hangs off — without touching the document or
 * the view.
 *
 * Two editors use it, and they feed it differently:
 *
 * - **The schema canvas** (`DbmlCanvas`) is this app's own code, so `LaserLayer` lays a surface over
 *   it that takes the presses itself.
 * - **draw.io** lives in an iframe, and a surface laid over the iframe would also lie over its menus
 *   and dialogs, which open across the drawing. So there the presses are caught inside the editor's
 *   document, and only those that land on the drawing (`captureLaser` in `lib/diagrams/embed`); the
 *   strokes are drawn by a `LaserCanvas` over the frame that no press ever reaches.
 *
 * **Screen space, not diagram space**, in both. A stroke lasts as long as one press, and while the
 * laser is on a drag draws instead of panning, so there is nothing for it to be kept in step with —
 * and neither editor's exported picture can ever contain one.
 */

export type LaserColour = "red" | "green" | "blue" | "yellow";

/** A point in the pixels of whatever the laser is laid over. */
export type LaserPoint = [number, number];

/** The four, in the order the menu offers them. Red first, because it is what a laser pointer is. */
export const LASER_COLOURS: readonly LaserColour[] = ["red", "green", "blue", "yellow"];

/** A colour's ink — a token with a light and a dark value each, in `index.css`. */
export function laserInk(colour: LaserColour): string {
  return `var(--cf-laser-${colour})`;
}

/**
 * A colour's ink as a literal, for a document our stylesheet does not reach — the draw.io toolbar
 * the laser's button is injected into. Read off the live theme, so call it again after a switch.
 */
export function resolveLaserInk(colour: LaserColour): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(`--cf-laser-${colour}`).trim() ||
    FALLBACK_INK[colour]
  );
}

/** The light theme's values, for the one frame a stylesheet might not have arrived in. */
const FALLBACK_INK: Record<LaserColour, string> = {
  red: "#f2233b",
  green: "#12a84a",
  blue: "#1f6bff",
  yellow: "#dca200",
};

const STORAGE_KEY = "cf.diagrams.laserColour";

/**
 * The colour last picked, on this machine — one choice for every editor, since it is a preference
 * about the person presenting rather than about any diagram.
 *
 * Remembered, unlike the canvases' other view settings: re-picking green every time another diagram
 * is opened is a chore, while a density reset per schema is not.
 */
export function loadLaserColour(): LaserColour {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return LASER_COLOURS.find((colour) => colour === stored) ?? "red";
  } catch {
    return "red";
  }
}

export function saveLaserColour(colour: LaserColour): void {
  try {
    localStorage.setItem(STORAGE_KEY, colour);
  } catch {
    // A full or blocked store costs the choice its next launch, and nothing else.
  }
}

/**
 * The colour menu's rows, for both editors.
 *
 * The loaded ink wears the ring `ColorSwatchPicker` marks its pick with. `pick` is told the colour;
 * both callers also pick the pointer up with it, since nobody opens this menu to choose a colour they
 * are not about to draw with.
 */
export function laserColourItems(
  current: LaserColour,
  pick: (colour: LaserColour) => void,
  t: Translate,
): MenuItem[] {
  return LASER_COLOURS.map((colour) => ({
    label: t(`diagrams.laserColour.${colour}` as "diagrams.laserColour.red"),
    leading: (
      <span
        aria-hidden
        className="mt-[3px] h-3 w-3 shrink-0 rounded-full"
        style={{
          background: laserInk(colour),
          boxShadow:
            colour === current
              ? `0 0 0 1.5px var(--cf-surface-raised), 0 0 0 3px ${laserInk(colour)}`
              : undefined,
        }}
      />
    ),
    onClick: () => pick(colour),
  }));
}

/** How long a released stroke takes to fade. Short: letting go *is* the gesture for "gone". */
const FADE_MS = 450;

interface Stroke {
  id: number;
  /** The pointer drawing it. A second finger landing mid-stroke is ignored rather than allowed to
   *  orphan this one, which would otherwise never be released and never fade. */
  pointerId: number;
  points: LaserPoint[];
  fading: boolean;
}

/** What a `LaserCanvas` is driven with. Every point is in the canvas's own pixels. */
export interface LaserCanvasHandle {
  /** Starts a stroke for this pointer — unless one is already being drawn, which is kept. */
  begin: (point: LaserPoint, pointerId: number) => void;
  /** Extends the live stroke, when it belongs to this pointer. */
  extend: (points: readonly LaserPoint[], pointerId: number) => void;
  /** Lets go of the live stroke, which fades where it is. With an id, only if it is that pointer's. */
  end: (pointerId?: number) => void;
  /** Puts the laser's dot at a point, or takes it away. */
  dot: (point: LaserPoint | null) => void;
  /** Whether a stroke is being drawn. */
  drawing: () => boolean;
}

/**
 * The strokes and the dot, and nothing that takes a press: the surface under it decides what draws.
 *
 * The strokes are kept in refs and drawn on a bumped counter rather than held in state: a stroke gains
 * a point per pointer event, and copying its array each time would cost a fresh allocation per sample
 * for a list nobody else reads. Only this component re-renders while drawing — never the editor
 * under it.
 */
export const LaserCanvas = forwardRef<LaserCanvasHandle, { colour: string }>(function LaserCanvas(
  { colour },
  ref,
) {
  const dotRef = useRef<HTMLDivElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const live = useRef<Stroke | null>(null);
  const nextId = useRef(0);
  const timers = useRef(new Set<number>());
  const [, repaint] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      begin: (point, pointerId) => {
        if (live.current) return;
        live.current = { id: nextId.current++, pointerId, points: [point], fading: false };
        strokes.current.push(live.current);
        repaint();
      },
      extend: (points, pointerId) => {
        const stroke = live.current;
        if (!stroke || stroke.pointerId !== pointerId) return;
        let grew = false;
        for (const point of points) {
          const [x, y] = stroke.points[stroke.points.length - 1];
          if (Math.hypot(point[0] - x, point[1] - y) < 1) continue;
          stroke.points.push(point);
          grew = true;
        }
        if (grew) repaint();
      },
      end: (pointerId) => {
        const stroke = live.current;
        if (!stroke || (pointerId !== undefined && stroke.pointerId !== pointerId)) return;
        live.current = null;
        stroke.fading = true;
        repaint();
        const timer = window.setTimeout(() => {
          timers.current.delete(timer);
          strokes.current = strokes.current.filter((entry) => entry !== stroke);
          repaint();
        }, FADE_MS);
        timers.current.add(timer);
      },
      // Written to the node directly: the dot moves on every pointer event, pressed or not, and a
      // render per mouse move to place one circle is a cost neither editor should pay for hovering.
      dot: (point) => {
        const dot = dotRef.current;
        if (!dot) return;
        if (!point) {
          dot.style.opacity = "0";
          return;
        }
        dot.style.transform = `translate(${point[0]}px, ${point[1]}px)`;
        dot.style.opacity = "1";
      },
      drawing: () => live.current !== null,
    }),
    [],
  );

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg className="absolute inset-0 h-full w-full">
        {strokes.current.map((stroke) => {
          const d = strokePath(stroke.points);
          return (
            <g
              key={stroke.id}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              // The fade is a transition on a value that flips once, so reduced motion simply
              // drops it: the stroke goes when the button does, which is the behaviour anyway.
              className="transition-opacity ease-out motion-reduce:transition-none"
              style={{ opacity: stroke.fading ? 0 : 1, transitionDuration: `${FADE_MS}ms` }}
            >
              {/* Light, in layers: a wide faint halo, a narrower brighter one, the beam, and — on a
                  dark theme only, see `--cf-laser-core` — a pale core down its middle, which is
                  what makes it read as a laser rather than a pen. */}
              <path d={d} stroke={colour} strokeWidth={16} strokeOpacity={0.12} />
              <path d={d} stroke={colour} strokeWidth={8} strokeOpacity={0.28} />
              <path d={d} stroke={colour} strokeWidth={3.5} />
              <path d={d} stroke="var(--cf-laser-core)" strokeWidth={1.2} />
            </g>
          );
        })}
      </svg>
      <div ref={dotRef} className="absolute left-0 top-0" style={{ opacity: 0 }}>
        <span
          className="block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: colour,
            boxShadow: `0 0 0 2px color-mix(in oklab, ${colour} 30%, transparent), 0 0 14px 4px color-mix(in oklab, ${colour} 55%, transparent)`,
          }}
        />
      </div>
    </div>
  );
});

/**
 * The laser as a surface that takes the presses itself — for a canvas that is this app's own code.
 *
 * **It takes every press while it is on.** Hover is not passed through either: lighting a table's
 * neighbourhood as the laser crosses it would dim half the schema under the audience's eyes, which
 * is the opposite of pointing at something. A selection made before the laser came on stays lit, so
 * "select the table, then talk over it" is how the two combine.
 */
export function LaserLayer({
  colour,
  onPress,
}: {
  /** A CSS colour, usually `laserInk(…)`. */
  colour: string;
  /** Called on every press — the canvas moves focus to its frame there, as its own press does. */
  onPress?: () => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const canvas = useRef<LaserCanvasHandle>(null);

  /** A client point in the layer's own pixels. */
  const local = (event: { clientX: number; clientY: number }): LaserPoint => {
    const box = layerRef.current?.getBoundingClientRect();
    return [event.clientX - (box?.left ?? 0), event.clientY - (box?.top ?? 0)];
  };

  return (
    <div
      ref={layerRef}
      aria-hidden
      className="absolute inset-0"
      // No cursor: the dot is the cursor. `touch-action` so a finger draws instead of scrolling the
      // window, which is what a touch screen does with a drag by default.
      style={{ cursor: "none", touchAction: "none" }}
      onPointerDown={(event) => {
        if (event.button !== 0 || canvas.current?.drawing()) return;
        // The press is the laser's, all of it: no text selection over the labels, and the canvas's
        // own press handler — which would select, pan or start a drag — never sees it.
        event.preventDefault();
        event.stopPropagation();
        onPress?.();
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = local(event);
        canvas.current?.dot(point);
        canvas.current?.begin(point, event.pointerId);
      }}
      onPointerMove={(event) => {
        canvas.current?.dot(local(event));
        // Every sample the browser merged into this event, not just the last: a fast circle drawn
        // from the last sample per frame comes out as a polygon.
        const merged = event.nativeEvent.getCoalescedEvents?.() ?? [];
        canvas.current?.extend(
          (merged.length > 0 ? merged : [event.nativeEvent]).map(local),
          event.pointerId,
        );
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        canvas.current?.end(event.pointerId);
      }}
      onPointerCancel={(event) => canvas.current?.end(event.pointerId)}
      // A capture can end without a `pointerup` reaching here — the window losing focus mid-stroke —
      // and a stroke nobody releases is one that never fades. After a normal release this finds
      // nothing live and does nothing.
      onLostPointerCapture={(event) => canvas.current?.end(event.pointerId)}
      onPointerLeave={() => canvas.current?.dot(null)}
      // The canvas's menus are under this layer and cannot be reached; the browser's own would be a
      // stray "Inspect element" over the drawing.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <LaserCanvas ref={canvas} colour={colour} />
    </div>
  );
}

/**
 * A stroke's points as one smooth path: a quadratic through each sample, ending on the midpoint to
 * the next, so the line turns where the hand turned instead of at every pixel it was sampled on. A
 * single point — a click without a drag — is a zero-length segment, which round caps draw as a dot.
 */
export function strokePath(points: readonly LaserPoint[]): string {
  if (points.length === 0) return "";
  const at = (n: number) => Math.round(n * 10) / 10;
  const [x0, y0] = points[0];
  if (points.length === 1) return `M${at(x0)} ${at(y0)}L${at(x0)} ${at(y0)}`;
  let d = `M${at(x0)} ${at(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${at(x)} ${at(y)} ${at((x + nx) / 2)} ${at((y + ny) / 2)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d}L${at(lx)} ${at(ly)}`;
}

/** The pen of `LaserGlyph`. `embed.ts` carries a transcription for the button it injects into
 *  draw.io's toolbar, where there is no React to render this component into — change them together. */
const LASER_PEN_PATHS = [
  "M18.586 2.586 11.586 9.586a2 2 0 0 0 2.828 2.828l7-7a2 2 0 0 0-2.828-2.828z",
  "m10 14-1.5 1.5",
] as const;

/**
 * The laser's glyph: a pointer pen and the spot it throws, the spot in the colour it will draw in —
 * so the button says which ink is loaded without a swatch beside it, the way a font-colour button
 * carries its colour under the letter.
 *
 * Drawn here rather than borrowed: the icon set has pens, highlighters and cursors, and each of
 * those says a different tool. Lucide's grammar — 24-unit box, 2-unit stroke, round caps — so it
 * sits among them at the same weight.
 */
export function LaserGlyph({ colour, size = 15 }: { colour: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {LASER_PEN_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
      <circle cx="5.5" cy="18.5" r="3" fill={colour} stroke="none" />
    </svg>
  );
}
