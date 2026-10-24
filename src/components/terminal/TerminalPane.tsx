import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { homeDir } from "@tauri-apps/api/path";
import "@xterm/xterm/css/xterm.css";
import {
  Check,
  ClipboardPaste,
  Copy,
  Eraser,
  FileDown,
  FolderPlus,
  RotateCcw,
  Search,
  SquareArrowOutUpRight,
  TextSelect,
  TriangleAlert,
  X,
} from "lucide-react";
import { resizeTerminal, terminalPathKinds, writeTerminal } from "../../lib/tauri/commands";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { readClipboardText, writeClipboardText } from "../../lib/clipboard";
import { edgeMoving, whenEdgeSettles } from "../../lib/useEdgeSlide";
import { elementAtDropPoint } from "../../lib/useImageDrop";
import { definitionProject, openDefinitionTarget } from "../../lib/goToDefinition";
import { relativeInside } from "../../lib/folderPath";
import { registerTerminalSink } from "../../state/terminalStore";
import { DEFAULT_FONT_FAMILY, ensureTerminalPrefsLoaded, useTerminalPrefsStore, type TerminalPrefs } from "../../state/terminalPrefsStore";
import { notify } from "../../state/notificationStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushSuccessToast } from "../../state/toastStore";
import { AiSparkles } from "../common/AiGlyph";
import { findFileRefs, quotePath, resolveRef } from "./fileLinks";
import { installShellIntegration, type FinishedCommand, type ShellIntegration } from "./shellIntegration";
import { formatDuration } from "./shellMarks";
import { useThemeStore } from "../../state/themeStore";
import { useGlassStore } from "../../state/glassStore";
import { findTheme } from "../../lib/codeThemes";
import { terminalTheme } from "../../lib/terminalTheme";
import { TypedLineBuffer } from "../../lib/remote/typedLines";
import { currentPlatform, isMac } from "../../lib/platform";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { ContextMenu } from "../common/ContextMenu";
import { TerminalSearch } from "./TerminalSearch";
import { bufferText } from "./bufferText";
import { KEPT_LINES } from "../../state/terminalRestore";
import { useSaving } from "../../state/powerSaveStore";

/** Shorter than one row and there is nothing meaningful to fit to — see `fitAndReport`. */
const MIN_FIT_PX = 8;

/**
 * How many times a pane will try to get a WebGL context back before settling for the DOM renderer.
 *
 * A lost context is usually transient — a GPU process restart, a driver reset, waking from sleep —
 * and the DOM renderer is many times slower, so giving up on the first loss is expensive. But a
 * webview that will never grant one (software rendering, a driver blocklist) must not be asked
 * forever, hence a budget rather than a loop.
 */
const WEBGL_RETRIES = 3;
/** Multiplied by the attempt number: a context lost mid-restart cannot be reacquired in the same
 * frame, so asking immediately only burns the budget. */
const WEBGL_RETRY_MS = 400;

/** Where a file reference's look-ups are cached, so hovering the same build log again asks nothing. */
const pathKindCache = new Map<string, number>();
let home: string | null = null;
void homeDir()
  .then((dir) => (home = dir))
  .catch(() => {});

/**
 * A ⌘-clicked file reference: a file of the repository on screen opens in the editor at its line; a
 * file anywhere else opens in the program the system has for it; a folder opens in the file manager.
 */
function openFileRef(path: string, isDir: boolean, line?: number, column?: number): void {
  const fail = (e: unknown) => pushErrorToast(String(e));
  if (isDir) {
    void openPath(path).catch(fail);
    return;
  }
  const project = definitionProject();
  const rel = project ? relativeInside(project.local_path, path) : null;
  if (!rel) {
    // Shown in the file manager, never opened: opening a `.sh` or an `.exe` would run it.
    void revealItemInDir(path).catch(fail);
    return;
  }
  useUiStore.getState().setActiveView("editor");
  // The editor may only now be mounting; give it two frames to register before falling back.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      // Revealed rather than opened: opening a `.sh` or an `.exe` would run it.
      if (!openDefinitionTarget(rel, line ?? 1, column)) void revealItemInDir(path).catch(fail);
    }),
  );
}

/** The xterm options a preference sets — applied at construction and whenever it changes. */
function prefOptions(prefs: TerminalPrefs) {
  return {
    fontFamily: prefs.fontFamily.trim() || DEFAULT_FONT_FAMILY,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    cursorStyle: prefs.cursorStyle,
    scrollback: prefs.scrollback,
  } as const;
}

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
 *
 * **Plain `Ctrl+V` pastes too, on Windows only** — the chord Windows Terminal, conhost and VS Code
 * all paste on, so it is the one a Windows user presses; unhandled, xterm sent it to the shell as
 * `^V`, which read as "paste does nothing" (reported from the CLI sign-in dialog, where the code has
 * to be pasted). Linux keeps `Ctrl+V` for the shell, as its terminals do.
 *
 * **Find is here too** — ⌘F on macOS, `Ctrl+F` elsewhere, VS Code's chords for its terminal — because
 * xterm takes one custom key handler per terminal, and a second one would replace this one.
 */
