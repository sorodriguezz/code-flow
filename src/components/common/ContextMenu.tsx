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
import { ChevronRight, Loader2, type LucideIcon } from "lucide-react";
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
  /**
   * A nested menu, opened by hovering this entry.
   *
   * For one verb with many objects — "Move to project", and then which one. Flattening that into
   * `Move to project: A`, `Move to project: B`, … was the shape this menu had before, and it reads
   * as several different actions while repeating the only word that matters in every row; a folder
   * list of any length then buries the verbs under and over it.
   *
   * An item with `children` is a *destination, not an action*: its own `onClick` is never called,
   * so give it one that does nothing. There is deliberately no second level — a submenu inside a
   * submenu is a corridor, and nothing in this app has that shape.
   */
  children?: MenuItem[];
}

/** A floating menu at a point, portalled so no scroll container can clip it. Positioned after
 * mount because its size is only known once it's rendered — the clamp is what keeps a menu opened
 * near the bottom of the window from hanging off the edge. */
/** How far a button-anchored menu sits from its trigger. */
const ANCHOR_GAP = 4;

/** A panel's own padding plus its border — what a child has to be lifted by to line its first row
 *  up with something outside. Both are set on the panel class below; change them together. */
const PANEL_INSET = 5;

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
  /** Which entry's nested menu is open, by index. One at a time: opening a second closes the
   *  first, because two lists hanging off one menu is not a thing the eye can read. */
  const [submenu, setSubmenu] = useState<number | null>(null);
  /**
   * The nested list's own node, held here so the dismiss hook below can be told it counts as
   * *inside* this menu.
   *
   * It is a separate portal — it has to be, or a list longer than the menu would be clipped by it —
   * and a portal moves the node to `document.body`, so without this a press on a submenu row is a
   * press outside the parent. The parent closes on `pointerdown`, the submenu unmounts with it, and
   * the `click` that was about to run the entry never reaches anything. Every destination in the
   * list would silently do nothing, which is the same shape of bug this file's note on canvases
   * describes and just as invisible from the outside.
   */
  const subRef = useRef<HTMLDivElement>(null);
  /** The row the open submenu belongs to. The list lines up with *it*, not with the top of the
   *  menu — see `Submenu`. Attached only to the open one, so there is never a stale node here. */
  const subItemRef = useRef<HTMLButtonElement>(null);

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
  useDismissOnOutside(true, onClose, [ref, subRef]);

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
      className="z-[9999] min-w-[172px] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-[5px] shadow-[var(--cf-shadow)]"
    >
      {heading && (
        <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
          {heading}
        </p>
      )}
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {item.separated && i > 0 && <div className="my-1 h-px bg-[var(--cf-border)]" />}
          <button
            ref={item.children && submenu === i ? subItemRef : undefined}
            role="menuitem"
            disabled={item.disabled}
            aria-haspopup={item.children ? "menu" : undefined}
            aria-expanded={item.children ? submenu === i : undefined}
            // Hover opens it and hovering anything else closes it, which is how a menu bar behaves
            // everywhere — and it means the pointer never has to click twice to see a list. Click
            // opens it too, for the press that arrives before the hover has registered.
            onMouseEnter={() => setSubmenu(item.children ? i : null)}
            onFocus={() => setSubmenu(item.children ? i : null)}
            onClick={() => {
              if (item.children) {
                setSubmenu(i);
                return;
              }
              onClose();
              item.onClick();
            }}
            className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-[6px] text-left text-[13px] leading-snug disabled:opacity-50 ${
              item.disabled ? "cursor-default" : "hover:bg-[var(--cf-hover)]"
            } ${item.danger ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"} ${
              submenu === i ? "bg-[var(--cf-hover)]" : ""
            }`}
          >
            {item.leading ??
              (item.icon && (
                // Only the loading glyph turns. Spinning every disabled icon made a menu's
                // unavailable entries (a revert blocked by local changes) look like work in progress.
                <item.icon
                  size={15}
                  className={`mt-[1px] shrink-0 opacity-70 ${item.icon === Loader2 ? "animate-spin" : ""}`}
                />
              ))}
            {/* Wraps. See the header: a menu entry you can only half-read is one you have
                to click to identify. */}
            <span className="min-w-0 flex-1 break-words">{item.label}</span>
            {item.children && (
              <ChevronRight size={13} className="mt-[2px] shrink-0 opacity-60" />
            )}
          </button>
          {item.children && submenu === i && (
            <Submenu items={item.children} parent={ref} row={subItemRef} boxRef={subRef} onPick={onClose} />
          )}
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

/**
 * The nested list a `children` entry opens.
 *
 * # Why it is its own portal rather than an absolutely-positioned child
 *
 * The parent menu is already a portal with `overflow` of its own and a `z-index` that the app's
 * other floating layers sit around. A child positioned inside it would be clipped by the parent's
 * padding box the moment the list is taller than the menu — which, for a project list, is the
 * ordinary case rather than the edge one.
 *
 * # Placement
 *
 * To the right of the parent by preference, flipping to its left when the window has no room —
 * a menu opened near the right edge would otherwise slide back over the words it belongs to. The
 * vertical start is the parent's own top, clamped so a long list never hangs off the bottom.
 *
 * Measured after mount and hidden until then, the same trick `ColorSwatchPicker` uses: the size is
 * only knowable once the list has rendered, and a frame at the wrong place is a visible jump.
 */
function Submenu({
  items,
  parent,
  row,
  boxRef,
  onPick,
}: {
  items: MenuItem[];
  parent: React.RefObject<HTMLDivElement | null>;
  /** The entry this list hangs off, which is what it lines up with vertically. */
  row: React.RefObject<HTMLButtonElement | null>;
  /** Owned by the parent, which needs the node to count a press here as inside itself. */
  boxRef: React.RefObject<HTMLDivElement | null>;
  /** Closes the whole stack. A submenu entry is still an action on the thing that was clicked, so
   *  choosing one dismisses the parent too rather than leaving it standing over the result. */
  onPick: () => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const menu = parent.current;
    const entry = row.current;
    if (!box || !menu) return;
    const host = menu.getBoundingClientRect();
    const { width, height } = box.getBoundingClientRect();

    // Sideways off the *menu*, because that is the edge the list must clear.
    const right = host.right + 2;
    const left = right + width + 4 <= window.innerWidth ? right : host.left - width - 2;

    // Vertically off the *row*, because that is what the list belongs to. Anchoring it to the top
    // of the menu — which is what this did first — puts a list that opens from the fourth entry up
    // beside the first one, pointing at a line it has nothing to do with.
    //
    // `PANEL_INSET` backs out the panel's own padding and border so the submenu's first entry sits
    // on the same line as the row that opened it, rather than one step below it.
    const top = (entry ? entry.getBoundingClientRect().top : host.top) - PANEL_INSET;
    setPos({
      left: Math.max(4, left),
      top: Math.max(4, Math.min(top, window.innerHeight - height - 4)),
    });
  }, [parent, row, boxRef, items.length]);

  return createPortal(
    <div
      ref={boxRef}
      role="menu"
      // The same guards the parent carries, and for the same reason — see its note on the press.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        position: "fixed",
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-[10000] max-h-[60vh] min-w-[160px] overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-[5px] shadow-[var(--cf-shadow)]"
    >
      {items.length === 0 ? (
        // A verb with nothing to apply it to still has to say so: an empty box that opens and
        // shows nothing reads as a bug rather than as an answer.
        <p className="px-2.5 py-1.5 text-[13px] text-[var(--cf-text-muted)]">—</p>
      ) : (
        items.map((item, i) => (
          <button
            key={`${item.label}-${i}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onPick();
              item.onClick();
            }}
            className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-[6px] text-left text-[13px] leading-snug disabled:opacity-50 ${
              item.disabled ? "cursor-default" : "hover:bg-[var(--cf-hover)]"
            } ${item.danger ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"}`}
          >
            {item.leading ??
              (item.icon && <item.icon size={15} className="mt-[1px] shrink-0 opacity-70" />)}
            <span className="min-w-0 flex-1 break-words">{item.label}</span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
