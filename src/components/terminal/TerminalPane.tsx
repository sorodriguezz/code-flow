import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Check, ClipboardPaste, Copy, X } from "lucide-react";
import { resizeTerminal, writeTerminal } from "../../lib/tauri/commands";
import { registerTerminalSink } from "../../state/terminalStore";
import { useThemeStore } from "../../state/themeStore";
import { TypedLineBuffer } from "../../lib/remote/typedLines";
import { isMac } from "../../lib/platform";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { ContextMenu } from "../api/CollectionTree";

/**
 * The selection wash, spelled out rather than left to xterm.
 *
 * xterm does ship a default, and it is the reason this looked *almost* right: a flat white at 30%
 * over `#1e1e27`. Against a terminal whose whole point is coloured text it reads as a smear rather
 * than as a highlight, and on the light theme the same rule washes out to near-nothing. Worse,
 * `selectionInactiveBackground` defaults dimmer still, and this pane loses focus constantly — the
 * dock's own tab strip takes it, so does the editor — which is how "I selected something and see
 * nothing" happens even where the active colour would have shown.
 *
 * Stated as the app's accent so a selection here looks like a selection everywhere else, and given
 * the same value active and inactive: what is selected does not stop being selected because you
 * looked at something else. No `selectionForeground`, deliberately — pinning one would flatten the
 * ANSI colours underneath, and the colours are the information.
 */
const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1c1c26",
  cursor: "#1c1c26",
  selectionBackground: "#3b82f659",
  selectionInactiveBackground: "#3b82f659",
};
const DARK_THEME = {
  background: "#1e1e27",
  foreground: "#eceef5",
  cursor: "#eceef5",
  selectionBackground: "#60a5fa66",
  selectionInactiveBackground: "#60a5fa66",
};

/**
 * How far back you can scroll in one terminal. Stated rather than inherited: it used to be
 * whatever xterm's default happened to be (1000), which is a per-instance cost multiplied by
 * every terminal ever opened, since none of them is ever unmounted. Same number as before on
 * purpose — the memory lever worth pulling is the *number* of retained terminals, not how much
 * of each one's history the user is allowed to scroll back to.
 */
const SCROLLBACK_LINES = 1000;

/** How long the "Copied" badge sits in the corner of the pane. Long enough to be read out of the
 *  corner of the eye while dragging a second selection, short enough never to be in the way. */
const COPIED_BADGE_MS = 1200;

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
 * The two actions themselves live on the component, because the right-click menu and copy-on-select
 * are the same two actions reached another way — one implementation, so a copy from the keyboard
 * flashes the same badge as a copy from the mouse.
 */