function clipboardKeys(
  term: Terminal,
  actions: {
    copy: () => boolean;
    paste: () => void;
    find: () => void;
    clear: () => void;
    zoom: (step: 1 | -1 | 0) => void;
    /** Answers whether there were command marks to move between. */
    jump: (direction: -1 | 1) => boolean;
  },
) {
  const windows = currentPlatform() === "windows";
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || event.altKey) return true;
    const findChord = isMac()
      ? event.metaKey && !event.ctrlKey && !event.shiftKey
      : event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (findChord && event.key.toLowerCase() === "f") {
      actions.find();
      event.preventDefault();
      return false;
    }
    // ⌘K clears, as in Terminal.app, iTerm and VS Code — macOS only: elsewhere Ctrl+K is the line
    // editor's "kill to end of line", which a terminal must leave alone. The menu clears everywhere.
    if (isMac() && findChord && event.key.toLowerCase() === "k") {
      actions.clear();
      event.preventDefault();
      return false;
    }
    // ⌘+ / ⌘- / ⌘0 size every terminal's font (Ctrl elsewhere). Claimed with `preventDefault`, so the
    // app's own ⌘0 (the vault) does not also fire — the global handler skips a prevented event.
    const zoomChord = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (zoomChord && (event.key === "=" || event.key === "+" || event.key === "-" || event.key === "0")) {
      actions.zoom(event.key === "-" ? -1 : event.key === "0" ? 0 : 1);
      event.preventDefault();
      return false;
    }
    // ⌘↑ / ⌘↓ (Ctrl elsewhere) move between commands — only when the shell marks them; otherwise
    // the keys stay the shell's.
    if (findChord && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      if (!actions.jump(event.key === "ArrowUp" ? -1 : 1)) return true;
      event.preventDefault();
      return false;
    }
    if (windows && event.ctrlKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === "v") {
      actions.paste();
      event.preventDefault();
      return false;
    }
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
  backlog,
  readOnly = false,
  quietExit = false,
  onCommand,
  onClose,
  closeLabel,
  autoFocus = false,
  textRef,
  dock,
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
   * History kept somewhere else, fetched when the pane mounts — a service's console, whose output
   * the supervisor records from the first byte whether or not a pane was open to see it.
   *
   * The pane attaches to the live session *first* and holds what arrives, then writes the history,
   * then releases what it held — skipping every live chunk numbered at or below `seq`, which the
   * history already contains. That order is the whole trick: attaching after the fetch would lose
   * whatever the process printed during the round trip, and not numbering the chunks would print
   * the overlap twice.
   *
   * Read once, at mount, like `replay`.
   */
  backlog?: () => Promise<{ text: string; seq: number }>;
  /**
   * A pane showing what a process *printed*, with no process behind it any more — a stopped
   * service's last run. Nothing typed goes anywhere, nothing is resized, no live output is routed
   * to it, and the cursor is hidden so the pane does not look like it is waiting for input.
   */
  readOnly?: boolean;
  /** Leaves out the `[process exited]` line. For a pane whose owner says so better elsewhere — a
   *  service's console, whose header already reads "exited with code 1". */
  quietExit?: boolean;
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
  /** Takes the keyboard as soon as the terminal exists — for a dialog whose only job is this
   *  shell, like signing an AI account in. Read once, at mount. */
  autoFocus?: boolean;
  /**
   * Given a reader of everything the pane holds — scrollback and screen, as plain text (see
   * `bufferText`) — while the terminal exists, and `null` once it is gone. For an owner that offers to
   * copy, save or analyse the whole of it: a container's log, where what is on screen is the answer.
   */
  textRef?: { current: (() => string) | null };
  /**
   * What only a pane in the repository dock has: a folder to resolve file links against and open
   * "here" in, a restart, a way to the assistant, typing into a whole split, and somewhere to report
   * the folder the shell moved to and a long command that finished. The bench, the Remote workspace
   * and a service's console mount the pane without it and keep the plain menu.
   */
  dock?: {
    /** The folder the shell started in — file links resolve against it until the shell says where
     *  it is now. */
    cwd: string;
    title: string;
    projectId: string;
    onCwd: (cwd: string) => void;
    onRestart: () => void;
    onNewHere: (cwd: string) => void;
    onAskAi: (text: string) => void;
    /**
     * The agent whose worktree this shell is standing in, by the folder it is in *now* — `null`
     * when it is not in one. Asked as the menu opens rather than held as a prop: the shell moves
     * (`OSC 7`), and a label naming the task the pane was opened in would go on naming it three
     * `cd`s later.
     */
    agentHere?: (cwd: string) => { id: string; title: string } | null;
    /** Sends a command and its output to that agent as its next turn. */
    onSendToAgent?: (taskId: string, body: { command: string | null; exit: number | null; output: string }) => void;
    /** The other sessions typing should reach too — empty unless the split broadcasts. Read on
     *  every keystroke, so it is a function rather than a prop that would rebuild the terminal. */
    broadcastTo: () => string[];
  };
}) {
  const t = useT();
  // The scheme on screen, so a shell wears the same colours as the editor — and, in a see-through
  // window, the same glass (`terminalTheme`).
  const scheme = useThemeStore((s) => findTheme(s.resolved === "dark" ? s.darkThemeId : s.lightThemeId, s.resolved));
  const glass = useGlassStore((s) => s.enabled);
  const noGpu = useSaving(3);
  const containerRef = useRef<HTMLDivElement>(null);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  // Captured at first render and never updated, so a parent re-rendering with a longer transcript
  // (the store reloaded, say) cannot make this pane replay it again over a live shell.
  const replayRef = useRef(replay);
  const backlogRef = useRef(backlog);
  const readOnlyRef = useRef(readOnly);
  const quietExitRef = useRef(quietExit);
  const autoFocusRef = useRef(autoFocus);
  const textRefRef = useRef(textRef);
  textRefRef.current = textRef;
  const dockRef = useRef(dock);
  dockRef.current = dock;
  /** The folder the shell last said it is in, for links and "new terminal here". */
  const cwdRef = useRef<string | null>(null);
  const shellRef = useRef<ShellIntegration | null>(null);
  const exitedRef = useRef(false);
  const prefs = useTerminalPrefsStore((s) => s.prefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** Which preferences xterm is wearing, like `themedAs` for the scheme. */
  const prefsAs = useRef<string | null>(null);
  /** Whether a drag from the explorer or the desktop is over this pane, for the ring. */
  const [dropOver, setDropOver] = useState(false);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** The size the pty was last told about, so an unchanged fit costs nothing. See `fitAndReport`. */
  const reportedRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  // Read by the terminal-construction effect, which deliberately does not depend on `visible` —
  // a visibility change must not tear down a live shell.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** Which scheme (and glass) the xterm instance is actually painted in, so a pane can tell whether it
   *  slept through a change. Seeded by the construction effect below. */
  const themedAs = useRef<string | null>(null);

  /** Whether the "Copied" badge is showing. */
  const [copied, setCopied] = useState(false);
  /** The last command the shell marked as finished — its line and its exit code. */
  const lastDoneRef = useRef<FinishedCommand | null>(null);
  /** The open right-click menu and where it goes. `hasSelection` is sampled when the menu opens
   *  rather than read during render, because it lives in xterm, not in React. */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    selection: string;
    /** The agent whose worktree this shell is in, sampled as the menu opens — see `dock.agentHere`. */
    agent: { id: string; title: string } | null;
    lastDone: FinishedCommand | null;
    /** What the last finished command printed — `null` for a shell that marks no commands. */
    lastOutput: string | null;
  } | null>(null);
  /**
   * Which renderer this pane ended up on. `null` until the attach below has run.
   *
   * Surfaced because the fallback used to be completely silent: a webview that refuses a WebGL
   * context drops the pane onto xterm's DOM renderer, which rebuilds a `<div>` per row and a
   * `<span>` per style run on every frame, and the only symptom is that the terminal feels slow.
   * Nothing said why, and nothing could be reported back. It is drawn only when it is `"dom"` —
   * the fast path is the expected one and does not deserve a badge.
   */
  const [renderer, setRenderer] = useState<"webgl" | "dom" | null>(null);
  const badgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The scrollback search, built with the terminal. */
  const searchRef = useRef<SearchAddon | null>(null);
  /** Whether the find box is open; `findFocus` is bumped by every ⌘F, to take the focus back to it. */
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const dark = useThemeStore((s) => s.resolved === "dark");
  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindFocus((n) => n + 1);
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    termRef.current?.focus();
  }, []);

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
    void writeClipboardText(selection)
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
    if (readOnlyRef.current) return;
    void readClipboardText()
      .then((text) => {
        if (text) return writeTerminal(sessionId, text);
      })
      .catch((e: unknown) => pushErrorToast(String(e)));
  }, [sessionId]);

  /**
   * A command that ran at least the configured while and finished where nobody was looking — the
   * pane hidden, the window in the background — is worth a notification. Dock panes only: a bench
   * tile or a service's console has its own way of saying it stopped.
   */
  const notifyIfUnwatched = useCallback((done: { command: string | null; exit: number | null; ms: number }) => {
    const owner = dockRef.current;
    const prefs = prefsRef.current;
    if (!owner || !prefs.notifyLong || done.ms < prefs.notifyAfterSec * 1000) return;
    if (visibleRef.current && !document.hidden && document.hasFocus()) return;
    const failed = done.exit !== null && done.exit !== 0;
    notify({
      source: "terminal",
      workspaceId: useWorkspaceStore.getState().workspaceOfProject(owner.projectId),
      target: { projectId: owner.projectId },
      titleKey: failed ? "notifications.terminalFailed" : "notifications.terminalDone",
      params: { name: owner.title, time: formatDuration(done.ms), code: done.exit ?? "?" },
      status: failed ? "error" : "success",
      detail: done.command ? (done.command.length > 120 ? `${done.command.slice(0, 120)}…` : done.command) : undefined,
    });
  }, []);

  /** Everything the pane holds, as text — what "Save output…" writes and the restore keeps. */
  const allText = useCallback(() => (termRef.current ? bufferText(termRef.current.buffer.active) : ""), []);

  const saveOutput = useCallback(async () => {
    const text = allText();
    if (!text.trim()) return;
    const name = `${(dockRef.current?.title || "terminal").replace(/[^\w.-]+/g, "-")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    try {
      const path = await apiSaveFile(name, text);
      if (path) pushSuccessToast(t("terminal.savedOutput", { path }));
    } catch (e) {
      pushErrorToast(String(e));
    }
  }, [allText, t]);

  const copyText = useCallback(
    (text: string) => {
      void writeClipboardText(text)
        .then(flashCopied)
        .catch((e: unknown) => pushErrorToast(String(e)));
    },
    [flashCopied],
  );

  /**
   * Paths dropped onto the pane — from the explorer or from the desktop — typed at the prompt,
   * quoted for the shell and separated by spaces, with no Enter: the user finishes the command.
   */
  const typePaths = useCallback(
    (paths: string[]) => {
      if (readOnlyRef.current || exitedRef.current || paths.length === 0) return;
      const windows = currentPlatform() === "windows";
      void writeTerminal(sessionId, `${paths.map((path) => quotePath(path, windows)).join(" ")} `);
      termRef.current?.focus();
    },
    [sessionId],
  );

  // The menu is portalled to `document.body`, and a pane is hidden with a class rather than
  // unmounted — so a pane that goes away with its menu open would leave the menu floating over
  // whatever took its place, pointing at a terminal that is no longer on screen.
  useEffect(() => {
    if (!visible) setMenu(null);
  }, [visible]);

  useEffect(() => {
    if (!containerRef.current) return;

    ensureTerminalPrefsLoaded();
    const term = new Terminal({
      // Font, size, line height, cursor and scrollback are the user's — Settings › Terminal. The
      // default font stack puts Cascadia first among the Windows faces, for the reason given at
      // `DEFAULT_FONT_FAMILY`.
      ...prefOptions(prefsRef.current),
      // An overview ruler beside the scrollbar, where the command marks show as ticks.
      overviewRuler: { width: 8 },
      theme: terminalTheme(scheme, glass),
      // Read by the WebGL renderer when it builds its glyph atlas: a cleared ground is only honoured
      // with it on. Kept off outside the glass, where the ground is solid and it would cost for nothing.
      allowTransparency: glass,
      /**
       * Tells xterm it is talking to a ConPTY, on Windows only.
       *
       * ConPTY does not behave like a unix pty: it re-emits whole regions of the screen buffer, and
       * it wraps lines by *writing* the wrap rather than letting the terminal decide. Without this
       * flag xterm treats those re-emissions as new output, which shows up as duplicated prompts
       * and lines that reflow wrongly the moment the pane is resized. `windowsPty` switches on the
       * heuristics xterm ships for exactly this, and is inert on every other platform — which is
       * why it is set from the platform rather than always.
       */
      ...(currentPlatform() === "windows"
        ? ({ windowsPty: { backend: "conpty" } } as const)
        : {}),
      // Only the pane on screen blinks — see the effect below for why that matters when a dozen
      // hidden terminals are still mounted.
      cursorBlink: visibleRef.current && prefsRef.current.cursorBlink,
      // xterm defaults this to `true` on macOS, and that default is wrong for a pane whose
      // right-click opens a Copy menu: selecting a paragraph and then right-clicking it would
      // throw the paragraph away and select the one word under the pointer, so Copy would hand
      // back something the user never highlighted. Off, right-click leaves the selection alone
      // and the menu acts on what is on screen.
      rightClickSelectsWord: false,
      disableStdin: readOnlyRef.current,
      // Search highlights every match through xterm's decoration API, which it still files under
      // "proposed" and refuses without this.
      allowProposedApi: true,
    });
    themedAs.current = `${scheme.id}:${glass}`;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const searchAddon = new SearchAddon({ highlightLimit: 2000 });
    term.loadAddon(searchAddon);
    searchRef.current = searchAddon;
    // A URL a command printed is a link: ⌘/Ctrl-click opens it in the browser. Only http(s) — the
    // addon's own pattern matches nothing else, and the check says so again where it matters, at
    // the moment something is about to be opened.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!/^https?:\/\//i.test(uri)) return;
        event.preventDefault();
        void openUrl(uri).catch((e: unknown) => pushErrorToast(String(e)));
      }),
    );
    // Unicode 11 widths: emoji and the wide East Asian characters take the two cells the shell
    // counted for them, so a prompt carrying one does not leave the cursor a column off.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // File references a command printed — `src/a.ts:12:3`, a stack frame, a Python traceback — are
    // links too, for the dock's panes: ⌘/Ctrl-click opens the file at that line. Each candidate is
    // looked up before it is drawn as a link (`terminalPathKinds`), so text that merely looks like a
    // path is never one.
    const linkDisposable = dockRef.current
      ? term.registerLinkProvider({
          provideLinks: (y, callback) => {
            const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
            const refs = findFileRefs(text).slice(0, 12);
            const base = cwdRef.current ?? dockRef.current?.cwd ?? "";
            if (refs.length === 0 || !base) return callback(undefined);
            const paths = refs.map((ref) => resolveRef(ref.path, base, home ?? ""));
            const unknown = paths.filter((path) => !pathKindCache.has(path));
            void (unknown.length ? terminalPathKinds(unknown) : Promise.resolve([] as number[]))
              .then((kinds) => {
                unknown.forEach((path, at) => pathKindCache.set(path, kinds[at] ?? 0));
                if (pathKindCache.size > 2000) pathKindCache.clear();
                const links = refs.flatMap((ref, at) => {
                  const kind = pathKindCache.get(paths[at]) ?? 0;
                  if (!kind) return [];
                  return [
                    {
                      range: { start: { x: ref.start + 1, y }, end: { x: ref.end, y } },
                      text: text.slice(ref.start, ref.end),
                      decorations: { pointerCursor: true, underline: true },
                      activate: (event: MouseEvent) => {
                        if (!(isMac() ? event.metaKey : event.ctrlKey)) return;
                        openFileRef(paths[at], kind === 2, ref.line, ref.column);
                      },
                    },
                  ];
                });
                callback(links.length ? links : undefined);
              })
              .catch(() => callback(undefined));
          },
        })
      : null;
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fitAddon;
    prefsAs.current = JSON.stringify(prefsRef.current);
    const textSink = textRefRef.current;
    // Only the end: the restore snapshot keeps `KEPT_LINES` of it.
    const readText = () => bufferText(term.buffer.active, KEPT_LINES);
    if (textSink) textSink.current = readText;
    if (autoFocusRef.current) term.focus();
    clipboardKeys(term, {
      copy: copySelection,
      paste: pasteClipboard,
      find: openFind,
      clear: () => term.clear(),
      zoom: (step) => useTerminalPrefsStore.getState().zoom(step),
      jump: (direction) => shellRef.current?.jump(direction) ?? false,
    });

    // The shell integration's marks: a coloured bar at each prompt, the folder the shell is in, and a
    // notification for a long command that finished out of sight. Installed on every pane — a shell
    // without the integration never prints a mark, and then this does nothing.
    shellRef.current = installShellIntegration(term, {
      onCwd: (cwd) => {
        cwdRef.current = cwd;
        dockRef.current?.onCwd(cwd);
      },
      onFinished: (done) => {
        // Kept for the menu: «send to the agent» states the command and its exit code, and both are
        // gone from the screen by the time anyone right-clicks.
        lastDoneRef.current = done;
        notifyIfUnwatched(done);
      },
      colors: () => {
        const styles = getComputedStyle(document.documentElement);
        return {
          ok: styles.getPropertyValue("--cf-success").trim() || "#3fb950",
          failed: styles.getPropertyValue("--cf-danger").trim() || "#f85149",
        };
      },
    });

    // Before `onData` is wired and before the output listener is attached, so the replay can never
    // interleave with what the live shell is saying — the whole of the past, then the present.
    // Verbatim: the separator marking where an earlier process ended is already inside the
    // transcript, put there by whoever resumed it, so this stays a dumb write.
    if (replayRef.current) term.write(replayRef.current);

    const lines = new TypedLineBuffer();
    const dataDisposable = term.onData((data) => {
      if (readOnlyRef.current) return;
      // A shell that has exited takes Enter as "start it again" — the line under `[process exited]`
      // says so. Anything else typed into a dead pane goes nowhere, as before.
      if (exitedRef.current) {
        if (data === "\r" && dockRef.current) {
          exitedRef.current = false;
          dockRef.current.onRestart();
        }
        return;
      }
      void writeTerminal(sessionId, data);
      // A split typing into all its panes: the same keystrokes, to each of the others.
      for (const other of dockRef.current?.broadcastTo() ?? []) {
        if (other !== sessionId) void writeTerminal(other, data).catch(() => {});
      }
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
    //
    // With a `backlog`, live chunks are held until the history is on screen and then released
    // minus the ones it already contains — see the prop.
    let disposed = false;
    let holding = !!backlogRef.current;
    let floor = 0;
    const held: Array<{ data: string; seq?: number }> = [];
    const deliver = (data: string, seq?: number) => {
      if (seq !== undefined && seq <= floor) return;
      term.write(data);
    };
    const unregister = readOnlyRef.current
      ? () => {}
      : registerTerminalSink(sessionId, {
          write: (data, seq) => {
            if (holding) held.push({ data, seq });
            else deliver(data, seq);
          },
          exit: () => {
            exitedRef.current = true;
            if (quietExitRef.current) return;
            const line = dockRef.current
              ? `\r\n[process exited] \x1b[2m${t("terminal.exitedRestartHint")}\x1b[0m\r\n`
              : "\r\n[process exited]\r\n";
            // Held like output, so an exit that lands mid-fetch is not printed above the history.
            if (holding) held.push({ data: line });
            else term.write(line);
          },
        });
    if (backlogRef.current) {
      void backlogRef
        .current()
        .then(({ text, seq }) => {
          if (disposed) return;
          floor = seq;
          if (text) term.write(text);
        })
        .catch(() => {})
        .finally(() => {
          if (disposed) return;
          holding = false;
          for (const chunk of held) deliver(chunk.data, chunk.seq);
          held.length = 0;
          // A record with nothing behind it: no cursor, or it reads as a prompt waiting for input.
          if (readOnlyRef.current) term.write("\x1b[?25l");
        });
    }

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
      disposed = true;
      cancelAnimationFrame(fitFrame);
      box.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      if (settleTimer) clearTimeout(settleTimer);
      if (badgeTimer.current) clearTimeout(badgeTimer.current);
      dataDisposable.dispose();
      linkDisposable?.dispose();
      shellRef.current?.dispose();
      shellRef.current = null;
      unregister();
      // Identity-checked, like the sink: a pane that replaced this one has already put its own reader.
      if (textSink && textSink.current === readText) textSink.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /**
   * Repaints the terminal in the scheme on screen — for the pane on screen, and nobody else.
   *
   * Same reasoning as the `cursorBlink` and WebGL effects below, and the same reason it mattered
   * here: no pane is ever unmounted, so a dozen terminals from tabs nobody is looking at were all
   * assigned a new `options.theme` on every light/dark flip. That is not a cheap assignment —
   * xterm rebuilds its colour set and refreshes every row of the buffer, and under the WebGL
   * renderer it throws away the glyph atlas too. All of it ran synchronously inside the theme
   * wipe's `flushSync`, so a long-lived session's worth of hidden terminals was paid for as a
   * freeze before the animation could start, to repaint panes at `display: none`.
   *
   * Keyed on `visible` as well, so a pane that slept through a change is corrected the moment it is
   * shown — before its first frame, since this runs on the same commit that reveals it. `themedAs`
   * is what makes that safe to defer: it records the scheme and glass xterm is actually wearing, so
   * waking is a no-op for a pane that happens to already be right (two flips back to where it
   * started). The glass also switches `allowTransparency`, which the WebGL effect below picks up by
   * building its renderer again — it runs after this one, on the same change.
   */
  useEffect(() => {
    const term = termRef.current;
    const wanted = `${scheme.id}:${glass}`;
    if (!term || !visible || themedAs.current === wanted) return;
    term.options.allowTransparency = glass;
    term.options.theme = terminalTheme(scheme, glass);
    themedAs.current = wanted;
  }, [scheme, glass, visible]);

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
    if (termRef.current) termRef.current.options.cursorBlink = visible && prefs.cursorBlink;
  }, [visible, prefs.cursorBlink]);

  /**
   * Font, size, line height, cursor and scrollback, put on the pane on screen when they change —
   * and on a hidden one when it is shown, like the scheme: a font option rebuilds xterm's renderer,
   * which a dozen hidden panes should not each pay for at the moment of the change.
   */
  useEffect(() => {
    const term = termRef.current;
    const wanted = JSON.stringify(prefs);
    if (!term || !visible || prefsAs.current === wanted) return;
    Object.assign(term.options, prefOptions(prefs));
    prefsAs.current = wanted;
    refit();
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, visible]);

  /**
   * Drops onto a dock pane: files from the desktop through Tauri's own drag-drop event (the webview
   * takes those before the page sees them), and rows from the explorer through the event its drag
   * dispatches on the element under the pointer (`cf-explorer-drop`). Only while on screen — a
   * hidden pane is not under any pointer, and a listener per hidden pane would be all cost.
   */
  useEffect(() => {
    const box = containerRef.current?.parentElement;
    if (!visible || !box || !dockRef.current || readOnlyRef.current) return;
    const onExplorerDrop = (event: Event) => typePaths((event as CustomEvent<string[]>).detail ?? []);
    box.addEventListener("cf-explorer-drop", onExplorerDrop);
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const inside = (x: number, y: number) => {
      const el = elementAtDropPoint(x, y);
      return !!el && box.contains(el);
    };
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "leave") return setDropOver(false);
          const hit = inside(payload.position.x, payload.position.y);
          if (payload.type === "drop") {
            setDropOver(false);
            if (hit) typePaths(payload.paths);
          } else setDropOver(hit);
        })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    } catch {
      // No webview (tests): nothing to listen to.
    }
    return () => {
      disposed = true;
      unlisten?.();
      box.removeEventListener("cf-explorer-drop", onExplorerDrop);
      setDropOver(false);
    };
  }, [visible, typePaths]);

  /**
   * Repaints every row xterm is already holding.
   *
   * Not a redraw of new output — the buffer is untouched and correct throughout. This is for the
   * case where the *renderer* has nothing on it while the buffer does: one built or torn down
   * while this pane was `display: none`, or a WebGL context the browser took back. `refresh`
   * marks the rows dirty and lets xterm draw them on the next frame, which is the only public way
   * to say "what you are showing is not what you are holding".
   */
  const repaint = () => {
    const term = termRef.current;
    if (term) term.refresh(0, term.rows - 1);
  };

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
    // One cell, not one pixel. `clientHeight` is the padding box, so while the padding sat on this
    // node the guard could never fire — a dock at `height: 0` still measured 16px, `fit()` floored
    // to a single row, and the shell got a SIGWINCH telling it the terminal was one row tall on
    // *every* dock open. The padding has moved to the wrapper, which fixes that by itself; the
    // floor stays because a box shorter than one row cannot be fitted to a meaningful size anyway,
    // and this is exactly the state a dock opening from zero passes through.
    if (!box || box.clientHeight < MIN_FIT_PX || box.clientWidth < MIN_FIT_PX) return;
    fitAddon.fit();
    // Nothing to tell the shell if nothing changed. A resize drag fires this on every animation
    // frame, and each call is an IPC round trip plus a pty reflow — which on Windows is a ConPTY
    // re-render of the whole screen buffer.
    if (term.cols === reportedRef.current.cols && term.rows === reportedRef.current.rows) return;
    reportedRef.current = { cols: term.cols, rows: term.rows };
    // A read-only pane has no pty to tell; xterm has already reflowed itself.
    if (!readOnlyRef.current) void resizeTerminal(sessionId, term.cols, term.rows);
  };

  const refit = () => {
    if (!visible) return;
    // A panel beside the dock opening by its real width resizes this box on every frame for a
    // moment; the shell hears about the width it lands on, once — see `useEdgeSlide`.
    if (edgeMoving()) {
      whenEdgeSettles(refit);
      return;
    }
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (term && fitAddon) fitAndReport(term, fitAddon);
  };

  /**
   * What a pane needs on the way back from `display: none`, which is more than a refit.
   *
   * **The renderer comes back holding nothing, and only an option change tells it so.**
   *
   * The buffer is intact throughout — it is the renderer that is empty. The WebGL addon is disposed
   * when this pane is hidden and built again when it returns (see the effect below), and a renderer
   * that has just replaced another has drawn no rows yet.
   *
   * Writing `fontSize` to a different value and straight back is the public way to say so. xterm's
   * `RenderService` subscribes the font options to `clear()` + `handleResize()` + `_fullRefresh()`,
   * and `OptionsService`'s setter fires on each write that differs from the current value — so this
   * asks for that sequence twice, the second landing on the value that was already there. Both
   * writes happen inside one synchronous block, so nothing is ever laid out at the intermediate size.
   *
   * It is *not* about a stale cell measurement, which is what this comment used to claim. xterm 6
   * measures through `TextMetricsMeasureStrategy` (an `OffscreenCanvas`, no DOM node), falls back to
   * a span only if that constructor throws, and `_validateAndSet` keeps the previous value when a
   * measurement comes back zero — commented, in xterm's own source, for exactly the `display: none`
   * case. The cell never zeroes. The refresh is the whole of what this buys.
   *
   * Only on the way *back into view*, never from the `ResizeObserver`: a drag never passes through
   * `display: none`, so its measurement is live, and nudging on every frame of a resize would be
   * two full re-measures a frame for nothing.
   */
  const revive = () => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    const box = containerRef.current;
    if (!term || !fitAddon || !box || box.clientHeight < 1 || box.clientWidth < 1) return;
    // No font-size nudge here any more.
    //
    // It used to set `fontSize` to `n + 1` and straight back to `n` to force a refresh — and by the
    // comment above, a refresh is the whole of what it bought. But assigning `fontSize` is not a
    // refresh: xterm's setter tears the renderer down and rebuilds it, glyph atlas included, so
    // this was two full renderer rebuilds on *every* hide→show — every tab switch, every dock
    // reopen, for every mounted pane. `repaint()` on the next line is the refresh, and it is a
    // `term.refresh(0, rows - 1)` that marks the rows dirty and lets the existing renderer redraw
    // them on the next frame.
    fitAndReport(term, fitAddon);
    repaint();
  };

  /**
   * Panes hidden via CSS report zero size, so xterm needs putting back together right when one
   * reappears — plus a live `ResizeObserver` for dock-height drags and split-ratio changes while
   * it is actually visible.
   *
   * **Declared before the WebGL effect below, and that order is the fix.** Effects in one commit
   * run in declaration order, so this measures and fits *before* the renderer is rebuilt against
   * the result. The other way round — which is how this used to read — builds the new renderer on
   * the zero-cell measurement `revive` describes, and the pane comes back blank.
   */
  useEffect(() => {
    if (visible) revive();
    if (!containerRef.current) return;
    const observer = new ResizeObserver(refit);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId]);

  /**
   * GPU rendering, with the DOM renderer as the safety net — and only for the pane on screen.
   *
   * xterm's default renderer builds a `<div>` per visible row and a `<span>` per style run and
   * re-lays that text out on every output frame. In a webview that text is not GPU-accelerated,
   * so a chatty command (a build log, `npm install`) turned into a layout storm that stuttered
   * the whole window, not just this pane. WebGL draws the same glyphs off a texture atlas.
   *
   * It is visually identical to the DOM renderer outside a see-through window, where the ground is
   * opaque and `allowTransparency` is off. Inside one the ground is cleared and the option is on —
   * this addon honours both (its glyph atlas is keyed on the option), which is why the renderer is
   * built again when the glass switches: the effect is keyed on `glass` as well.
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
   * **Every path out of here repaints, and that is the other half of the fix.** A renderer that
   * has just replaced another one has drawn nothing yet — it holds no rows, it was handed a
   * terminal mid-life, and nothing about loading an addon tells it to catch up. The buffer is
   * whole; saying so is this effect's job on the way in, and `onContextLoss`'s on the way out.
   *
   * Declared *after* the refit above (so the renderer is built against a terminal that has already
   * been measured for the box it is reappearing in) and after the construction effect (so
   * `termRef.current` is set).
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term || !visible) return;
    // Battery saving at Máximo: no GPU context per terminal — the DOM renderer draws instead, and
    // the cleanup of the WebGL one that was running has already handed back to it.
    if (noGpu) {
      setRenderer("dom");
      repaint();
      return;
    }
    let webgl: WebglAddon | null = null;
    let retry: number | undefined;
    let disposed = false;

    /**
     * Builds the GPU renderer, and says out loud when it could not.
     *
     * The retry is the part that was missing. `onContextLoss` used to dispose the addon and stop
     * there, which strands the pane on the DOM renderer *for the rest of the session* — and a lost
     * context is not a permanent condition: WebView2 hands one back after a GPU process restart, a
     * driver reset or the machine waking up, all of which are ordinary. Losing the fast renderer to
     * a transient event and never asking again is most of what "the terminals are very slow on
     * Windows" feels like from the outside, because nothing about the pane says anything changed.
     *
     * Bounded, so a webview that will never grant a context is asked a handful of times rather than
     * forever: past `WEBGL_RETRIES` this pane stays on the DOM renderer and reports it.
     */
    const attach = (attempt: number) => {
      if (disposed) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webgl === addon) webgl = null;
          // The DOM renderer it just fell back to starts empty; the repaint is part of the
          // handover, not an extra.
          repaint();
          if (attempt < WEBGL_RETRIES) {
            // Backed off, because a context lost during a GPU process restart cannot be reacquired
            // in the same frame — asking immediately just burns the retry budget.
            retry = window.setTimeout(() => attach(attempt + 1), WEBGL_RETRY_MS * (attempt + 1));
          } else {
            setRenderer("dom");
          }
        });
        term.loadAddon(addon);
        webgl = addon;
        setRenderer("webgl");
        repaint();
        return;
      } catch {
        // No WebGL in this webview, or `loadAddon` refused it. Nothing to dispose: `webgl` is
        // assigned on the try's *last* line, so anything that throws leaves it null.
        if (attempt < WEBGL_RETRIES) {
          retry = window.setTimeout(() => attach(attempt + 1), WEBGL_RETRY_MS * (attempt + 1));
        } else {
          setRenderer("dom");
        }
        repaint();
      }
    };

    attach(0);
    return () => {
      disposed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      webgl?.dispose();
    };
  }, [visible, sessionId, glass, noGpu]);

  return (
    // The wrapper is exactly the box the container used to be, so nothing about xterm's geometry
    // changes — it exists to be the badge's positioning parent, and to keep the badge out of the
    // node xterm owns the children of.
    <div
      className={`relative h-full w-full ${dropOver ? "ring-2 ring-inset ring-[var(--cf-accent)]" : ""}`}
      // Where the explorer's drag looks when it is released over nothing of its own — see `FileTree`.
      data-cf-terminal-drop={dock ? "" : undefined}
      onContextMenu={(event) => {
        // Claims the right-click before `contextMenuGuard`'s document listener sees it, which is
        // what stops the webview's own Reload/Back menu from appearing over a terminal.
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: termRef.current?.hasSelection() ?? false,
          selection: termRef.current?.getSelection() ?? "",
          lastOutput: shellRef.current?.lastOutput() ?? null,
          agent: dockRef.current?.agentHere?.(cwdRef.current ?? dockRef.current.cwd) ?? null,
          lastDone: lastDoneRef.current,
        });
      }}
    >
      {/* The padding is on this wrapper, never on `containerRef`, and that is load-bearing.

          `FitAddon` measures `terminal.element.parentElement` — the node `term.open()` was called
          with — by reading its *computed* height, which under `box-sizing: border-box` is the
          border box and therefore includes its padding. It then subtracts the padding of `.xterm`
          itself, which has none. Padding on that node was thus counted as usable terminal height
          twice over: it fitted ~16px too many rows, laid `.xterm` out 8px down from the top, and
          sent its last row past the bottom of the clip box — where `overflow-hidden` cut it in
          half, at the very bottom edge of the dock, directly above the status bar. Measured at a
          341px dock: FitAddon saw 307px, fitted 20 rows, and `.xterm` overhung by exactly 8px.
          Which heights it bites at depends on `dockHeight mod cellHeight`, and the cell height
          differs per platform and per display scaling — so the same build can look right on one
          machine and clipped on another, which is how this survived so long.

          Moving the padding out here keeps the visual inset identical and leaves `containerRef` a
          pure content box, so what FitAddon measures is what xterm actually gets. */}
      {/* Painted with the terminal's own ground, so the inset reads as part of the shell rather
          than as a frame of the dock around it — and cleared, like it, in a see-through window. */}
      <div className="h-full w-full p-2" style={{ background: glass ? undefined : scheme.ui.bg }}>
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
      </div>

      {findOpen && searchRef.current && (
        <TerminalSearch addon={searchRef.current} dark={dark} focusToken={findFocus} onClose={closeFind} />
      )}

      {/* Only when the GPU renderer could not be had. Top-right rather than bottom-right, which the
          copy badge owns, and it stays put: this is a condition, not an event — except under the
          find box, which takes the same corner while it is open. */}
      {renderer === "dom" && !findOpen && (
        <div
          title={t("terminal.softwareRendererHint")}
          className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-1.5 py-0.5 text-[10.5px] text-[var(--cf-text-muted)] opacity-70"
        >
          <TriangleAlert size={10} className="text-[var(--cf-warning)]" />
          {t("terminal.softwareRenderer")}
        </div>
      )}

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
            ...(readOnly ? [] : [{ label: t("terminal.paste"), icon: ClipboardPaste, onClick: pasteClipboard }]),
            // Only once the shell has marked a finished command — see `shellIntegration`.
            ...(menu.lastOutput !== null
              ? [
                  {
                    label: t("terminal.copyLastOutput"),
                    leading: <TextSelect size={13} className="shrink-0 opacity-70" />,
                    onClick: () => copyText(menu.lastOutput ?? ""),
                  },
                ]
              : []),
            { label: t("terminal.find"), icon: Search, separated: true, onClick: openFind },
            { label: t("terminal.clear"), icon: Eraser, onClick: () => termRef.current?.clear() },
            { label: t("terminal.saveOutput"), icon: FileDown, onClick: () => void saveOutput() },
            ...(dock
              ? [
                  {
                    label: t("terminal.askAi"),
                    leading: <AiSparkles size={13} />,
                    separated: true,
                    // The selection, else the last command's output, else the screen's last lines.
                    onClick: () =>
                      dock.onAskAi(
                        menu.selection || menu.lastOutput || allText().split("\n").slice(-60).join("\n"),
                      ),
                  },
                  ...(dock.onSendToAgent && menu.agent
                    ? [
                        {
                          // Only in an agent's own worktree, and named after the task: this sends a
                          // turn to something that edits files, so it must be obvious *whose* turn
                          // it is before it is clicked.
                          label: t("terminal.sendToAgent", { name: menu.agent.title }),
                          leading: <AiSparkles size={13} />,
                          onClick: () =>
                            dock.onSendToAgent?.(menu.agent?.id ?? "", {
                              command: menu.lastDone?.command ?? null,
                              exit: menu.lastDone?.exit ?? null,
                              // The same ladder «ask the AI» uses: what you selected, else what the
                              // last command printed, else what is on screen.
                              output:
                                menu.selection || menu.lastOutput || allText().split("\n").slice(-60).join("\n"),
                            }),
                        },
                      ]
                    : []),
                  {
                    label: t("terminal.newHere"),
                    icon: FolderPlus,
                    separated: true,
                    onClick: () => dock.onNewHere(cwdRef.current ?? dock.cwd),
                  },
                  ...(cwdRef.current
                    ? [{ label: t("terminal.revealFolder"), icon: SquareArrowOutUpRight, onClick: () => void openPath(cwdRef.current!).catch((e: unknown) => pushErrorToast(String(e))) }]
                    : []),
                  { label: t("terminal.restart"), icon: RotateCcw, onClick: dock.onRestart },
                ]
              : []),
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
