import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** What the assistant's chats attach: images, by the extensions the backend calls images. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/**
 * Files dragged from the desktop onto `target` — the images among them, handed to `onDrop`.
 *
 * Tauri's own drag-drop event, not the DOM's: the webview's native handler takes file drops before
 * the page sees them (the tree and the API importer listen the same way). Every listener hears
 * every drop, so this one only answers for a point inside `target`, and `elementFromPoint` only
 * finds what is drawn — a kept-alive hidden chat never claims a drop meant for the one on screen.
 *
 * Returns whether a drag is over the target now, for the ring.
 */
export function useImageDrop(target: RefObject<HTMLElement | null>, onDrop: (paths: string[]) => void): boolean {
  const [over, setOver] = useState(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    /** Positions come in physical pixels — the platform's, not the page's. */
    const inside = (x: number, y: number) => {
      const ratio = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / ratio, y / ratio);
      return !!el && !!target.current?.contains(el);
    };
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "leave") {
            setOver(false);
            return;
          }
          const hit = inside(payload.position.x, payload.position.y);
          if (payload.type !== "drop") {
            setOver(hit);
            return;
          }
          setOver(false);
          const images = hit ? payload.paths.filter(isImagePath) : [];
          if (images.length > 0) onDropRef.current(images);
        })
        .then(
          (fn) => {
            if (disposed) fn();
            else unlisten = fn;
          },
          () => {},
        );
    } catch {
      // Outside the app's webview (tests, a browser probe): there is nothing to listen to.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [target]);

  return over;
}