function clipboardKeys(term: Terminal, actions: { copy: () => boolean; paste: () => void }) {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || event.altKey) return true;
    const combo = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
    if (!combo) return true;

    const key = event.key.toLowerCase();
    if (key === "c") {
      // `copy` reports whether there was anything to copy, so an empty ⌘C stays the shell's.
      if (!actions.copy()) return true;
      event.preventDefault();
      return false;
    }
    if (key === "v") {
      actions.paste();
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
  onClose,
  closeLabel,
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
  /**
   * What the right-click menu's close entry does, and whether it is there at all.
   *
   * Left to the parent because "close this terminal" means something different in each of the three
   * places a pane is mounted — a tab in the repository dock, one tile of an agent bench, a session
   * tab in the Remote workspace — and none of that is this component's business. A pane with no
   * `onClose` simply gets a menu of copy and paste.
   */
  onClose?: () => void;
  /** Overrides the close entry's wording, for a surface where closing is not what it is called —
   *  the bench, where removing a tile deletes the terminal rather than putting it away. */
  closeLabel?: string;
}) {
  const t = useT();
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
  /** Which mode the xterm instance is actually painted in, so a pane can tell whether it slept
   *  through a theme change. Seeded by the construction effect below. */
  const themedAs = useRef<"light" | "dark" | null>(null);

  /** Whether the "Copied" badge is showing. */
  const [copied, setCopied] = useState(false);
  /** The open right-click menu and where it goes. `hasSelection` is sampled when the menu opens
   *  rather than read during render, because it lives in xterm, not in React. */
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const badgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Flashes the badge.
   *
   * Restarted rather than queued: copying twice in a row is one badge that stays a moment longer,
   * not two overlapping ones. Cleared on unmount by the construction effect's teardown, so a pane
   * closed inside the window cannot call `setCopied` on a gone component.
   */
  const flashCopied = useCallback(() => {
    setCopied(true);
    if (badgeTimer.current) clearTimeout(badgeTimer.current);
    badgeTimer.current = setTimeout(() => setCopied(false), COPIED_BADGE_MS);
  }, []);

  /**
   * The pane's one copy. Returns whether there was a selection to take — the keyboard handler needs
   * to know, so that ⌘C over nothing stays SIGINT's business rather than being swallowed.
   *
   * Stable across renders (it reads the terminal through a ref), which is what lets the construction
   * effect hand it to xterm once and keep depending on `sessionId` alone.
   */
  const copySelection = useCallback((): boolean => {
    const term = termRef.current;
    const selection = term?.getSelection();
    if (!selection) return false;
    void navigator.clipboard
      .writeText(selection)
      .then(() => {
        flashCopied();
        // **The highlight is cleared once it is on the clipboard**, which is what makes the wash
        // above readable as an event rather than as state. Copy-on-select means a selection is
        // consumed the instant it is finished, so leaving it lit would put a permanent blue block
        // over the output for the rest of the session — you would be looking at where you dragged
        // an hour ago. Clearing it also disambiguates the badge: the flash says "taken", and the
        // highlight going away is the same sentence said twice.
        //
        // Inside `then`, not before it: a clipboard write that fails must leave the selection
        // standing, or the text would be gone from the screen *and* absent from the clipboard.
        term?.clearSelection();
      })
      .catch((e: unknown) => pushErrorToast(String(e)));
    return true;
  }, [flashCopied]);

  /** Paste writes to the pty directly instead of going through xterm, because the pty is where typed
   *  input goes: `term.paste()` would echo locally and hand the shell a line it never saw typed. */
  const pasteClipboard = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) return writeTerminal(sessionId, text);
      })
      .catch((e: unknown) => pushErrorToast(String(e)));
  }, [sessionId]);

  // The menu is portalled to `document.body`, and a pane is hidden with a class rather than
  // unmounted — so a pane that goes away with its menu open would leave the menu floating over
  // whatever took its place, pointing at a terminal that is no longer on screen.
  useEffect(() => {
    if (!visible) setMenu(null);
  }, [visible]);

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
      // xterm defaults this to `true` on macOS, and that default is wrong for a pane whose
      // right-click opens a Copy menu: selecting a paragraph and then right-clicking it would
      // throw the paragraph away and select the one word under the pointer, so Copy would hand
      // back something the user never highlighted. Off, right-click leaves the selection alone
      // and the menu acts on what is on screen.
      rightClickSelectsWord: false,
    });
    themedAs.current = resolved;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fitAddon;
    clipboardKeys(term, { copy: copySelection, paste: pasteClipboard });

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

    /**
     * Copy on select, the way every terminal emulator on a Unix desktop does it: let go of the drag
     * and what you highlighted is on the clipboard.
     *
     * **Bound to mouse-up rather than to xterm's `onSelectionChange`.** That event fires on every
     * cell the pointer crosses, so a drag across ten lines would be a hundred clipboard writes and a
     * hundred badge flashes for one selection. Mouse-up is the moment a selection is finished, and
     * it is also the moment a double-click (word) and a triple-click (line) have made theirs.
     *
     * The pair is deliberately split across two targets. `mousedown` is on the container, in the
     * **capture** phase — so a drag has to have started inside *this* pane, and xterm's own handlers
     * cannot stop it from reaching us. `mouseup` has to be on the document, because a drag that runs
     * off the bottom of a short pane ends over whatever is underneath it, and that selection counts
     * too — but it is attached only for the duration of a drag rather than for the life of the pane.
     * Every terminal ever opened stays mounted, and a dozen hidden panes holding a permanent
     * document listener each is the shape of cost this file spends the rest of its effects avoiding.
     * Re-adding the same function is a no-op, so a mousedown with no mouseup cannot stack them up.
     *
     * The read is deferred by a tick rather than taken inline: xterm finishes the selection in its
     * own `mouseup` listener, and this must not race it. A plain click therefore reads an empty
     * selection and copies nothing — clicking to place focus never touches the clipboard.
     */
    const box = containerRef.current;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      document.removeEventListener("mouseup", onMouseUp, true);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => copySelection(), 0);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 0) document.addEventListener("mouseup", onMouseUp, true);
    };
    box.addEventListener("mousedown", onMouseDown, true);

    return () => {
      cancelAnimationFrame(fitFrame);
      box.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      if (settleTimer) clearTimeout(settleTimer);
      if (badgeTimer.current) clearTimeout(badgeTimer.current);
      dataDisposable.dispose();
      unregister();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /**
   * Repaints the terminal in the mode on screen — for the pane on screen, and nobody else.
   *
   * Same reasoning as the `cursorBlink` and WebGL effects below, and the same reason it mattered
   * here: no pane is ever unmounted, so a dozen terminals from tabs nobody is looking at were all
   * assigned a new `options.theme` on every light/dark flip. That is not a cheap assignment —
   * xterm rebuilds its colour set and refreshes every row of the buffer, and under the WebGL
   * renderer it throws away the glyph atlas too. All of it ran synchronously inside the theme
   * wipe's `flushSync`, so a long-lived session's worth of hidden terminals was paid for as a
   * freeze before the animation could start, to repaint panes at `display: none`.
   *
   * Keyed on `visible` as well, so a pane that slept through a flip is corrected the moment it is
   * shown — before its first frame, since this runs on the same commit that reveals it. `themedAs`
   * is what makes that safe to defer: it records the mode xterm is actually wearing, so waking is
   * a no-op for a pane that happens to already be right (two flips back to where it started).
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term || !visible || themedAs.current === resolved) return;
    term.options.theme = resolved === "dark" ? DARK_THEME : LIGHT_THEME;
    themedAs.current = resolved;
  }, [resolved, visible]);

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

  return (
    // The wrapper is exactly the box the container used to be, so nothing about xterm's geometry
    // changes — it exists to be the badge's positioning parent, and to keep the badge out of the
    // node xterm owns the children of.
    <div
      className="relative h-full w-full"
      onContextMenu={(event) => {
        // Claims the right-click before `contextMenuGuard`'s document listener sees it, which is
        // what stops the webview's own Reload/Back menu from appearing over a terminal.
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: termRef.current?.hasSelection() ?? false,
        });
      }}
    >
      <div ref={containerRef} className="h-full w-full overflow-hidden p-2" />

      {/* Bottom-right, where terminal output isn't: a shell's cursor sits at the *start* of the
          last line, so the corner opposite it is the one square of the pane a badge can occupy
          without covering what was just copied. Inert to the mouse, so it can never eat a click
          landing on the terminal underneath it. */}
      {copied && (
        <div className="cf-fade-in pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] shadow-[var(--cf-shadow)]">
          <Check size={11} className="text-[var(--cf-success)]" />
          {t("terminal.copied")}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            // Shown greyed rather than hidden when there is nothing selected: the menu keeps the
            // same shape and the same entry in the same place whichever way you opened it.
            //
            // `leading` rather than `icon` because `ContextMenu` spins a disabled item's icon — it
            // reads `disabled` as "in flight", which is what it means where that came from. Here it
            // means "nothing to copy", and a copy glyph turning in circles would say the opposite.
            {
              label: t("terminal.copy"),
              leading: <Copy size={13} className="shrink-0 opacity-70" />,
              disabled: !menu.hasSelection,
              onClick: () => copySelection(),
            },
            { label: t("terminal.paste"), icon: ClipboardPaste, onClick: pasteClipboard },
            ...(onClose
              ? [{ label: closeLabel ?? t("terminal.close"), icon: X, danger: true, separated: true, onClick: onClose }]
              : []),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
