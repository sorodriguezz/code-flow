import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The app's own tooltip, in place of the browser's `title`.
 *
 * `title` is free and it is what every icon-only control here used, but it buys three problems: the
 * platform decides how long to wait (about a second and a half on macOS, long enough that the label
 * lands after you have already guessed and clicked), the platform decides how it looks — so on a
 * rail of workspace-coloured chips you get a grey system box that belongs to no theme — and it is
 * one line of plain text, which is why the hints it carried were written as `{name} — {description}`
 * concatenations. All three go away once the label is ours to draw.
 *
 * `title` is still the right call for text that is merely *truncated* — a table cell, a path — where
 * the tooltip is a fallback rather than the only label. This is for the controls that have no label
 * at all without it.
 */
export type TooltipSide = "top" | "right" | "bottom" | "left";

/** How long the pointer must rest before the first tooltip of a series appears. Short enough to
 *  feel like a property of the control, long enough not to fire at things merely crossed. */
const OPEN_DELAY = 120;

/**
 * ...and how long after one closes that the *next* one opens with no wait at all.
 *
 * Running down a rail is one gesture, not five separate hovers: once the first label has been
 * earned, the rest should follow the pointer. Without this, reading a rail of six glyphs costs six
 * separate waits, which is the thing that makes a delay feel like lag rather than like restraint.
 */
const WARM_WINDOW = 450;

/** Deliberately module-level, shared by every tooltip on screen: the warm-up belongs to the user's
 *  gesture, not to any one trigger. A per-trigger timer would reset on the first chip you leave. */
let warmUntil = 0;

/** Distance from the trigger, and from the window edge when a tooltip has to be pushed back on. */
const GAP = 8;
const MARGIN = 8;

interface Placement {
  left: number;
  top: number;
  side: TooltipSide;
}

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/**
 * Where the box goes, given the trigger and the box's own measured size.
 *
 * Flips to the opposite side when the preferred one doesn't fit — a rail sits against a window edge,
 * so the side that works is decided by which edge, not by the call site — and then clamps on the
 * other axis, which is what keeps the label beside the *last* chip of a tall rail on screen.
 */
function place(anchor: DOMRect, width: number, height: number, preferred: TooltipSide): Placement {
  const fits = (side: TooltipSide) => {
    if (side === "right") return anchor.right + GAP + width <= window.innerWidth - MARGIN;
    if (side === "left") return anchor.left - GAP - width >= MARGIN;
    if (side === "top") return anchor.top - GAP - height >= MARGIN;
    return anchor.bottom + GAP + height <= window.innerHeight - MARGIN;
  };
  const side = fits(preferred) ? preferred : fits(OPPOSITE[preferred]) ? OPPOSITE[preferred] : preferred;

  const horizontal = side === "left" || side === "right";
  const left = horizontal
    ? side === "right"
      ? anchor.right + GAP
      : anchor.left - GAP - width
    : anchor.left + anchor.width / 2 - width / 2;
  const top = horizontal
    ? anchor.top + anchor.height / 2 - height / 2
    : side === "bottom"
      ? anchor.bottom + GAP
      : anchor.top - GAP - height;

  return {
    side,
    left: Math.min(Math.max(left, MARGIN), Math.max(MARGIN, window.innerWidth - width - MARGIN)),
    top: Math.min(Math.max(top, MARGIN), Math.max(MARGIN, window.innerHeight - height - MARGIN)),
  };
}

/** The few pixels the box travels on the way in — from the trigger, so it reads as coming *out* of
 *  the control it belongs to rather than appearing beside it. */
function entryOffset(side: TooltipSide): { x: string; y: string } {
  if (side === "right") return { x: "-4px", y: "0px" };
  if (side === "left") return { x: "4px", y: "0px" };
  if (side === "bottom") return { x: "0px", y: "-4px" };
  return { x: "0px", y: "4px" };
}

