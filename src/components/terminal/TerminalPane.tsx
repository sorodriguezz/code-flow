import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { resizeTerminal, writeTerminal } from "../../lib/tauri/commands";
import { registerTerminalSink } from "../../state/terminalStore";
import { useThemeStore } from "../../state/themeStore";
import { TypedLineBuffer } from "../../lib/remote/typedLines";
import { isMac } from "../../lib/platform";
import { pushErrorToast } from "../../state/toastStore";

const LIGHT_THEME = { background: "#ffffff", foreground: "#1c1c26", cursor: "#1c1c26" };
const DARK_THEME = { background: "#1e1e27", foreground: "#eceef5", cursor: "#eceef5" };

/**
 * How far back you can scroll in one terminal. Stated rather than inherited: it used to be
 * whatever xterm's default happened to be (1000), which is a per-instance cost multiplied by
 * every terminal ever opened, since none of them is ever unmounted. Same number as before on
 * purpose — the memory lever worth pulling is the *number* of retained terminals, not how much
 * of each one's history the user is allowed to scroll back to.
 */
const SCROLLBACK_LINES = 1000;

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

/** One xterm.js instance attached to an *already-open* backend pty session (creation/closing is
 * owned by `terminalStore`, which also owns the app's single `terminal:output` listener — this
 * pane registers a writer with it rather than subscribing itself) — it mounts once for the
 * lifetime of that session and is only ever hidden via CSS (`visible=false`) while a different
 * pane/project is shown, never unmounted, so scrollback and the shell process both survive
 * switching away. */
