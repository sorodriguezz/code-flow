import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resizeTerminal, writeTerminal } from "../../lib/tauri/commands";
import { onTerminalExit, onTerminalOutput } from "../../lib/tauri/events";
import { useThemeStore } from "../../state/themeStore";

const LIGHT_THEME = { background: "#ffffff", foreground: "#1c1c26", cursor: "#1c1c26" };
const DARK_THEME = { background: "#1e1e27", foreground: "#eceef5", cursor: "#eceef5" };

/** One xterm.js instance attached to an *already-open* backend pty session (creation/closing
 * is owned by `terminalStore`, not this component) — it mounts once for the lifetime of that
 * session and is only ever hidden via CSS (`visible=false`) while a different pane/project is
 * shown, never unmounted, so scrollback and the shell process both survive switching away. */
export function TerminalPane({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const resolved = useThemeStore((s) => s.resolved);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      theme: resolved === "dark" ? DARK_THEME : LIGHT_THEME,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    const dataDisposable = term.onData((data) => {
      void writeTerminal(sessionId, data);
    });

    (async () => {
      unlistenOutput = await onTerminalOutput((e) => {
        if (e.id === sessionId) term.write(e.data);
      });
      unlistenExit = await onTerminalExit((e) => {
        if (e.id === sessionId) term.write("\r\n[process exited]\r\n");
      });
      void resizeTerminal(sessionId, term.cols, term.rows);
    })();

    return () => {
      dataDisposable.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolved === "dark" ? DARK_THEME : LIGHT_THEME;
  }, [resolved]);

  const refit = () => {
    if (!visible) return;
    fitRef.current?.fit();
    const term = termRef.current;
    if (term) void resizeTerminal(sessionId, term.cols, term.rows);
  };

  // Panes hidden via CSS report zero size, so xterm needs an explicit refit right when it
  // reappears — plus a live ResizeObserver for dock-height drags / split-ratio changes while
  // actually visible.
  useEffect(() => {
    refit();
    if (!containerRef.current) return;
    const observer = new ResizeObserver(refit);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden p-2" />;
}
