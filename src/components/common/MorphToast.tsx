import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { motion, useReducedMotionConfig } from "framer-motion";
import "./MorphToast.css";

/**
 * A toast drawn the way Sileo draws one (sileo.aaryan.design): an ink pill that melts into a body.
 *
 * # The shape is two rectangles and a filter
 *
 * The pill and the body are plain `<rect>`s on springs. What makes them read as one liquid shape is
 * the "goo" filter over both: blur them, then crush the alpha back to a hard edge (`20a − 10`), so
 * wherever the two blurs overlap the threshold fills the corner between them with a curve. Opening
 * reaches the pill into the body (`NECK`) while the body grows; the filter turns that overlap into
 * the neck you see. The HTML — the pill's line and the body's text — sits on top, positioned to match.
 *
 * Because the edge is a threshold, the shape can't carry a CSS border — so the same filter draws
 * one: the merged shape grown by a pixel, flooded with `--cf-toast-edge`, under the shape itself.
 * The card is the app's raised surface (`--cf-toast-fill`), not Sileo's inverted ink: dark on the
 * dark themes, light on the light ones, lifted off the sheet by that hairline and a soft shadow —
 * a card that belongs to the window rather than one that shouts over it.
 *
 * # The choreography, which is the other half of the look
 *
 * Rise in → 150 ms later the body melts out → it folds back 2 s before the end → it sinks away.
 * Hovering opens it again and leaving folds it; a stack keeps one body open at a time (`canExpand`).
 * All of that runs here off `duration`; the *stack* owns when the card leaves, because the pointer
 * pauses a whole stack's clock, not one card's.
 *
 * The look and the motion are Sileo's; the code is CodeFlow's own — Sileo was not installed (it holds
 * one toast at a time and title-cases every title), see the stores that feed this for why.
 */

export type ToastTone = "success" | "error" | "info" | "warning";

/** Sileo's measurements, kept so the shape reads the same. */
export const MORPH_WIDTH = 350;
const PILL = 40;
const ROUNDNESS = 16;
/** The filter's blur. The neck is three of them: enough overlap for the threshold to bridge. */
const GOO = ROUNDNESS / 2;
const NECK = GOO * 3;
/** An open card is never shorter than this, so even one line of body reads as a body. */
const MIN_OPEN = PILL * 2.25;
/** The pill's padding (8 + 8) plus the air either side of the line. */
const PILL_SLACK = 26;
/** Room around the shape for the filter to draw the hairline and the shadow into. */
const FILTER_MARGIN = 24;

export const MORPH_MS = 600;
/** How long a leaving card stays mounted — its sink and fade, and the room it gives back. */
export const LEAVE_MS = MORPH_MS;
const SPRING = { type: "spring", bounce: 0.25, duration: MORPH_MS / 1000 } as const;
/** Folding settles without the overshoot: a body bouncing on its way *in* is life, on its way out it
 *  is a shape that cannot decide. */
const SETTLE = { type: "spring", bounce: 0, duration: MORPH_MS / 1000 } as const;
const INSTANT = { duration: 0 } as const;
const OPEN_AFTER_MS = 150;
const CLOSE_BEFORE_END_MS = 2000;
const LINE_OUT_MS = MORPH_MS * 0.7;
/** A card raised again while open folds first and comes back — how long the fold gets. */
const SWAP_MS = 200;

const GLYPH: Record<ToastTone, ReactNode> = {
  success: <path d="M20 6 9 17l-5-5" />,
  error: (
    <>
      <path d="M12 6.5v7" />
      <path d="M12 17.5h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M12 6.5v7" />
      <path d="M12 17.5h.01" />
    </>
  ),
  info: (
    <>
      <path d="M12 11v6.5" />
      <path d="M12 6.5h.01" />
    </>
  ),
};

/**
 * The tone in a disc: what the pill leads with. Exported for anything that lists what a toast
 * announced — the bell's rows — so a row and the card that raised it are recognisably the same
 * thing. `onSheet` draws it in the sheet's own tones instead of the ink's (see `.cf-tone-badge`).
 */
export function ToneBadge({ tone, onSheet = false, className = "" }: { tone: ToastTone; onSheet?: boolean; className?: string }) {
  return (
    <span className={`${onSheet ? "cf-tone-badge" : "cf-morph-badge"} ${className}`} data-tone={tone} aria-hidden>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {GLYPH[tone]}
      </svg>
    </span>
  );
}

interface Line {
  key: string;
  tone: ToastTone;
  title: ReactNode;
}