export function TerminalPane({
  sessionId,
  visible,
  replay,
  onCommand,
}: {
  sessionId: string;
  visible: boolean;
  /**
   * Output to write into the terminal before it is wired to the pty — the agent console's bench
   * replaying what this terminal printed in an earlier run of the app.
   *
   * Written raw, escape sequences and all, because that is what it is: a verbatim copy of the
   * bytes the shell sent, so colour, cursor moves and progress bars redraw exactly as they did.
   *
   * Read once, at mount. It is history, and history does not update — a prop that changed later
   * would replay a second copy over a live session. Which is also why it is *not* in the effect's
   * dependency list: the terminal is rebuilt when `sessionId` changes and at no other time.
   */
  replay?: string;
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
  // Captured at first render and never updated, so a parent re-rendering with a longer transcript
  // (the store reloaded, say) cannot make this pane replay it again over a live shell.
  const replayRef = useRef(replay);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Read by the terminal-construction effect, which deliberately does not depend on `visible` —
  // a visibility change must not tear down a live shell.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      theme: resolved === "dark" ? DARK_THEME : LIGHT_THEME,
      // Only the pane on screen blinks — see the effect below for why that matters when a dozen
      // hidden terminals are still mounted.
      cursorBlink: visibleRef.current,
      scrollback: SCROLLBACK_LINES,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fitAddon;
    clipboardKeys(term, sessionId);

    // Before `onData` is wired and before the output listener is attached, so the replay can never
    // interleave with what the live shell is saying — the whole of the past, then the present.
    // Verbatim: the separator marking where an earlier process ended is already inside the
    // transcript, put there by whoever resumed it, so this stays a dumb write.
    if (replayRef.current) term.write(replayRef.current);

    const lines = new TypedLineBuffer();
    const dataDisposable = term.onData((data) => {
      void writeTerminal(sessionId, data);
      // After the write, never instead of it: reconstructing the line must not be able to swallow
      // a keystroke. `onCommandRef` rather than the prop, so a parent that re-renders with a new
      // closure doesn't require tearing down the terminal to pick it up.
      const line = lines.push(data);
      if (line) onCommandRef.current?.(line);
    });

    // Synchronous, and no longer a per-pane `terminal:output` subscription: the store owns one
    // listener for the whole app and hands each chunk straight to the session that asked for it.
    // Registering also flushes, in order, whatever the shell printed between being spawned and
    // this — its first pane — mounting; that used to fall in the gap before `await listen(...)`
    // resolved.
    const unregister = registerTerminalSink(sessionId, {
      write: (data) => term.write(data),
      exit: () => term.write("\r\n[process exited]\r\n"),
    });

    // Measured here, not captured earlier. This used to send `term.cols/rows` read from the
    // synchronous `fit()` above — and that fit ran while the dock was still at the `height: 0`
    // its open animation starts from, so it produced **one row** and told the shell so. The
    // `ResizeObserver` then corrected xterm as the dock grew, but this call landed *later* and
    // re-told the PTY the stale geometry. bash drew its prompt for a terminal one row shorter
    // than the one on screen, which is why the last line sat half under the status bar and why
    // making the dock shrinkable did not finish the job: the misalignment was never in the
    // layout, it was in what the shell had been told about it.
    //
    // The deferral used to come for free from awaiting two `listen()` calls; with the listeners
    // gone it is spelled out. A frame is the right amount of later — it is the first moment the
    // container can have been laid out at a non-zero height.
    const fitFrame = requestAnimationFrame(() => fitAndReport(term, fitAddon));

    return () => {
      cancelAnimationFrame(fitFrame);
      dataDisposable.dispose();
      unregister();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolved === "dark" ? DARK_THEME : LIGHT_THEME;
  }, [resolved]);

  /**
   * The cursor blinks in the pane you are looking at, and only there.
   *
   * xterm drives the blink off a timer that schedules a render, and that timer pauses on
   * `document.visibilityState` but knows nothing about `display: none`. Since no pane is ever
   * unmounted, every terminal the user has ever opened was asking for a render twice a second
   * forever, from behind a `hidden` class, on top of whatever the visible one was doing.
   *
   * The visible pane is unchanged: it blinks exactly as before, and switching back to a pane
   * restarts its blink on the spot.
   */
  useEffect(() => {
    if (termRef.current) termRef.current.options.cursorBlink = visible;
  }, [visible]);

  /**
   * GPU rendering, with the DOM renderer as the safety net — and only for the pane on screen.
   *
   * xterm's default renderer builds a `<div>` per visible row and a `<span>` per style run and
   * re-lays that text out on every output frame. In a webview that text is not GPU-accelerated,
   * so a chatty command (a build log, `npm install`) turned into a layout storm that stuttered
   * the whole window, not just this pane. WebGL draws the same glyphs off a texture atlas.
   *
   * It is visually identical *here* specifically because the themes above are opaque hex with
   * no alpha and `allowTransparency` is off — WebGL's known divergences are transparency and
   * custom glyph rendering, and this pane uses neither.
   *
   * **Keyed on `visible`, not on `sessionId`.** The addon used to be built beside the terminal and
   * disposed with it, which is to say never: no pane is ever unmounted, so every terminal the user
   * had ever opened held a live WebGL context, a 1024×1024-per-page glyph atlas and a canvas
   * backing store of its own — the last of which is the pane's CSS size × devicePixelRatio² × 4
   * bytes, so on a Retina panel a single hidden pane was megabytes of pixels nothing could draw.
   * The dock mounts a pane per tab of *every* project, so those multiply. The terminal itself,
   * its buffer and its scrollback are untouched by this and stay exactly as they were; only the
   * renderer comes and goes, and a pane brought back gets a new one before its first frame.
   *
   * Building it only while visible has a second benefit the old placement could not have: the
   * container is guaranteed to have a real box, where a pane constructed behind a `hidden` class
   * built its GL canvas at 0×0.
   *
   * `onContextLoss` is not paranoia: a browser only keeps a handful of live WebGL contexts, and
   * disposing the addon hands that pane back to the DOM renderer — exactly what it used to be —
   * rather than leaving it blank.
   *
   * Declared after the construction effect (so `termRef.current` is set — effects in one commit run
   * in declaration order) and before the refit below (so `fitAndReport` runs with the renderer
   * already in place).
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term || !visible) return;
    let webgl: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
      webgl = addon;
    } catch {
      // No WebGL in this webview, or `loadAddon` refused it. Nothing to do: not having the addon
      // *is* the DOM renderer. Disposed rather than dropped, in case it was `loadAddon` that threw
      // after the addon had already taken a context.
      webgl?.dispose();
      return;
    }
    return () => webgl?.dispose();
  }, [visible, sessionId]);

  /**
   * Fits xterm to its box and tells the PTY — but only once the box has one.
   *
   * The guard is the point. `FitAddon` divides the available height by the cell height and floors
   * it, so a container measuring zero yields `rows: 1`; a terminal that reports one row to the
   * shell gets a prompt drawn for one row, and every redraw after that is offset. A dock opening
   * from `height: 0`, a pane behind a `hidden` class and a window being restored all pass through
   * exactly that state, and none of them is a moment worth measuring.
   */
  const fitAndReport = (term: Terminal, fitAddon: FitAddon) => {
    const box = containerRef.current;
    if (!box || box.clientHeight < 1 || box.clientWidth < 1) return;
    fitAddon.fit();
    void resizeTerminal(sessionId, term.cols, term.rows);
  };

  const refit = () => {
    if (!visible) return;
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (term && fitAddon) fitAndReport(term, fitAddon);
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
