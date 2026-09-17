import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, MonitorOff } from "lucide-react";
import RFB from "@novnc/novnc";
import { useT } from "../../state/languageStore";
import { vncCredentials, vncMissingCredential } from "../../lib/remote/vncAuth";

/**
 * The far machine's screen, drawn in a tab.
 *
 * `@novnc/novnc` speaks RFB over a WebSocket, which is the only socket a webview has — so the
 * stream arrives through the loopback bridge in `remotes::wsbridge`, whose other end is a plain TCP
 * connection to (usually) the local end of this host's SSH forward. Nothing is exposed to any
 * network: the chain is canvas → loopback → `ssh -L` → the far host's own `127.0.0.1:5900`.
 *
 * **The instance is created once and torn down by hand.** noVNC attaches keyboard and mouse
 * listeners to the document while focused and holds a WebSocket; letting React re-create it on a
 * re-render would leak both. So it lives in a ref, keyed only on the URL.
 *
 * **Credentials are read at construction and never again**, which is why the panel above waits for
 * the keychain before mounting this: noVNC looks in the bag once, when the handshake reaches
 * authentication, and a bag filled in a tick later would arrive to nobody. See `lib/remote/vncAuth`
 * for why a Mac needs a username in it.
 */

/**
 * How long the RFB handshake may stall before the panel says so.
 *
 * Not defensive padding. noVNC runs Apple's Diffie-Hellman in an `async` method nothing awaits or
 * catches (`_negotiateARDAuthAsync`), so anything that throws in there — a webview without
 * `crypto.subtle`, a key length it cannot handle — ends the handshake with no `disconnect` and no
 * `securityfailure` to listen for. The spinner would then be permanent, which is the only outcome
 * worse than an error message.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

export function VncCanvas({
  url,
  username,
  password,
  viewOnly,
  onDisconnect,
}: {
  url: string;
  /** The account that logs into the screen. Required by macOS, which authenticates a real account
   *  over Apple DH, and ignored by a server that offers nothing but VNC auth. */
  username: string;
  /** VNC's own password, which is not the SSH one. Empty when the server doesn't ask. */
  password: string;
  viewOnly: boolean;
  onDisconnect: (clean: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "failed" | "ended">("connecting");
  const [detail, setDetail] = useState("");
  const t = useT();

  // Refs, so changing the callback or the credentials doesn't tear the connection down and rebuild
  // it mid-session — the effect below depends on the URL alone, deliberately.
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;
  const credentialsRef = useRef({ username, password });
  credentialsRef.current = { username, password };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setState("connecting");
    setDetail("");

    const credentials = vncCredentials(
      credentialsRef.current.username,
      credentialsRef.current.password,
    );
    const rfb = new RFB(container, url, { credentials });
    // The canvas scales to the pane instead of the pane scrolling a full-size framebuffer, which
    // is what makes a 1920×1080 desktop usable in a tab beside a terminal.
    rfb.scaleViewport = true;
    // Off: this would ask the far host to resize *its* desktop to match this pane. On a server
    // someone else is also looking at, that is a change to their screen, not ours.
    rfb.resizeSession = false;
    // On, and macOS is why. noVNC asks for the `cursor` pseudo-encoding, so the pointer is *not*
    // painted into the framebuffer: it arrives as a shape noVNC draws as the canvas's CSS cursor,
    // and the canvas is set to `cursor: none` meanwhile. Apple's server assumes its client draws
    // its own pointer and sends a fully transparent shape — so the local cursor is hidden, nothing
    // replaces it, and the mouse simply disappears over the screen. This is noVNC's own answer to
    // that: a dot, shown only while the server's cursor has no visible pixel, so a real arrow or
    // I-beam still comes through the moment the far side sends one.
    rfb.showDotCursor = true;
    rfbRef.current = rfb;

    /**
     * Whether a reason has already been reported.
     *
     * The handlers below end the connection, and ending it makes noVNC fire `disconnect` — marked
     * *clean*, because we asked for it. Without this flag that event overwrites the reason with the
     * state meant for a connection nobody diagnosed, and a screen that asked for a password ends up
     * looking exactly like a screen still trying to connect. Which is what it did.
     */
    let settled = false;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const settle = (next: "failed" | "ended", reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      setState(next);
      setDetail(reason);
    };

    stall = setTimeout(() => {
      settle("failed", t("remote.vncStalled"));
      rfb.disconnect();
    }, HANDSHAKE_TIMEOUT_MS);

    const onConnect = () => {
      clearTimeout(stall);
      setState("connected");
    };
    const onDisconnected = (e: CustomEvent<{ clean: boolean }>) => {
      const clean = e.detail?.clean ?? false;
      settle(clean ? "ended" : "failed", clean ? t("remote.vncEnded") : t("remote.vncDropped"));
      onDisconnectRef.current(clean);
    };
    const onCredentials = (e: CustomEvent<{ types?: string[] }>) => {
      // The server wants something no host setting had. Reported rather than prompted for: a prompt
      // here would be a second place credentials get typed, and the host's own settings is where
      // the app already keeps them. Which field, though, has to be the one actually left blank —
      // macOS asks for a username and a password every time, whatever it was given.
      const missing = vncMissingCredential(e.detail?.types, credentials);
      settle(
        "failed",
        missing === "username" ? t("remote.vncNeedsUser") : t("remote.vncNeedsPassword"),
      );
      rfb.disconnect();
    };
    const onSecurityFailure = (e: CustomEvent<{ reason?: string }>) => {
      settle("failed", e.detail?.reason || t("remote.vncRejected"));
    };

    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnected as EventListener);
    rfb.addEventListener("credentialsrequired", onCredentials as EventListener);
    rfb.addEventListener("securityfailure", onSecurityFailure as EventListener);

    return () => {
      clearTimeout(stall);
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnected as EventListener);
      rfb.removeEventListener("credentialsrequired", onCredentials as EventListener);
      rfb.removeEventListener("securityfailure", onSecurityFailure as EventListener);
      // Closes the socket and releases the document-level input listeners. Without it a closed tab
      // keeps swallowing keystrokes meant for the terminal.
      rfb.disconnect();
      rfbRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Toggled live rather than through a reconnect: it is a property of this viewer, not of the
  // session, and dropping the connection to stop sending clicks would be absurd.
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  return (
    <div className="relative h-full w-full bg-black">
      <div ref={containerRef} className="h-full w-full" />

      {state !== "connected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--cf-bg)]/90 p-6 text-center">
          {state === "connecting" ? (
            <>
              <Loader2 size={20} className="animate-spin text-[var(--cf-text-muted)]" />
              <p className="text-[12px] text-[var(--cf-text-muted)]">{t("remote.vncConnecting")}</p>
            </>
          ) : (
            <>
              {/* A session that ended is not a session that failed: the same panel without the
                  alarm, because nothing went wrong and reconnecting is one button away. */}
              {state === "ended" ? (
                <MonitorOff size={22} className="text-[var(--cf-text-muted)]" />
              ) : (
                <AlertTriangle size={22} className="text-[var(--cf-danger)]" />
              )}
              <p className="text-sm font-medium text-[var(--cf-text)]">
                {state === "ended" ? t("remote.vncClosed") : t("remote.vncFailed")}
              </p>
              {detail && (
                <p className="max-w-md text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
                  {detail}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