export interface MorphToastProps {
  tone: ToastTone;
  /** What the pill says. */
  title: ReactNode;
  /** Identity of `title` — a change blurs the old line out under the new one. */
  titleKey: string;
  /** What melts out of the pill. Absent, the card is a pill and nothing more. */
  body?: ReactNode;
  /** Where the pill sits along the edge the stack hangs from. */
  align: "center" | "right";
  /** How long the card will be on screen: the body opens 150 ms in and folds 2 s before this. */
  duration: number;
  /** Bumped when the same card is raised again: fold, blur the line back in, open again. */
  raise?: number;
  /** Whether this card may hold its body open — a stack opens one at a time. */
  canExpand: boolean;
  leaving: boolean;
  /** Errors interrupt (`alert`); everything else waits its turn (`status`). */
  urgent?: boolean;
  /** At the end of the pill's line — the toast's ×. Shown only while the card is hovered or focused. */
  trailing?: ReactNode;
  onHoverChange?: (hovering: boolean) => void;
  /** Makes the whole card one button (pill and open body), labelled by `activateLabel`. */
  onActivate?: () => void;
  activateLabel?: string;
}

export function MorphToast({
  tone,
  title,
  titleKey,
  body,
  align,
  duration,
  raise = 0,
  canExpand,
  leaving,
  urgent = false,
  trailing,
  onHoverChange,
  onActivate,
  activateLabel,
}: MorphToastProps) {
  const reduce = useReducedMotionConfig() ?? false;
  // `useId` spells itself with characters a `url(#…)` reference does not survive in every engine.
  const filterId = `cf-goo-${useId().replace(/[^\w-]/g, "")}`;
  const hasBody = body !== undefined && body !== null && body !== false;

  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  /** The raise this card has caught up with — behind `raise` while an open body folds for it. */
  const [applied, setApplied] = useState(raise);
  const open = hasBody && !leaving && canExpand && (expanded || hovered);
  const openRef = useRef(open);
  openRef.current = open;

  /* ------------------------------ The pill's line ----------------------------- */

  const lineKey = `${tone}:${titleKey}:${applied}`;
  const shown = useRef<Line>({ key: lineKey, tone, title });
  const [prev, setPrev] = useState<Line | null>(null);
  // Every render: the snapshot is whatever was last drawn, so a change hands the outgoing line to
  // `prev` exactly as it looked.
  useLayoutEffect(() => {
    if (shown.current.key !== lineKey) setPrev(shown.current);
    shown.current = { key: lineKey, tone, title };
  });
  useEffect(() => {
    if (!prev) return;
    const timer = setTimeout(() => setPrev(null), LINE_OUT_MS);
    return () => clearTimeout(timer);
  }, [prev]);

  /* ------------------------------- Measurements ------------------------------- */

  const lineRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [pillWidth, setPillWidth] = useState(PILL);
  const [contentHeight, setContentHeight] = useState(0);

  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    const measure = () => {
      const width = Math.min(MORPH_WIDTH, Math.max(PILL, line.scrollWidth + PILL_SLACK));
      setPillWidth((current) => (current === width ? current : width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    return () => observer.disconnect();
  }, [lineKey]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!hasBody || !content) {
      setContentHeight(0);
      return;
    }
    const measure = () => {
      const height = content.scrollHeight;
      setContentHeight((current) => (current === height ? current : height));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasBody]);

  // One frame at rest before anything moves, so the rise has a "from" to transition out of.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  /* -------------------------------- Raised again ------------------------------ */

  const caughtUp = useRef(raise);
  useEffect(() => {
    if (caughtUp.current === raise) return;
    caughtUp.current = raise;
    // Read through the ref: with `open` as a dependency, the fold below would re-run this effect
    // and its cleanup would cancel the very swap it scheduled.
    if (!openRef.current) {
      setApplied(raise);
      return;
    }
    setExpanded(false);
    const timer = setTimeout(() => setApplied(raise), SWAP_MS);
    return () => clearTimeout(timer);
  }, [raise]);

  /* --------------------------------- Autopilot -------------------------------- */

  useEffect(() => {
    if (!hasBody) return;
    if (leaving || !canExpand) {
      setExpanded(false);
      return;
    }
    const timers = [window.setTimeout(() => setExpanded(true), OPEN_AFTER_MS)];
    const closeAt = duration - CLOSE_BEFORE_END_MS;
    if (closeAt > OPEN_AFTER_MS) timers.push(window.setTimeout(() => setExpanded(false), closeAt));
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [hasBody, leaving, canExpand, duration, applied]);

  /* ---------------------------------- Geometry -------------------------------- */

  const openHeight = Math.max(MIN_OPEN, PILL + contentHeight);
  // The body keeps the size it had while it folds, rather than chasing a content height that may
  // already be changing under it.
  const frozen = useRef(openHeight);
  if (open) frozen.current = openHeight;
  const svgHeight = hasBody ? Math.max(open ? openHeight : frozen.current, MIN_OPEN) : PILL;
  const pillX = align === "right" ? MORPH_WIDTH - pillWidth : (MORPH_WIDTH - pillWidth) / 2;
  const boxHeight = leaving ? 0 : open ? openHeight : PILL;

  const style = {
    "--cf-morph-w": `${MORPH_WIDTH}px`,
    "--cf-morph-h": `${boxHeight}px`,
    "--cf-morph-pw": `${pillWidth}px`,
    "--cf-morph-px": `${pillX}px`,
    "--cf-morph-pt": open ? "translateY(-3px) scale(0.9)" : "none",
    "--cf-morph-co": open ? 1 : 0,
  } as CSSProperties;

  const line = (layer: "current" | "prev", { key, tone: lineTone, title: lineTitle }: Line) => (
    <span
      key={key}
      ref={layer === "current" ? lineRef : undefined}
      className="cf-morph-line"
      data-layer={layer}
      aria-hidden={layer === "prev" || undefined}
      // The badge and title colour follow the tone the *line* was drawn in, so the outgoing line
      // keeps its own while it blurs out.
      style={{ "--cf-morph-tone": `var(--cf-toast-${lineTone === "error" ? "danger" : lineTone})` } as CSSProperties}
    >
      <ToneBadge tone={lineTone} />
      <span className="cf-morph-title">{lineTitle}</span>
      {layer === "current" && trailing}
    </span>
  );

  const shape = (
    <>
      <svg
        className="cf-morph-canvas"
        width={MORPH_WIDTH}
        height={svgHeight}
        viewBox={`0 0 ${MORPH_WIDTH} ${svgHeight}`}
        aria-hidden
      >
        <defs>
          {/* In user space with a fixed margin: a box relative to the shape (Sileo's ±20%) is 8px
              around a bare pill — enough for the goo, not for a shadow, which it would cut square. */}
          <filter
            id={filterId}
            filterUnits="userSpaceOnUse"
            x={-FILTER_MARGIN}
            y={-FILTER_MARGIN}
            width={MORPH_WIDTH + FILTER_MARGIN * 2}
            height={svgHeight + FILTER_MARGIN * 2}
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur in="SourceGraphic" stdDeviation={GOO} result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" result="shape" />
            {/* The hairline: the merged shape a pixel bigger, in the edge colour, under the shape. */}
            <feMorphology in="goo" operator="dilate" radius="1" result="grown" />
            <feFlood className="cf-morph-edge" result="edgeInk" />
            <feComposite in="edgeInk" in2="grown" operator="in" result="edge" />
            <feMerge result="card">
              <feMergeNode in="edge" />
              <feMergeNode in="shape" />
            </feMerge>
            {/* `dy` is negative because the canvas is flipped: up here is down on screen. */}
            <feDropShadow in="card" dx="0" dy="-3" stdDeviation="6" className="cf-morph-shadow" />
          </filter>
        </defs>
        <g filter={`url(#${filterId})`}>
          <motion.rect
            className="cf-morph-fill"
            rx={ROUNDNESS}
            ry={ROUNDNESS}
            initial={false}
            animate={{ x: pillX, width: pillWidth, height: open ? PILL + NECK : PILL }}
            transition={ready && !reduce ? SPRING : INSTANT}
          />
          {hasBody && (
            <motion.rect
              className="cf-morph-fill"
              y={PILL}
              width={MORPH_WIDTH}
              rx={ROUNDNESS}
              ry={ROUNDNESS}
              initial={false}
              animate={{ height: open ? openHeight - PILL : 0, opacity: open ? 1 : 0 }}
              transition={reduce ? INSTANT : open ? SPRING : SETTLE}
            />
          )}
        </g>
      </svg>

      <span className="cf-morph-pill">
        <span className="cf-morph-stack">
          {line("current", { key: lineKey, tone, title })}
          {prev && line("prev", prev)}
        </span>
      </span>

      {hasBody && (
        <span className="cf-morph-body" data-visible={open}>
          <span ref={contentRef} className="cf-morph-content">
            {body}
          </span>
        </span>
      )}
    </>
  );

  return (
    <div
      className="cf-morph"
      role={urgent ? "alert" : "status"}
      data-ready={ready}
      data-open={open}
      data-leaving={leaving}
      data-tone={tone}
      style={style}
      onPointerEnter={() => {
        setHovered(true);
        onHoverChange?.(true);
      }}
      onPointerLeave={() => {
        // Leaving folds it, as in Sileo: the pointer opened it, the pointer is done with it.
        setHovered(false);
        setExpanded(false);
        onHoverChange?.(false);
      }}
    >
      {onActivate ? (
        <button type="button" className="cf-morph-hit" title={activateLabel} onClick={onActivate}>
          {shape}
        </button>
      ) : (
        shape
      )}
    </div>
  );
}

interface StackEntry<T> {
  key: string;
  item: T;
  leaving: boolean;
}

/**
 * What every card in a stack shares: which ones are on their way out, whose turn it is to be open,
 * and one clock the pointer stops for all of them.
 *
 * - **Leaving** — an item that drops out of `items` stays drawn for `LEAVE_MS`, marked, so it can
 *   sink away and give its room back instead of vanishing and making the stack jump.
 * - **Open** — the most recent card that has a body to open (`orderOf`, `opensOf`), unless the
 *   pointer is on another one. A pill-only card arriving does not fold the error above it: it has
 *   nothing to show in the turn it would take.
 * - **The clock** — each card leaves after `durationOf` it, and `raiseOf` restarts it. Any card
 *   hovered stops every card's clock; leaving restarts them all from the top, as Sileo does — the
 *   card you were reading and the ones beside it get their full time back.
 */
export function useMorphStack<T>(
  items: readonly T[],
  {
    keyOf,
    orderOf,
    opensOf,
    durationOf,
    raiseOf,
    onExpire,
  }: {
    keyOf: (item: T) => string;
    orderOf: (item: T) => number;
    /** Whether the card has a body at all. Absent: every card does. */
    opensOf?: (item: T) => boolean;
    durationOf: (item: T) => number;
    raiseOf?: (item: T) => number;
    onExpire: (item: T) => void;
  },
) {
  const [entries, setEntries] = useState<StackEntry<T>[]>(() =>
    items.map((item) => ({ key: keyOf(item), item, leaving: false })),
  );
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const callbacks = useRef({ keyOf, onExpire, durationOf, raiseOf });
  callbacks.current = { keyOf, onExpire, durationOf, raiseOf };

  // Items only ever arrive at the end or drop out, so a merge in place keeps every card where it was.
  useLayoutEffect(() => {
    setEntries((current) => {
      const live = new Map(items.map((item) => [callbacks.current.keyOf(item), item] as const));
      const known = new Set<string>();
      let changed = false;
      const next = current.map((entry) => {
        known.add(entry.key);
        const now = live.get(entry.key);
        if (now !== undefined) {
          if (entry.item === now && !entry.leaving) return entry;
          changed = true;
          return { key: entry.key, item: now, leaving: false };
        }
        if (entry.leaving) return entry;
        changed = true;
        return { ...entry, leaving: true };
      });
      for (const [key, item] of live) {
        if (known.has(key)) continue;
        changed = true;
        next.push({ key, item, leaving: false });
      }
      return changed ? next : current;
    });
  }, [items]);

  // A leaving card is unmounted once it has finished leaving.
  const removals = useRef(new Map<string, number>());
  useEffect(() => {
    for (const entry of entries) {
      const pending = removals.current.get(entry.key);
      if (entry.leaving && pending === undefined) {
        removals.current.set(
          entry.key,
          window.setTimeout(() => {
            removals.current.delete(entry.key);
            setEntries((current) => current.filter((e) => !(e.key === entry.key && e.leaving)));
          }, LEAVE_MS),
        );
      } else if (!entry.leaving && pending !== undefined) {
        clearTimeout(pending);
        removals.current.delete(entry.key);
      }
    }
  }, [entries]);

  // A hovered card that has since started leaving no longer holds the stack.
  const hovered = entries.some((entry) => entry.key === hoveredKey && !entry.leaving) ? hoveredKey : null;

  const clocks = useRef(new Map<string, number>());
  useEffect(() => {
    const running = clocks.current;
    if (hovered !== null) {
      running.forEach((timer) => clearTimeout(timer));
      running.clear();
      return;
    }
    const wanted = new Set<string>();
    for (const entry of entries) {
      if (entry.leaving) continue;
      const clock = `${entry.key}:${callbacks.current.raiseOf?.(entry.item) ?? 0}`;
      wanted.add(clock);
      if (running.has(clock)) continue;
      const { item } = entry;
      running.set(
        clock,
        window.setTimeout(() => {
          running.delete(clock);
          callbacks.current.onExpire(item);
        }, callbacks.current.durationOf(item)),
      );
    }
    for (const [clock, timer] of running) {
      if (wanted.has(clock)) continue;
      clearTimeout(timer);
      running.delete(clock);
    }
  }, [entries, hovered]);

  useEffect(() => {
    const pendingRemovals = removals.current;
    const running = clocks.current;
    return () => {
      pendingRemovals.forEach((timer) => clearTimeout(timer));
      running.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  let latest: string | null = null;
  let latestOrder = -Infinity;
  for (const entry of entries) {
    if (entry.leaving || opensOf?.(entry.item) === false) continue;
    const order = orderOf(entry.item);
    if (order >= latestOrder) {
      latestOrder = order;
      latest = entry.key;
    }
  }

  return {
    entries,
    /** The one card allowed to hold its body open. */
    openKey: hovered ?? latest,
    hoverChange: (key: string) => (hovering: boolean) =>
      setHoveredKey((current) => (hovering ? key : current === key ? null : current)),
  };
}
