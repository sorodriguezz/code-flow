import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus, Quote } from "lucide-react";
import { useT } from "../../state/languageStore";
import { buttonClass } from "../common/Button";

/** How far above the selection the bar floats, in pixels. Enough to clear the text's own
 *  descenders and the browser's selection highlight without detaching from it. */
const GAP = 8;
/** Kept this far from the window edges, the same inset every other popover in the app uses. */
const EDGE = 8;

/** What the user has selected, frozen at the moment they finished selecting it. */
interface Picked {
  text: string;
  /** Viewport coordinates of the selection, for placing the bar. */
  rect: { top: number; left: number; width: number };
}

/**
 * The two things you can do with a passage you just selected.
 *
 * # Why the text is captured rather than read on click
 *
 * Pressing a button moves focus, and moving focus is one of the several ways a browser collapses a
 * selection. A handler that called `getSelection()` at click time would therefore be reading a
 * selection that, depending on the browser and on whether the press landed on the label or the
 * padding, may already be gone — which fails *intermittently*, the worst possible way for a
 * copy-like gesture to fail. So the passage is read once, when the pointer comes up, and the
 * buttons only ever use that copy.
 *
 * # Why it closes on scroll instead of following
 *
 * The bar is `fixed`, positioned from the selection's viewport rectangle, because the transcript is
 * a scroll container and an absolutely-positioned child would be clipped by it. A fixed element
 * does not follow its anchor, so a scroll would strand it over unrelated text — the same trade
 * `ColorSwatchPicker` makes, and the same resolution: close, rather than track.
 */
export function SelectionActions({
  scope,
  onQuoteReply,
  onQuoteNewChat,
}: {
  /** The element a selection has to be inside to count. Anything outside — the sidebar, the
   *  composer, another pane — is somebody else's text. */
  scope: React.RefObject<HTMLElement | null>;
  /** Quote it into the composer of *this* conversation. */
  onQuoteReply: (passage: string) => void;
  /** Start a new conversation with it in the composer. */
  onQuoteNewChat: (passage: string) => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Picked | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  /** The bar's own width, once it exists. `0` means "not measured yet", which is what keeps it
   *  invisible for the one frame before it can be placed. */
  const [measured, setMeasured] = useState(0);

  useEffect(() => {
    const read = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPicked(null);
        return;
      }
      const text = selection.toString().trim();
      if (!text) {
        setPicked(null);
        return;
      }
      const range = selection.getRangeAt(0);
      // Both ends, because a drag that starts in the transcript and ends in the composer is not a
      // transcript selection — and `commonAncestorContainer` is a text node when the selection is
      // inside one, so the check has to tolerate that.
      const host = scope.current;
      if (!host || !host.contains(range.commonAncestorContainer)) {
        setPicked(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      // A zero-height rectangle means the range resolved to nothing paintable — a selection made up
      // entirely of collapsed whitespace, or one the layout has not settled yet.
      if (rect.width === 0 && rect.height === 0) {
        setPicked(null);
        return;
      }
      setPicked({ text, rect: { top: rect.top, left: rect.left, width: rect.width } });
    };

    // `mouseup` and `keyup` rather than `selectionchange`: the question is "has the user *finished*
    // choosing", and `selectionchange` fires on every pixel of a drag — which would have the bar
    // chasing the pointer across the paragraph being selected.
    const onUp = () => {
      // One frame late, deliberately. The selection is not final until the browser has processed
      // the same mouseup — reading it synchronously returns the state before the release, which on
      // a double-click word selection is the *previous* selection.
      requestAnimationFrame(read);
    };
    const onSelectionChange = () => {
      // The other half: a click that collapses the selection must take the bar away with it, and
      // that never produces a `mouseup` with anything selected.
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setPicked(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPicked(null);
        return;
      }
      // Only the keys that can actually change a selection. Re-reading on every keystroke would
      // run a `getSelection` and a frame callback for each character typed in the composer, to
      // discover each time that the selection is somewhere else entirely.
      const selects =
        event.key.startsWith("Arrow") ||
        event.key === "Home" ||
        event.key === "End" ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a");
      if (selects) onUp();
    };

    // Named rather than inline, so the cleanup can actually remove them. An inline arrow here is
    // a listener per mount that nothing ever takes off `window`.
    const dismiss = () => setPicked(null);

    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onSelectionChange);
    // Capture, because the scroller that moves is a descendant and its scroll does not bubble.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [scope]);

  useLayoutEffect(() => {
    if (!picked) {
      setMeasured(0);
      return;
    }
    const bar = barRef.current;
    if (bar) setMeasured(bar.offsetWidth);
  }, [picked]);

  // Measured after mount rather than assumed, and hidden until it has been: the bar is centred on
  // the selection, so guessing its width puts it visibly off-centre on the first frame and then
  // never corrects — nothing re-renders to fix it. The same measure-then-place dance
  // `ColorSwatchPicker` does, for the same reason.
  const width = measured;
  const centred = picked ? picked.rect.left + picked.rect.width / 2 - width / 2 : 0;
  const left = Math.max(EDGE, Math.min(centred, window.innerWidth - width - EDGE));
  // Below the selection instead of above when there is no room above — a passage selected at the
  // very top of the transcript would otherwise put the bar off-screen.
  const above = (picked?.rect.top ?? 0) - GAP;
  const flipped = above < 44;
  const top = flipped ? (picked?.rect.top ?? 0) + GAP + 18 : above;

  if (!picked) return null;

  return createPortal(
    <div
      ref={barRef}
      style={{
        top,
        left,
        transform: flipped ? undefined : "translateY(-100%)",
        visibility: width > 0 ? "visible" : "hidden",
      }}
      // `onMouseDown` prevented on the container: pressing anywhere in the bar must not move focus
      // out of the document's selection, because on some browsers that collapses it *before* the
      // click fires — and the click handler would then run against nothing. The captured text
      // makes this belt-and-braces rather than load-bearing, which is how it should be.
      onMouseDown={(event) => event.preventDefault()}
      className="cf-fade-in fixed z-[9999] flex items-center gap-0.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-0.5 shadow-[var(--cf-shadow)]"
    >
      <button
        type="button"
        onClick={() => {
          onQuoteReply(picked.text);
          setPicked(null);
        }}
        className={buttonClass({ variant: "ghost", size: "sm" })}
      >
        <Quote size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        {t("chat.quoteReply")}
      </button>
      <div className="h-4 w-px bg-[var(--cf-border)]" />
      <button
        type="button"
        onClick={() => {
          onQuoteNewChat(picked.text);
          setPicked(null);
        }}
        className={buttonClass({ variant: "ghost", size: "sm" })}
      >
        <MessageSquarePlus size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        {t("chat.quoteNewChat")}
      </button>
    </div>,
    document.body,
  );
}
