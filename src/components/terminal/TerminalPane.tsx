import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resizeTerminal, writeTerminal } from "../../lib/tauri/commands";
import { onTerminalExit, onTerminalOutput } from "../../lib/tauri/events";
import { useThemeStore } from "../../state/themeStore";
import { TypedLineBuffer } from "../../lib/remote/typedLines";
import { isMac } from "../../lib/platform";
import { pushErrorToast } from "../../state/toastStore";

const LIGHT_THEME = { background: "#ffffff", foreground: "#1c1c26", cursor: "#1c1c26" };
const DARK_THEME = { background: "#1e1e27", foreground: "#eceef5", cursor: "#eceef5" };

/**
 * Copy and paste, wired by hand.
 *
 * A terminal in a browser gets these for free; a terminal in a Tauri window does not. The webview
 * only routes ⌘C/⌘V to the page when the app carries a native Edit menu with those accelerators on
 * it, and this app has none — so the keystrokes reached nothing at all and the only way text left
 * this pane was the mouse. xterm's own paste handler never fires either, for the same reason: it
 * listens for a `paste` event the webview never dispatches.
 *
 * The bindings are the ones every terminal already uses, which is the whole point — ⌘C/⌘V on macOS,
 * `Ctrl+Shift+C`/`Ctrl+Shift+V` elsewhere. **Not** plain `Ctrl+C`: that is SIGINT, and a terminal
 * that copies instead of interrupting is a terminal you cannot stop a runaway command in. ⌘C with
 * nothing selected is passed through rather than swallowed, so it stays whatever the shell makes
 * of it.
 *
 * Paste writes to the pty directly instead of going through xterm, because the pty is where typed
 * input goes: `term.paste()` would echo locally and hand the shell a line it never saw typed.
 */
function clipboardKeys(term: Terminal, sessionId: string) {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || event.altKey) return true;
    const combo = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
    if (!combo) return true;

    const key = event.key.toLowerCase();
    if (key === "c") {
      const selection = term.getSelection();
      if (!selection) return true;
      void navigator.clipboard.writeText(selection).catch((e: unknown) => pushErrorToast(String(e)));
      event.preventDefault();
      return false;
    }
    if (key === "v") {
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) return writeTerminal(sessionId, text);
        })
        .catch((e: unknown) => pushErrorToast(String(e)));
      event.preventDefault();
      return false;
    }
    return true;
  });
}

/** One xterm.js instance attached to an *already-open* backend pty session (creation/closing
 * is owned by `terminalStore`, not this component) — it mounts once for the lifetime of that
 * session and is only ever hidden via CSS (`visible=false`) while a different pane/project is
 * shown, never unmounted, so scrollback and the shell process both survive switching away. */
export function TerminalPane({
  sessionId,
  visible,
  onCommand,
}: {
  sessionId: string;
  visible: boolean;
  /**
   * Called with each whole line the user typed and submitted, for the panes that keep a history.
   *
   * Opt-in, and only ever a *copy* of what already went to the pty — the write below is unchanged
   * whether or not anyone is listening, so a local shell behaves exactly as it always did.
   */
  onCommand?: (line: string) => void;
}) {
  const resolved = useThemeStore((s) => s.resolved);
  const containerRef = useRef<HTMLDivElement>(null);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
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
    clipboardKeys(term, sessionId);

    const lines = new TypedLineBuffer();
    const dataDisposable = term.onData((data) => {
      void writeTerminal(sessionId, data);
      // After the write, never instead of it: reconstructing the line must not be able to swallow
      // a keystroke. `onCommandRef` rather than the prop, so a parent that re-renders with a new
      // closure doesn't require tearing down the terminal to pick it up.
      const line = lines.push(data);
      if (line) onCommandRef.current?.(line);
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
