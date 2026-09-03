/**
 * The app's context menu, and the only one.
 *
 * It lived inside `api/CollectionTree.tsx` — 1700 lines of API-client feature — and was imported
 * from there by thirty-five files across the editor, the database workspace, the terminal, notes,
 * diagrams, the keyring, the agent console and the remote hosts. Opening the notes view pulled in
 * the API client's collection tree to get a menu. This is the same component, moved to where a
 * shared primitive belongs.
 *
 * Its labels **wrap** rather than truncate. They used to truncate, which on a 172px menu turned
 * "Duplicar en este workspace" into "Duplicar en est…" — a menu entry whose verb you cannot read is
 * one you have to click to identify, which is the one thing a menu must never require.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { useDismissOnOutside } from "../../lib/useDismissOnOutside";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  /** Rendered in place of `icon`, for the marks a Lucide glyph can't be — a database engine's own
   * logo in its own hue, say. */
  leading?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** Draws a hairline above this item. */
  separated?: boolean;
  /**
   * Shown, greyed, and inert.
   *
   * For an action that exists but cannot be taken *right now* — a connect whose round trip is still
   * in flight. Removing the entry instead would make the menu change length under the pointer, and
   * leaving it live would let a second click start a second session.
   */
  disabled?: boolean;
}

/** A floating menu at a point, portalled so no scroll container can clip it. Positioned after
 * mount because its size is only known once it's rendered — the clamp is what keeps a menu opened
 * near the bottom of the window from hanging off the edge. */
/** How far a button-anchored menu sits from its trigger. */
const ANCHOR_GAP = 4;

export function ContextMenu({
  x,
  y,
  items,
  heading,
  anchor,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  /** A question or label over the set. A menu of alternatives ("which engine?") needs one; a menu
   * of actions on the thing you right-clicked does not. */
  heading?: string;
  /**
   * The rect of the button this menu belongs to, when it has one.
   *
   * Without it the menu is placed at `x`/`y` and merely *clamped* to the window, which is right for
   * a right-click — the pointer is a point, and a menu that cannot fit below it should slide up.
   * It is wrong for a button: clamping a menu opened from a control near the bottom of the window
   * lays it over that control and everything around it, which is what it did over the canvas's own
   * View button and the status bar beneath it.
   *
   * Given a rect, the menu behaves like a dropdown instead: below the trigger by preference, above
   * it when there is not room below, and never over it.
   */
  anchor?: { top: number; bottom: number; left: number; right: number; align?: "start" | "end" };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // The item count is in the deps because a menu can be *replaced* in place: a two-entry menu whose
  // item opens a six-entry one keeps the same x and y, so measuring only on those would leave the
  // taller list clamped to the shorter one's fit — hanging off the bottom of the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    // The horizontal edge the menu grows from. `end` hangs it off the trigger's right edge, which is
    // what a control in a right-hand corner needs — growing rightwards from there only to be clamped
    // back leaves the menu at a position that has nothing to do with the button.
    const wantLeft = anchor
      ? anchor.align === "end"
        ? anchor.right - rect.width
        : anchor.left
      : x;

    let wantTop: number;
    if (anchor) {
      const below = anchor.bottom + ANCHOR_GAP;
      const above = anchor.top - rect.height - ANCHOR_GAP;
      // Below unless it would not fit; then above. Never overlapping the trigger.
      wantTop = below + rect.height + 4 <= window.innerHeight ? below : Math.max(4, above);
    } else {
      wantTop = y;
    }

    setPos({
      left: Math.max(4, Math.min(wantLeft, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(wantTop, window.innerHeight - rect.height - 4)),
    });
  }, [
    x,
    y,
    items.length,
    heading,
    anchor?.top,
    anchor?.bottom,
    anchor?.left,
    anchor?.right,
    anchor?.align,
  ]);

  // The press and Escape go through the shared hook — this menu is the one every tree in the app
  // opens, the diagrams explorer included, so it is the single place that decides whether a press
  // on a canvas dismisses a right-click menu. There is no trigger ref to pass: a context menu has
  // no button to re-open it from, so the panel is the whole of "inside".
  useDismissOnOutside(true, onClose, [ref]);

  useEffect(() => {
    window.addEventListener("resize", onClose);
    // Capture phase: the scroll that matters happens inside the sidebar, not on the window, and
    // a menu left floating over rows that have moved on points at the wrong node.
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      // # The press stops here
      //
      // A portal moves the DOM node to `document.body`; it does **not** move the event. React
      // dispatches through the *component* tree, so a press on a menu row is still delivered to
      // whatever rendered `<ContextMenu>` — and if that is a gesture surface, the surface handles a
      // press it never received. On `DbmlCanvas` that meant `setPointerCapture` on the frame, and a
      // captured pointer retargets the following `pointerup` *and the `click`* to the capturing
      // element: the row's own `onClick` never ran, so every entry in the schema canvas's menu did
      // nothing at all (verified in WKWebView, the engine Tauri renders in). It also cleared the
      // selection under the menu and armed a pan, so drifting a pixel while choosing slid the
      // diagram.
      //
      // Stopping here rather than in that one canvas, because any surface with pointer handlers can
      // reintroduce it and there are forty-odd menus in this app. Dismissal is unaffected:
      // `useDismissOnOutside` listens natively in the capture phase on `document`, which runs
      // before React dispatches anything.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      // A right-click inside an open menu should close it, not open a second one over the first.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      className="z-[9999] min-w-[172px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
    >
      {heading && (
        <p className="px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {heading}
        </p>
      )}
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {item.separated && i > 0 && <div className="my-1 h-px bg-[var(--cf-border)]" />}
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
            className={`flex w-full items-start gap-2 rounded px-2 py-1 text-left text-[12px] leading-snug disabled:opacity-50 ${
              item.disabled ? "cursor-default" : "hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]"
            } ${item.danger ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"}`}
          >
            {item.leading ??
              (item.icon && (
                <item.icon
                  size={13}
                  className={`mt-[2px] shrink-0 opacity-70 ${item.disabled ? "animate-spin" : ""}`}
                />
              ))}
            {/* Wraps. See the header: a menu entry you can only half-read is one you have
                to click to identify. */}
            <span className="min-w-0 flex-1 break-words">{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

