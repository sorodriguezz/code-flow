/**
 * The borders a floating window is resized by.
 *
 * The window has no frame of the system's, so nothing of the system's to be resized by: what macOS
 * leaves a frameless window is a hairline at its edge, under a page that puts its own pointer over
 * it — the pointer flickered between the two and the border was hard to catch. These are the
 * borders instead: a strip along each side and a square at each corner, wide enough to land on,
 * each with the pointer that says which way it goes.
 *
 * A press on one hands the drag to the window itself — `float_resize` on macOS, where the system
 * has no «start resizing» to ask for, and the platform's own everywhere else. While it lasts the
 * whole window keeps that pointer and what is under it is not hovered or selected.
 */
import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "../../../lib/platform";
import { floatResize } from "../../../lib/tauri/windows";

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** How far in from the window's edge a side is caught, and how large a corner is. */
const SIDE = 6;
const CORNER = 16;

const HANDLES: { edge: Edge; cursor: string; direction: "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest"; place: CSSProperties }[] = [
  { edge: "n", cursor: "ns-resize", direction: "North", place: { top: 0, left: CORNER, right: CORNER, height: SIDE } },
  { edge: "s", cursor: "ns-resize", direction: "South", place: { bottom: 0, left: CORNER, right: CORNER, height: SIDE } },
  { edge: "w", cursor: "ew-resize", direction: "West", place: { left: 0, top: CORNER, bottom: CORNER, width: SIDE } },
  { edge: "e", cursor: "ew-resize", direction: "East", place: { right: 0, top: CORNER, bottom: CORNER, width: SIDE } },
  { edge: "nw", cursor: "nwse-resize", direction: "NorthWest", place: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { edge: "se", cursor: "nwse-resize", direction: "SouthEast", place: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
  { edge: "ne", cursor: "nesw-resize", direction: "NorthEast", place: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { edge: "sw", cursor: "nesw-resize", direction: "SouthWest", place: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
];

/** Over everything the window draws, dialogs and menus included: its border is always its border. */
const ABOVE = 2147483000;

export function ResizeHandles() {
  /** The pointer of the border being carried, while it is. */
  const [carrying, setCarrying] = useState<string | null>(null);

  useEffect(() => {
    if (!carrying) return;
    const done = () => setCarrying(null);
    // A move with no button down is a release this page did not see (it ended outside the window).
    const moved = (event: MouseEvent) => {
      if (event.buttons === 0) done();
    };
    window.addEventListener("mouseup", done, true);
    window.addEventListener("mousemove", moved, true);
    window.addEventListener("blur", done);
    return () => {
      window.removeEventListener("mouseup", done, true);
      window.removeEventListener("mousemove", moved, true);
      window.removeEventListener("blur", done);
    };
  }, [carrying]);

  const press = (event: ReactMouseEvent, handle: (typeof HANDLES)[number]) => {
    if (event.button !== 0) return;
    // Nothing under the border is selected or dragged by this press.
    event.preventDefault();
    event.stopPropagation();
    if (isMac()) {
      setCarrying(handle.cursor);
      void floatResize(handle.edge).catch(() => setCarrying(null));
    } else {
      void getCurrentWindow().startResizeDragging(handle.direction).catch(() => {});
    }
  };

  return (
    <>
      {HANDLES.map((handle) => (
        <div
          key={handle.edge}
          aria-hidden
          data-resize-edge={handle.edge}
          onMouseDown={(event) => press(event, handle)}
          style={{ position: "fixed", zIndex: ABOVE, cursor: handle.cursor, ...handle.place }}
        />
      ))}
      {carrying && <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: ABOVE + 1, cursor: carrying }} />}
    </>
  );
}
