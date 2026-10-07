import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { TerminalPane } from "../terminal/TerminalPane";
import { closeTerminal } from "../../lib/tauri/commands";
import { onTerminalExit } from "../../lib/tauri/events";
import { containersOpenSession, type SessionRequest } from "../../lib/tauri/containersCommands";
import { useT } from "../../state/languageStore";

/**
 * A container's logs, or a shell in it, in an xterm pane — a terminal session the engine's own
 * `logs -f` / `exec -it` runs in (see `src-tauri/src/containers/session.rs`).
 *
 * Opened when first shown and closed when unmounted or when what it shows changes (`requestKey`).
 * A session that ends — `logs -f` stops with its container, a shell exits — leaves its output on
 * screen and offers to reconnect; `autoReconnect` does it by itself when the caller says the
 * container is back (`liveToken` changes).
 *
 * A pull, a build or a Compose command is not shown here: those run to their end as the manager's
 * jobs (`containersJobsStore`), which outlive any pane.
 */
export function SessionPane({
  request,
  visible,
  liveToken,
  textRef,
}: {
  request: SessionRequest;
  visible: boolean;
  /** Changes when the thing behind the session restarts — a reconnect follows. */
  liveToken?: string;
  /** A reader of what the pane shows, as text — for the log's copy, save and «Analizar con IA». */
  textRef?: { current: (() => string) | null };
}) {
  const t = useT();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [generation, setGeneration] = useState(0);
  const requestKey = JSON.stringify(request);
  const current = useRef<string | null>(null);
  // Exits heard while the open call had not answered yet: a command that fails at once can end
  // before its id reaches this pane, which would otherwise never offer to reconnect.
  const early = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setExited(false);
    setSessionId(null);
    containersOpenSession(JSON.parse(requestKey) as SessionRequest)
      .then((id) => {
        if (cancelled) {
          void closeTerminal(id).catch(() => {});
          return;
        }
        current.current = id;
        setSessionId(id);
        const ended = early.current.has(id);
        early.current.clear();
        if (ended) setExited(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
      const id = current.current;
      current.current = null;
      if (id) void closeTerminal(id).catch(() => {});
    };
  }, [requestKey, generation]);

  useEffect(() => {
    const off = onTerminalExit((event) => {
      if (event.id === current.current) setExited(true);
      else if (current.current === null) early.current.add(event.id);
    });
    return () => {
      void off.then((unlisten) => unlisten());
    };
  }, []);

  // The container came back: follow it again.
  const lastToken = useRef(liveToken);
  useEffect(() => {
    if (liveToken === lastToken.current) return;
    lastToken.current = liveToken;
    if (exited) setGeneration((g) => g + 1);
  }, [liveToken, exited]);

  return (
    <div className={visible ? "relative flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
      {error ? (
        <div className="flex flex-1 items-start gap-2 p-3 text-[12px] text-[var(--cf-danger)]">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
          <button onClick={() => setGeneration((g) => g + 1)} className="flex shrink-0 items-center gap-1 text-[var(--cf-accent)] hover:underline">
            <RotateCw size={11} />
            {t("containers.reconnect")}
          </button>
        </div>
      ) : sessionId ? (
        <>
          <TerminalPane key={sessionId} sessionId={sessionId} visible={visible} textRef={textRef} />
          {exited && (
            <button
              onClick={() => setGeneration((g) => g + 1)}
              className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2 py-1 text-[11px] text-[var(--cf-text)] shadow-sm hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <RotateCw size={11} />
              {t("containers.reconnect")}
            </button>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[var(--cf-text-muted)]">
          <Loader2 size={14} className="animate-spin" />
        </div>
      )}
    </div>
  );
}
