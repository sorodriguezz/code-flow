import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import RFB from "@novnc/novnc";
import { useT } from "../../state/languageStore";

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
 */
export function VncCanvas({
  url,
  password,
  viewOnly,
  onDisconnect,
}: {
  url: string;
  /** VNC's own password, which is not the SSH one. Empty when the server doesn't ask. */
  password: string;
  viewOnly: boolean;
  onDisconnect: (clean: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "failed">("connecting");
  const [detail, setDetail] = useState("");
  const t = useT();

  // Refs, so changing the callback or the password doesn't tear the connection down and rebuild it
  // mid-session — the effect below depends on the URL alone, deliberately.
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setState("connecting");
    setDetail("");

    const rfb = new RFB(container, url, { credentials: { password } });
    // The canvas scales to the pane instead of the pane scrolling a full-size framebuffer, which
    // is what makes a 1920×1080 desktop usable in a tab beside a terminal.
    rfb.scaleViewport = true;
    // Off: this would ask the far host to resize *its* desktop to match this pane. On a server
    // someone else is also looking at, that is a change to their screen, not ours.
    rfb.resizeSession = false;
    rfbRef.current = rfb;

    const onConnect = () => setState("connected");
    const onDisconnected = (e: CustomEvent<{ clean: boolean }>) => {
      const clean = e.detail?.clean ?? false;
      setState(clean ? "connecting" : "failed");
      if (!clean) setDetail(t("remote.vncDropped"));
      onDisconnectRef.current(clean);
    };
    const onCredentials = () => {
      // The server wants a password and none was saved. Reported rather than prompted for: a
      // prompt here would be a second place credentials get typed, and the host's own settings is
      // where the app already keeps one.
      setState("failed");
      setDetail(t("remote.vncNeedsPassword"));
      rfb.disconnect();
    };
    const onSecurityFailure = (e: CustomEvent<{ reason?: string }>) => {
      setState("failed");
      setDetail(e.detail?.reason || t("remote.vncRejected"));
    };

    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnected as EventListener);
    rfb.addEventListener("credentialsrequired", onCredentials);
    rfb.addEventListener("securityfailure", onSecurityFailure as EventListener);

    return () => {
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnected as EventListener);
      rfb.removeEventListener("credentialsrequired", onCredentials);
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
              <AlertTriangle size={22} className="text-[var(--cf-danger)]" />
              <p className="text-sm font-medium text-[var(--cf-text)]">{t("remote.vncFailed")}</p>
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
