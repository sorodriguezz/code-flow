import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, PartyPopper, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { tourLength, tourStep, useTourStore } from "../../state/tourStore";
import { chordLabel } from "../../lib/keys";
import { pressBelongsToWindow } from "../../lib/overlayDragRegion";
import type { TourPlacement } from "../../lib/tour/steps";
import { Confetti } from "./Confetti";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Size {
  w: number;
  h: number;
}

const CARD_WIDTH = 384;
/** Closest the card ever gets to the window edge. */
const EDGE = 16;
/** Space between the spotlight and the card beside it. */
const GAP = 14;
/** Frames a vanished anchor keeps its old spotlight before the tour gives up on it. Covers the
 * gap where a panel has been asked to open and hasn't mounted yet — roughly a second at 60fps,
 * comfortably longer than the app's own 180ms panel transitions. */
const STALE_FRAMES = 60;

function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** The first of a step's selectors that is actually on screen, or `null`. A match that measures
 * zero doesn't count: a collapsed panel leaves its markup behind at no size, and spotlighting that
 * is a hole in the dark with nothing in it. */
function resolveAnchor(selectors: string[] | undefined): HTMLElement | null {
  if (!selectors) return null;
  for (const selector of selectors) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) return el;
  }
  return null;
}

/**
 * The anchor's rectangle, padded out — then pulled back inside the window.
 *
 * The clamp is what keeps the ring visible on anything docked against an edge. The AI panel's right
 * side *is* the right side of the window, so padding it by 8 puts a quarter of the highlight past
 * the glass, and the accent outline reads as three sides and a gap. Two pixels in from each edge is
 * enough for the border to land on screen.
 */
