/**
 * Types for `@novnc/novnc`, which ships none.
 *
 * Deliberately narrow: only what `VncCanvas` actually touches. A fuller transcription of noVNC's
 * API would be a second copy of their documentation to keep in step with, and every field here that
 * nothing calls is a field that could be wrong without anything noticing.
 *
 * The package's `exports` is the string `"./core/rfb.js"` — sugar for a single `"."` entry — so the
 * bare specifier is the only importable path. `@novnc/novnc/core/rfb` does *not* resolve.
 */
declare module "@novnc/novnc" {
  interface RFBOptions {
    credentials?: { username?: string; password?: string; target?: string };
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  /**
   * One RFB connection, attached to a container element.
   *
   * Constructing it connects; `disconnect()` is the only teardown, and it is not optional — the
   * instance holds a WebSocket and document-level input listeners.
   */
  export default class RFB extends EventTarget {
    /**
     * `urlOrChannel` is noVNC's own name for it: given a string it opens its own WebSocket, given
     * an open one it attaches to it (`rfb.js`: `typeof urlOrChannel === "string"`). `VncCanvas`
     * passes the socket, because the close code and reason are the only place a bridge failure is
     * legible and noVNC's `disconnect` event does not carry them.
     */
    constructor(target: Element, urlOrChannel: string | WebSocket, options?: RFBOptions);

    /** Scale the framebuffer to the container instead of scrolling it. */
    scaleViewport: boolean;
    /** Ask the *server* to resize its desktop to the container. Off here — it changes the far
     *  machine's screen, not ours. */
    resizeSession: boolean;
    /** Stop sending input while still drawing. */
    viewOnly: boolean;
    /** Draw a dot where the pointer is when the server's own cursor is absent or fully
     *  transparent. Off in noVNC, which leaves the canvas with `cursor: none` and nothing in its
     *  place — see `VncCanvas`. */
    showDotCursor: boolean;

    disconnect(): void;
    /** Supplies credentials after a `credentialsrequired` event. */
    sendCredentials(credentials: RFBOptions["credentials"]): void;
    sendCtrlAltDel(): void;
  }
}
