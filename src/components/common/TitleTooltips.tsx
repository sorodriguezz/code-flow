import { useEffect, useState, type ReactNode } from "react";
import { Kbd } from "./Button";
import { OPEN_DELAY, TooltipBubble, tooltipClosed, tooltipIsWarm } from "./Tooltip";

/**
 * Every `title` in the window, drawn as the app's own tooltip.
 *
 * The app had two kinds of hover label. `<Tooltip>` — the tab bar's, the rail's — opens in 120ms,
 * follows the pointer down a row without waiting again, and wears the theme. A plain `title` — on
 * roughly nine hundred buttons, links, checkboxes, rows and cells — waited the platform's second and
 * a half and then drew a grey system box that belongs to no theme. Converting them one by one would
 * be nine hundred edits and a rule every new control would have to remember; this converts them all
 * where they are, including the `title`s other code builds at run time.
 *
 * # How
 *
 * One pointer listener for the window. When the pointer comes to rest on an element with a
 * `title`, the attribute is moved aside into `data-cf-title` — which is what stops the platform's
 * tooltip, since it only ever reads `title` — and the same bubble `<Tooltip>` draws appears, with the
 * same delay and the same shared warm-up. When the pointer leaves, the attribute goes back, so the
 * DOM is as React left it and a later render that changes or drops the `title` finds it there. A
 * press puts the label away and restores the attribute before the click's own re-render.
 *
 * Keyboard focus shows it too, as `<Tooltip>` does — without touching the attribute, because a
 * focused control's `title` may be its accessible name, and the platform draws no tooltip on focus
 * anyway.
 *
 * # What it reads out of the text
 *
 * The hints written as `Label (⌘⇧A)` get the chord as a key cap, like the tab bar's; a `title` of
 * several lines keeps its first line as the label and the rest as the quieter description.
 *
 * # What it leaves alone
 *
 * Anything inside a `<Tooltip>` (marked `data-cf-tooltip`): that control already has a label of
 * ours, so its stray `title` is only suppressed. Monaco and the terminal, which draw their own
 * hovers. Touch, which has no hover. And anything marked `data-native-title`.
 */

const SKIP = ".monaco-editor, .xterm, [data-native-title]";

/** `Label (⌘⇧A)` on a Mac, `Label (Ctrl+Shift+A)` elsewhere — the shape `useShortcutHint` writes. */
const CHORD_AT_END = /^([\s\S]*?)\s*\(((?:[⌘⌥⇧⌃]+|(?:(?:Ctrl|Alt|Shift|Win|Meta|Cmd)\+)+)[^()\s]{1,12})\)$/;

interface Tip {
  rect: DOMRect;
  label: ReactNode;
  description?: string;
  trailing?: ReactNode;
}

function readTitle(text: string): Omit<Tip, "rect"> {
  const [first, ...rest] = text.split("\n");
  const description = rest.join("\n").trim() || undefined;
  const chord = CHORD_AT_END.exec(first.trim());
  if (chord && chord[1].trim()) {
    return { label: chord[1].trim(), description, trailing: <Kbd>{chord[2]}</Kbd> };
  }
  return { label: first.trim(), description };
}

export function TitleTooltips() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    /** The element whose `title` is set aside right now, if any. */
    let held: HTMLElement | null = null;
    /** Pressed: stays quiet until the pointer has left it. */
    let pressed: HTMLElement | null = null;
    let timer: number | null = null;
    let shown = false;

    const cancel = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const hide = () => {
      cancel();
      if (shown) {
        shown = false;
        tooltipClosed();
      }
      setTip(null);
    };

    /** Puts the attribute back where React left it. */
    const release = () => {
      if (!held) return;
      const stashed = held.getAttribute("data-cf-title");
      held.removeAttribute("data-cf-title");
      // Only if nothing wrote a new one meanwhile — a render that changed the title wins.
      if (stashed !== null && !held.hasAttribute("title")) held.setAttribute("title", stashed);
      held = null;
    };

    /** Sets `el`'s title aside and returns its text. Picks up a title a render wrote meanwhile. */
    const take = (el: HTMLElement): string => {
      const fresh = el.getAttribute("title");
      if (fresh !== null) {
        el.setAttribute("data-cf-title", fresh);
        el.removeAttribute("title");
      }
      return (el.getAttribute("data-cf-title") ?? "").trim();
    };

    const open = (el: HTMLElement, text: string) => {
      const rect = el.getBoundingClientRect();
      if (!text || (!rect.width && !rect.height)) return;
      shown = true;
      setTip({ rect, ...readTitle(text) });
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest<HTMLElement>("[title], [data-cf-title]") ?? null;

      if (el !== held) {
        release();
        hide();
        if (pressed && el !== pressed) pressed = null;
      }
      if (!el || !(el instanceof HTMLElement) || el.closest(SKIP)) return;

      if (el === held) {
        // Still on it. A render may have written a new title — keep it aside and show the new text.
        if (el.hasAttribute("title")) {
          const text = take(el);
          if (shown) open(el, text);
        }
        return;
      }

      held = el;
      const text = take(el);
      // Inside a `<Tooltip>`, or just pressed: the native box is suppressed and ours stays away.
      if (el.closest("[data-cf-tooltip]") || el === pressed) return;
      if (tooltipIsWarm()) open(el, text);
      else timer = window.setTimeout(() => open(el, text), OPEN_DELAY);
    };

    const onLeaveWindow = (e: PointerEvent) => {
      if (e.relatedTarget === null) {
        release();
        hide();
        pressed = null;
      }
    };

    // A press puts it away and leaves it away (the click is about to change what is on screen) —
    // and hands the attribute back first, so the click's own render meets the DOM it expects.
    const onDown = () => {
      if (!held) return;
      pressed = held;
      release();
      hide();
    };

    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el || !el.matches(":focus-visible") || el.closest(SKIP) || el.closest("[data-cf-tooltip]")) return;
      const text = (el.getAttribute("title") ?? el.getAttribute("data-cf-title") ?? "").trim();
      if (text) open(el, text);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onLeaveWindow, { passive: true });
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    window.addEventListener("keydown", onKey);
    // Pinned to coordinates taken once, so anything that moves the page moves it out of date.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      cancel();
      release();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onLeaveWindow);
      document.removeEventListener("pointerdown", onDown, { capture: true });
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  return (
    <TooltipBubble
      anchor={tip.rect}
      label={tip.label}
      description={tip.description}
      trailing={tip.trailing}
    />
  );
}