export function Tooltip({
  label,
  description,
  leading,
  trailing,
  side = "top",
  disabled = false,
  children,
}: {
  /** The line that replaces the control's missing label. */
  label: React.ReactNode;
  /** A second, quieter line — what the control is *for*, when the name doesn't say it. */
  description?: React.ReactNode;
  /** Drawn before the label: the colour dot of a project, the glyph of an engine. A tooltip that
   *  carries the thing's own colour is how you tell two identically-shaped chips apart. */
  leading?: React.ReactNode;
  /** After the label — a "beta" chip, a shortcut. */
  trailing?: React.ReactNode;
  side?: TooltipSide;
  /** For a control whose tooltip only applies sometimes; flipping it true also hides an open one. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  /** Whether a tooltip was actually shown, as opposed to merely scheduled — only a real one earns
   *  the next trigger its instant open. */
  const shown = useRef(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  const clear = () => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  };

  const hide = useCallback(() => {
    clear();
    if (shown.current) {
      shown.current = false;
      warmUntil = Date.now() + WARM_WINDOW;
    }
    setAnchor(null);
    setPos(null);
  }, []);

  const show = useCallback(() => {
    // The wrapper is `display: contents`, so it has no box of its own to measure — the child is the
    // control. That is the whole reason for `contents`: these rails are pixel-tuned, and a wrapper
    // that generated a box would be a wrapper that changed the layout it was documenting.
    const box = wrapRef.current?.firstElementChild ?? wrapRef.current;
    const rect = box?.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    shown.current = true;
    setAnchor(rect);
  }, []);

  const schedule = useCallback(() => {
    if (disabled) return;
    clear();
    if (Date.now() < warmUntil) {
      show();
      return;
    }
    timer.current = window.setTimeout(show, OPEN_DELAY);
  }, [disabled, show]);

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  // Measured, then placed. Two renders, but the first one is `hidden` rather than mispositioned:
  // the alternative is guessing the box's size, and the description makes that a guess about text
  // wrapping in whichever language is loaded.
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return;
    const { width, height } = tipRef.current.getBoundingClientRect();
    setPos(place(anchor, width, height, side));
  }, [anchor, side]);

  // Anything that moves the trigger out from under its label puts the label away. A tooltip is
  // pinned to coordinates taken once, so "stale" and "wrong" are the same thing here.
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    // Capture, because the scroll that matters is usually some panel's, not the window's.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, hide]);

  useEffect(() => clear, []);

  const offset = entryOffset(pos?.side ?? side);

  return (
    <>
      <span
        ref={wrapRef}
        style={{ display: "contents" }}
        onPointerEnter={schedule}
        onPointerLeave={hide}
        // A press puts it away and leaves it away: the click is about to change what is on screen,
        // and a label explaining the button you just used is a label about the past.
        onPointerDown={hide}
        // Keyboard focus shows it at once — a delay on focus is a delay on the only way a keyboard
        // has of reading the control. Gated on `:focus-visible` so the focus a *click* leaves behind
        // doesn't bring back the tooltip that the click just dismissed.
        onFocus={(e) => {
          if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) show();
        }}
        onBlur={hide}
      >
        {children}
      </span>

      {anchor &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            style={
              {
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                // Rendered before it is placed, so it can be measured — hidden rather than
                // transparent, because a transparent box still animates, and it would play its
                // entrance at the wrong coordinates.
                visibility: pos ? "visible" : "hidden",
                "--cf-tip-x": offset.x,
                "--cf-tip-y": offset.y,
              } as React.CSSProperties
            }
            // The shadow lives in `.cf-tip` rather than a Tailwind class — it is two layers, and
            // one of them is mixed per theme. See `index.css`.
            className="cf-tip pointer-events-none fixed z-[70] max-w-[15rem] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2 py-[5px]"
          >
            <div className="flex items-center gap-1.5">
              {leading}
              <span className="min-w-0 break-words text-[12px] font-medium leading-tight text-[var(--cf-text)]">
                {label}
              </span>
              {trailing}
            </div>
            {description && (
              <p className="mt-1 break-words text-[11px] leading-snug text-[var(--cf-text-muted)]">
                {description}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