function spotlightBox(rect: DOMRect, padding: number, vp: Size): Box {
  const left = Math.max(rect.left - padding, 2);
  const top = Math.max(rect.top - padding, 2);
  const right = Math.min(rect.right + padding, vp.w - 2);
  const bottom = Math.min(rect.bottom + padding, vp.h - 2);
  return { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

type Side = "top" | "bottom" | "left" | "right" | null;

interface Placement {
  left: number;
  top: number;
  /** Which edge of the card the little arrow sticks out of, pointing back at the spotlight. */
  side: Side;
  /** Where along that edge, in px from the card's own top-left. */
  arrowAt: number;
}

/**
 * Where the card goes.
 *
 * Tried in order — below, above, right, left — and the first side with room wins, which is what
 * keeps the card off the thing it is describing. Everything is clamped to the window afterwards, so
 * a spotlight in a corner still gets a fully visible card rather than one hanging off the edge.
 */
function placeCard(box: Box | null, placement: TourPlacement, card: Size, vp: Size): Placement {
  const clampX = (x: number) => Math.min(Math.max(x, EDGE), Math.max(EDGE, vp.w - card.w - EDGE));
  const clampY = (y: number) => Math.min(Math.max(y, EDGE), Math.max(EDGE, vp.h - card.h - EDGE));
  const centered: Placement = {
    left: clampX((vp.w - card.w) / 2),
    top: clampY((vp.h - card.h) / 2),
    side: null,
    arrowAt: 0,
  };

  if (!box || placement === "center") return centered;

  // A whole view or the settings dialog: the spotlight *is* the point, so the card sits inside it
  // rather than beside it — there is no "beside" for something that fills the window.
  if (placement === "inside") {
    const left = clampX(box.left + (box.width - card.w) / 2);
    const roomy = box.height > card.h + GAP * 4;
    const top = roomy
      ? clampY(box.top + box.height - card.h - GAP * 2)
      : clampY(box.top + (box.height - card.h) / 2);
    return { left, top, side: null, arrowAt: 0 };
  }

  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  const alignedLeft = clampX(centerX - card.w / 2);
  const alignedTop = clampY(centerY - card.h / 2);
  /** The arrow follows the anchor's centre, but never past the card's own rounded corners. */
  const along = (target: number, origin: number, extent: number) =>
    Math.min(Math.max(target - origin, 22), Math.max(22, extent - 22));

  const below = box.top + box.height + GAP;
  if (below + card.h <= vp.h - EDGE) {
    return { left: alignedLeft, top: below, side: "top", arrowAt: along(centerX, alignedLeft, card.w) };
  }
  const above = box.top - GAP - card.h;
  if (above >= EDGE) {
    return { left: alignedLeft, top: above, side: "bottom", arrowAt: along(centerX, alignedLeft, card.w) };
  }
  const right = box.left + box.width + GAP;
  if (right + card.w <= vp.w - EDGE) {
    return { left: right, top: alignedTop, side: "left", arrowAt: along(centerY, alignedTop, card.h) };
  }
  const leftSide = box.left - GAP - card.w;
  if (leftSide >= EDGE) {
    return { left: leftSide, top: alignedTop, side: "right", arrowAt: along(centerY, alignedTop, card.h) };
  }
  return centered;
}

/** The arrow: a rotated square wearing the card's own fill and two of its borders, so it reads as a
 * corner of the card rather than a separate diamond parked next to it. */
function Arrow({ side, at }: { side: Exclude<Side, null>; at: number }) {
  const base = "absolute h-3 w-3 rotate-45 bg-[var(--cf-surface-raised)] border-[var(--cf-border)]";
  if (side === "top") {
    return <span aria-hidden style={{ left: at }} className={`${base} -top-[6px] -translate-x-1/2 border-l border-t`} />;
  }
  if (side === "bottom") {
    return <span aria-hidden style={{ left: at }} className={`${base} -bottom-[6px] -translate-x-1/2 border-b border-r`} />;
  }
  if (side === "left") {
    return <span aria-hidden style={{ top: at }} className={`${base} -left-[6px] -translate-y-1/2 border-b border-l`} />;
  }
  return <span aria-hidden style={{ top: at }} className={`${base} -right-[6px] -translate-y-1/2 border-r border-t`} />;
}

/**
 * The guided tour: everything dims except the one control being explained, with a card beside it.
 *
 * **The app is driven, not just annotated.** Each step declares the state it needs (see
 * `lib/tour/stage`) and the store applies it before the overlay looks for the anchor, so the panel
 * a step is about is genuinely open behind the spotlight. That is also why the overlay swallows
 * every click: the sequence only holds together if the app is where the step left it, and a stray
 * click on a highlighted button would take the user somewhere the next step doesn't describe.
 *
 * **Geometry is re-measured every frame.** The panels being pointed at animate open over ~180ms,
 * the window can be resized mid-step, and a repository can finish loading and reflow the sidebar.
 * A one-shot measurement is wrong in all three cases; a `requestAnimationFrame` loop that only
 * writes state when the rectangle actually moved is right in all three, and costs a comparison per
 * frame for as long as the tour is up.
 */
export function TourOverlay() {
  const active = useTourStore((s) => s.active);
  const celebrating = useTourStore((s) => s.celebrating);
  const tourId = useTourStore((s) => s.tourId);
  const index = useTourStore((s) => s.index);
  const next = useTourStore((s) => s.next);
  const back = useTourStore((s) => s.back);
  const skip = useTourStore((s) => s.skip);
  const endCelebration = useTourStore((s) => s.endCelebration);
  const t = useT();

  const total = tourLength(tourId);
  const step = tourStep(tourId, index);
  const cardRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [card, setCard] = useState<Size>({ w: CARD_WIDTH, h: 220 });
  const [vp, setVp] = useState<Size>(() => ({ w: window.innerWidth, h: window.innerHeight }));

  const isFirst = index === 0;
  const isLast = index === total - 1;

  // Re-measure the anchor, and the window, on every frame the tour is up. `staleFrames` is what
  // stops the spotlight blinking out while a panel this step just asked for is still mounting:
  // the previous rectangle is held briefly rather than cleared the instant the selector misses.
  const staleRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const el = resolveAnchor(step.anchors);
      if (el) {
        staleRef.current = 0;
        const measured = spotlightBox(el.getBoundingClientRect(), step.padding ?? 8, {
          w: window.innerWidth,
          h: window.innerHeight,
        });
        setBox((prev) => (sameBox(prev, measured) ? prev : measured));
      } else if (!step.anchors) {
        setBox((prev) => (prev === null ? prev : null));
      } else if (staleRef.current++ > STALE_FRAMES) {
        setBox((prev) => (prev === null ? prev : null));
      }
      setVp((prev) =>
        prev.w === window.innerWidth && prev.h === window.innerHeight
          ? prev
          : { w: window.innerWidth, h: window.innerHeight },
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, step]);

  // A step's anchor can be below the fold of its own scroller — a settings section, a long
  // sidebar. Nudged into view once per step, and only as far as needed.
  useEffect(() => {
    if (!active) return;
    staleRef.current = 0;
    let cancelled = false;
    let attempts = 0;
    const look = () => {
      if (cancelled) return;
      const el = resolveAnchor(step.anchors);
      if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      else if (attempts++ < 40) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    return () => {
      cancelled = true;
    };
  }, [active, step]);

  // The card's own height decides which side of the anchor it fits on, so it has to be measured
  // rather than guessed — and re-measured when a translation makes the body a line taller.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setCard((prev) =>
        Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5
          ? prev
          : { w: rect.width, h: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, index]);

  const advance = useCallback(() => next(), [next]);

  // Capture phase, ahead of everything else: the app's own global shortcuts and the settings
  // dialog's Escape handler both listen on the window, and without this an Escape meant for the
  // tour would also close the settings the tour had just opened.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        skip();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        advance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        back();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, advance, back, skip]);

  if (!active) {
    return celebrating ? <Confetti onDone={endCelebration} /> : null;
  }

  const placement = placeCard(box, step.placement ?? "auto", card, vp);
  const radius = step.radius ?? 10;
  const progress = ((index + 1) / total) * 100;

  return createPortal(
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cf-tour-title"
        aria-describedby="cf-tour-body"
        // Above every menu and modal in the app, which top out at `z-[9999]`.
        className="fixed inset-0 z-[100000]"
        // Swallows clicks meant for the app underneath. Not a skip gesture: a misplaced click
        // would end the tour with no warning and no way back to where it was.
        //
        // The window's own chrome is the exception. The tour pauses the *app*; the window it is
        // drawn in still has to move, zoom, minimize and close, and one that does none of those
        // for the length of a tour reads as hung rather than as busy. What has to be
        // skipped is the `preventDefault` itself: `overlayDragRegion` — which resolves the press
        // against the title bar this veil is covering — treats an already-defaulted press as one
        // the app declined, and stops.
        onMouseDown={(e) => {
          if (pressBelongsToWindow(e.nativeEvent)) return;
          e.preventDefault();
        }}
      >
        {box ? (
          <>
            {/* The dim, drawn as one enormous shadow cast *outward* from the hole. One element,
                one repaint, and — unlike four rectangles around the anchor — the corners round
                properly against whatever is being highlighted. */}
            <div
              className="cf-tour-spot"
              style={{
                position: "fixed",
                top: box.top,
                left: box.left,
                width: box.width,
                height: box.height,
                borderRadius: radius,
              }}
            />
            {/* The ring is a separate element painted after the mask: box-shadows stack outward
                from the same box, so a ring declared alongside the dim would be underneath it. */}
            <div
              aria-hidden
              className="cf-tour-ring"
              style={{
                position: "fixed",
                top: box.top,
                left: box.left,
                width: box.width,
                height: box.height,
                borderRadius: radius,
              }}
            />
          </>
        ) : (
          <div className="cf-tour-veil absolute inset-0" />
        )}

        <div
          ref={cardRef}
          className="cf-tour-card absolute w-[384px] max-w-[calc(100vw-32px)] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
          style={{ top: placement.top, left: placement.left }}
        >
          {placement.side && <Arrow side={placement.side} at={placement.arrowAt} />}

          <div className="mb-2.5 flex items-center gap-2">
            <span className="rounded-full bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-accent)]">
              {t(step.chapterKey)}
            </span>
            <span className="ml-auto text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              {t("tour.stepOf", { n: index + 1, total })}
            </span>
            <button
              onClick={skip}
              title={t("tour.skip")}
              aria-label={t("tour.skip")}
              className="-mr-1 flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
            >
              <X size={13} />
            </button>
          </div>

          <h2 id="cf-tour-title" className="mb-1.5 flex items-center gap-2 text-[15px] font-semibold text-[var(--cf-text)]">
            {isLast && <PartyPopper size={15} className="shrink-0 text-[var(--cf-accent)]" />}
            {t(step.titleKey)}
          </h2>
          {/* `whitespace-pre-line` so a body can hold two paragraphs when it carries two ideas —
              a card that explains a panel *and* the one control on it that leaves the panel reads
              as two things, and running them together buries the second. Only blank lines survive:
              ordinary wrapping is untouched, so every card written as one paragraph is unchanged. */}
          <p
            id="cf-tour-body"
            className="whitespace-pre-line text-[13px] leading-relaxed text-[var(--cf-text-muted)]"
          >
            {/* `{key}` is rendered in the running platform's notation — ⌘I on a Mac, Ctrl+I on
                Windows — so no card ever spells out both and leaves the reader to pick. */}
            {t(step.bodyKey, step.chord ? { key: chordLabel(step.chord) } : undefined)}
          </p>

          <div className="mt-3.5 h-[3px] w-full overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--cf-text)_10%,transparent)]">
            <div
              className="h-full rounded-full bg-[var(--cf-accent)] transition-[width] duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            {/* Gone on the last card, where there is nothing left to skip *to* — offering an exit
                beside a Finish button only invites people to take the one without the confetti.
                The × in the corner is still there for anyone who wants out without the send-off. */}
            {!isLast && (
              <button
                onClick={skip}
                className="rounded-md px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
              >
                {t("tour.skip")}
              </button>
            )}
            <span className="ml-auto flex items-center gap-2">
              {/* Rendered from the second step on, rather than disabled on the first: a control
                  that is permanently dead on the screen where you meet it is just noise. */}
              {!isFirst && (
                <button
                  onClick={back}
                  className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  <ArrowLeft size={13} />
                  {t("tour.back")}
                </button>
              )}
              <button
                onClick={advance}
                autoFocus
                className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
              >
                {isLast ? t("tour.finish") : t("tour.next")}
                {!isLast && <ArrowRight size={13} />}
              </button>
            </span>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
