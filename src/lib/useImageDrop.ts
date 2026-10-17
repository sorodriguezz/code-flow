import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { currentPlatform } from "./platform";

/** What the assistant's chats attach: images, by the extensions the backend calls images. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/**
 * The element under a native drag-drop point. Tauri types the point as physical pixels, but only
 * Windows sends those (WebView2 maps the screen point with ScreenToClient); WKWebView and
 * WebKitGTK send the window's own points, which are already CSS pixels. Dividing those by the
 * Retina ratio aimed at half the distance, so a drop never landed where it was let go.
 */
export function elementAtDropPoint(x: number, y: number): Element | null {
  const ratio = currentPlatform() === "windows" ? window.devicePixelRatio || 1 : 1;
  return document.elementFromPoint(x / ratio, y / ratio);
}

/**
 * Files dragged from the desktop onto `target` — the images among them, handed to `onDrop`. A
 * surface that takes any file (the Chat app, whose attach button has no filter) widens `accept`.
 *
 * Tauri's own drag-drop event, not the DOM's: the webview's native handler takes file drops before
 * the page sees them (the tree and the API importer listen the same way). Every listener hears
 * every drop, so this one only answers for a point inside `target`, and `elementFromPoint` only
 * finds what is drawn — a kept-alive hidden chat never claims a drop meant for the one on screen.
 *
 * Returns whether a drag is over the target now, for the ring.
 */
export function useImageDrop(
  target: RefObject<HTMLElement | null>,
  onDrop: (paths: string[]) => void,
  accept: (path: string) => boolean = isImagePath,
): boolean {
  const [over, setOver] = useState(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const inside = (x: number, y: number) => {
      const el = elementAtDropPoint(x, y);
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
          const images = hit ? payload.paths.filter((path) => acceptRef.current(path)) : [];
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
