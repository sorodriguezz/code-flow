import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Power, RotateCcw, X } from "lucide-react";
import { t } from "../i18n";
import { NotAllowed, rpc } from "../transport";
import { useMobileStore } from "../store";
import { toastError, toastSuccess } from "../toast";
import { tapped } from "../haptics";
import { RootBar } from "../ui/RootBar";
import { Button, IconButton } from "../ui/Button";
import { Spinner } from "../ui/Feedback";
import { BottomBar } from "../ui/BottomBar";
// xterm's own stylesheet, and it is not optional decoration — it is the structural CSS that makes
// the widget a terminal. Without it the helper textarea xterm keeps for input renders in-flow at
// the browser's default size (complete with a resize handle), pushing the rows down and clipping
// the prompt, and `.xterm-viewport { overflow-y: scroll }` is absent so scrollback cannot be
// reached at all. The mobile bundle shipped without it, which is most of "las terminales no
// funcionan bien".
import "@xterm/xterm/css/xterm.css";

/**
 * A real shell, on a phone.
 *
 * # Why xterm and not a textarea
 *
 * Anything worth opening a terminal for on a phone — watching a build, tailing a log, running a
 * test — emits ANSI. Colour, cursor moves, carriage-return progress bars, alternate screen. A
 * plain text view renders `npm test` as a wall of escape sequences, which is worse than useless
 * because it looks like corruption. xterm.js is what the desktop already uses, so the output is
 * identical on both.
 *
 * It is loaded lazily (see `App.tsx`): ~113 kB gzipped that a session which never opens this tab
 * must not pay for.
 *
 * # Who ends a session
 *
 * Only an explicit tap, and the desktop's own reaping. This screen used to close the shell from its
 * effect cleanup, which meant that switching to the Repo tab for five seconds killed whatever was
 * running — the screen is not unmounted on navigation any more (see `App.tsx`), and even if it were,
 * a cleanup is the wrong place to end somebody's build from. What is left is the button below, and
 * `terminal::close_owned` on the desktop for a device that never comes back.
 *
 * # The key bar
 *
 * A phone keyboard has no Ctrl, no Tab, no Esc and no arrows, and a terminal is unusable without
 * them — Ctrl-C alone is most of what you need a terminal on a phone *for*. The row above the
 * keyboard sends the control bytes directly, which is what every mobile SSH client settles on. It
 * scrolls horizontally rather than squeezing: at eight keys on a 360-point screen every one of them
 * was under the 44px minimum, and the arrows — the ones you press repeatedly — were the ones that
 * fell off the end.
 */

/** The control sequences the accessory row writes, as raw bytes on the wire. */
const KEYS: { label: string; data: string; wide?: boolean }[] = [
  { label: "^C", data: "\x03" },
  { label: "^D", data: "\x04" },
  { label: "^Z", data: "\x1a" },
  { label: "^L", data: "\x0c" },
  { label: "Tab", data: "\t", wide: true },
  { label: "Esc", data: "\x1b", wide: true },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "←", data: "\x1b[D" },
  { label: "→", data: "\x1b[C" },
  { label: "Home", data: "\x1b[H", wide: true },
  { label: "End", data: "\x1b[F", wide: true },
];

/**
 * How much output is buffered per session while the terminal is not ready for it, and for how many
 * sessions at once.
 *
 * Both are bounds on a map that a client with no terminal mounted would otherwise fill: frames keep
 * arriving for as long as a shell is printing, and there is no guarantee any of them are ever
 * claimed. Two sessions is one more than this screen can show — the extra covers the moment a project
 * switch has opened a second shell while the first is still printing its last line.
 */
const PENDING_CHUNKS = 500;
const PENDING_SESSIONS = 2;

/** One live session, as `list_terminals` answers it. */
interface TerminalInfo {
  id: string;
  cwd: string;
  profile: string;
  owner: string | null;
}

export function TerminalScreen() {
  const projects = useMobileStore((s) => s.projects);
  const projectId = useMobileStore((s) => s.projectId);
  const terminals = useMobileStore((s) => s.terminals);
  const rememberTerminal = useMobileStore((s) => s.rememberTerminal);
  const holder = useRef<HTMLDivElement>(null);
  const term = useRef<import("@xterm/xterm").Terminal | null>(null);
  /** Whether xterm itself has loaded and attached. The session effect waits on it, because the
   *  shell has to be told a real number of columns before it draws its first prompt. */
  const [mounted, setMounted] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** The shell ended. The output stays on screen — it is usually the reason you were watching — and
   *  the key bar stops pretending it can send anything. */
  const [dead, setDead] = useState(false);
  /** Bumped by "open again", and in the session effect's dependencies. A counter rather than a
   *  boolean because reopening twice has to run the effect twice. */
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const cwd = projects.find((p) => p.id === projectId)?.local_path;
  const remembered = projectId ? (terminals[projectId] ?? null) : null;

  /**
   * The session this screen is showing, as a ref rather than only as state.
   *
   * The output listener reads this. It cannot be gated on the `sessionId` *state* — that was the
   * bug: `open_terminal` resolves, React schedules a re-render, and the effect that subscribes runs
   * a tick later. The shell's prompt is already on the wire by then, so the first frames were
   * dropped and the screen stayed black until something forced more output. A ref is readable the
   * instant the id exists.
   */
  const liveId = useRef<string | null>(null);

  /**
   * Output that has arrived for a session this screen is not (yet) showing, keyed by session id.
   *
   * # Why a map and not one buffer
   *
   * Two things print into this client at once, and until this was keyed they were mixed. The
   * terminal is behind a dynamic import, so there is a real window between the shell starting to
   * print and there being anything to print into — the buffer exists for that. But the *other*
   * session's frames land in the same window: a project switch opens a second shell while the first
   * is still finishing a line, and a single buffer replayed both into whichever terminal claimed it.
   *
   * The obvious guard — dropping anything whose id is not `liveId` — is worse, and was tried:
   * the pty's emitter thread starts printing *before* `open_terminal` returns, so the new shell's
   * own prompt has no `liveId` to match yet and is thrown away. That is the black screen this
   * buffering exists to prevent, reintroduced by the fix for it. Keeping the frames under their own
   * id and claiming only the ones that turn out to be ours is the version that handles both.
   */
  const pending = useRef<Map<string, string[]>>(new Map());

  /** xterm's keystroke subscription, kept so it can be torn down when the session it writes to ends.
   *  Without this the handler goes on posting bytes to a dead id for the life of the screen. */
  const typing = useRef<import("@xterm/xterm").IDisposable | null>(null);

  const write = useCallback((data: string) => {
    const id = liveId.current;
    if (!id) return;
    void rpc<void>("write_terminal", { id, data }).catch(() => {});
  }, []);

  /** Everything owed to a session that has stopped being this screen's. */
  const detach = useCallback(() => {
    typing.current?.dispose();
    typing.current = null;
    liveId.current = null;
  }, []);

  // ---------------------------------------------------------------------------
  // xterm itself: mounted once, for the life of the screen
  // ---------------------------------------------------------------------------
  //
  // Deliberately *not* keyed on the project. Splitting this from the session effect below is what
  // lets a project switch open a second shell rather than tear the widget down and rebuild it, and
  // it is also what makes the "open again" button cheap — neither reloads a 113 kB chunk.
  useEffect(() => {
    let alive = true;
    let observer: ResizeObserver | null = null;
    let onViewport: (() => void) | null = null;

    void (async () => {
      // Inside the `try`, unlike before. This import sat above it, so a chunk that no longer
      // exists — a desktop rebuilt under a phone still holding the old page — became an unhandled
      // rejection rather than anything the screen could react to: the spinner below spun forever
      // and no error was ever shown. It gets its own message, because "the terminal is switched
      // off" and "this page is out of date" send the reader to opposite places.
      let Terminal: typeof import("@xterm/xterm").Terminal;
      let FitAddon: typeof import("@xterm/addon-fit").FitAddon;
      try {
        [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
      } catch {
        if (alive) setError(t("terminal.loadFailed"));
        return;
      }
      if (!alive || !holder.current) return;

      const terminal = new Terminal({
        // Small enough that eighty columns nearly fit in portrait, large enough to read. The
        // desktop's default would give about forty columns here, which wraps every real command.
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        // No WebGL addon, unlike the desktop: mobile GPUs handle it inconsistently and a failed
        // context leaves a blank canvas rather than falling back. The DOM renderer is fast enough
        // for a phone-sized viewport.
        cursorBlink: true,
        convertEol: true,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(holder.current);
      term.current = terminal;

      /**
       * Re-fit whenever the container actually has a size, and tell the shell about it.
       *
       * The other half of the black screen: `fit()` immediately after `open()` measured a flex
       * child that had not been laid out yet, so it computed zero columns and zero rows and xterm
       * rendered into a canvas with no dimensions. Height zero is also the state this screen sits
       * in while another tab is on top of it, which is now an ordinary condition rather than an
       * impossible one — the screen stays mounted (see `App.tsx`) — so it must not be reported to
       * the pty as a one-row terminal.
       */
      const refit = () => {
        if (!holder.current || holder.current.clientHeight === 0) return;
        fitAddon.fit();
        const id = liveId.current;
        if (!id) return;
        void rpc<void>("resize_terminal", {
          id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => {});
      };

      observer = new ResizeObserver(refit);
      observer.observe(holder.current);

      // **And from the visual viewport, which the observer never hears about.** On iOS the keyboard
      // is drawn over the page without resizing anything the observer watches, so the shell kept its
      // full-screen geometry while half of it was behind the keyboard — long commands wrapped
      // against a row count that no longer existed. `visualViewport` is the only thing that reports
      // the keyboard at all; see `viewport.ts`.
      onViewport = () => refit();
      window.visualViewport?.addEventListener("resize", onViewport);

      if (alive) setMounted(true);
    })();

    return () => {
      alive = false;
      observer?.disconnect();
      if (onViewport) window.visualViewport?.removeEventListener("resize", onViewport);
      detach();
      pending.current.clear();
      term.current?.dispose();
      term.current = null;
    };
  }, [detach]);

  // ---------------------------------------------------------------------------
  // The frames, for as long as this project's session is the one on screen
  // ---------------------------------------------------------------------------
  //
  // Given the same `[cwd]` lifetime as the session effect below, deliberately: registered once on
  // mount it would outlive the session it was buffering for, and a project switch would leave the
  // previous shell's chunks under a key nothing would ever claim.
  useEffect(() => {
    const onFrame = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; data: string }>).detail;
      // The only path that writes to the terminal. Anything else — another project's shell, another
      // tab's, a frame that arrived a moment after this session ended — is buffered under its own id
      // or dropped, never painted over what is on screen.
      if (detail.id === liveId.current) {
        term.current?.write(detail.data);
        return;
      }
      const buffered = pending.current.get(detail.id) ?? [];
      if (buffered.length < PENDING_CHUNKS) buffered.push(detail.data);
      pending.current.set(detail.id, buffered);
      // `Map` iterates in insertion order, so the first key is the oldest session — the one least
      // likely to still be waiting to be claimed.
      while (pending.current.size > PENDING_SESSIONS) {
        const oldest = pending.current.keys().next().value;
        if (oldest === undefined) break;
        pending.current.delete(oldest);
      }
    };

    const onExit = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string }>).detail;
      pending.current.delete(detail.id);
      if (detail.id !== liveId.current) return;
      // The id goes first, so nothing — a keystroke already in flight, the key bar, a resize — can
      // post to a session that no longer exists.
      detach();
      // The same string the desktop's pane writes (`TerminalPane.tsx`), so a shell that ended looks
      // the same on both clients.
      term.current?.write("\r\n[process exited]\r\n");
      setDead(true);
      setSessionId(null);
      if (projectId) rememberTerminal(projectId, null);
    };

    window.addEventListener("codeflow:terminal", onFrame);
    window.addEventListener("codeflow:terminal-exit", onExit);
    return () => {
      window.removeEventListener("codeflow:terminal", onFrame);
      window.removeEventListener("codeflow:terminal-exit", onExit);
    };
    // `projectId` and `rememberTerminal` are read by `onExit`; `cwd` is what the session effect keys
    // on, and the two must rise and fall together.
  }, [cwd, projectId, rememberTerminal, detach]);

  // ---------------------------------------------------------------------------
  // The session: adopted if one is still running, opened otherwise
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!cwd || !mounted || !projectId) return;
    const terminal = term.current;
    if (!terminal) return;
    let alive = true;

    // A different project's output must not be read as this one's history. Cleared here rather than
    // in the cleanup so the previous session's scrollback stays visible right up to the moment the
    // new one has something to say.
    terminal.reset();
    setDead(false);
    setSessionId(null);
    setError(null);

    void (async () => {
      try {
        let id: string | null = null;
        // Adopting beats opening whenever there is something to adopt. A remembered id survives a
        // reload, a tab eviction and a wifi drop — all of which used to strand the shell and start a
        // second one on top of it — but it is a claim about another process's state, so it is
        // checked against the desktop rather than trusted.
        if (remembered) {
          const live = await rpc<TerminalInfo[]>("list_terminals");
          if (!alive) return;
          if (live.some((session) => session.id === remembered)) {
            id = remembered;
            // What it printed while nobody was attached. Without this a reattached terminal opens
            // blank, with a cursor and no context, which reads as broken rather than as resumed.
            const replay = await rpc<string | null>("read_terminal", { id });
            if (!alive) return;
            if (replay) terminal.write(replay);
          }
        }
        if (!id) {
          const opened = await rpc<{ id: string }>("open_terminal", { cwd });
          if (!alive) return;
          id = opened.id;
        }

        // The ref first and the state second: the ref is what the listener above reads, and it has
        // to be correct before the very next frame can arrive.
        liveId.current = id;
        setSessionId(id);
        rememberTerminal(projectId, id);

        // Only this session's buffered frames, and only now that it is ours. Everything else in the
        // map belongs to a shell this screen is not showing and is dropped rather than replayed —
        // that mixing was the bug the keys exist for.
        for (const chunk of pending.current.get(id) ?? []) terminal.write(chunk);
        pending.current.clear();

        await rpc<void>("resize_terminal", {
          id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => {});
        // Reads `liveId` rather than closing over the id it was created with. Closed over, the
        // handler went on writing to whichever session was current when it was registered — so after
        // an exit or a project switch every keystroke went to a dead id and silently vanished. Kept
        // in a ref so `detach` can dispose it the moment the session ends.
        typing.current = terminal.onData((data) => write(data));
      } catch (e) {
        if (!alive) return;
        // `NotAllowed` is a distinct answer (HTTP 403) rather than the 401 that used to make this
        // client delete its own token — so "terminals are switched off" can be said for certain
        // instead of guessed at. Anything else is a real failure and is reported verbatim, where it
        // used to be swallowed under the same reassuring sentence about a setting.
        setError(e instanceof NotAllowed ? t("terminal.refused") : String(e));
      }
    })();

    return () => {
      alive = false;
      // **No `close_terminal` here.** The shell outlives this effect on purpose: a project switch
      // leaves the previous one running and adoptable, and leaving the tab does not even run this.
      // Ending a session is the button below, or the desktop reaping a device that is gone.
      detach();
    };
    // `remembered` is deliberately absent: it is written by this effect, and depending on it would
    // make the effect re-run itself. It is read as the value it had when the project was chosen,
    // which is the value that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, projectId, mounted, attempt]);

  const close = () => {
    const id = liveId.current;
    if (!id) return;
    setConfirmClose(false);
    // Forgotten before the round trip, so a failed close cannot leave this client adopting an id the
    // desktop has already killed. The `terminal:exit` frame does the rest of the tidying.
    if (projectId) rememberTerminal(projectId, null);
    void rpc<void>("close_terminal", { id })
      .then(() => toastSuccess(t("toast.terminalClosed")))
      .catch((e: unknown) =>
        toastError(t("error.actionFailed"), e instanceof Error ? e.message : String(e)),
      );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--cf-bg)]">
      <RootBar
        title={t("nav.terminal")}
        actions={
          sessionId ? (
            <IconButton
              icon={<X size={18} />}
              label={t("terminal.close")}
              tone="danger"
              onClick={() => setConfirmClose(true)}
            />
          ) : undefined
        }
      />

      {/* An inline confirmation, where this used to call `window.confirm` — a native dialog with the
          browser's own wording, its own language, and a look that has nothing to do with the rest of
          the app. Every other destructive action here confirms in place; this one now does too. */}
      {confirmClose && (
        <div className="cf-safe-x shrink-0 border-b border-[var(--cf-danger)]/40 bg-[var(--cf-danger-soft)] px-3 py-2">
          <p className="text-base text-[var(--cf-danger-text)]">{t("terminal.closeConfirm")}</p>
          <div className="mt-2 flex gap-2">
            <Button full size="sm" onClick={() => setConfirmClose(false)}>
              {t("common.cancel")}
            </Button>
            <Button full size="sm" variant="danger" onClick={close}>
              {t("terminal.close")}
            </Button>
          </div>
        </div>
      )}

      {/* The holder is rendered unconditionally, in every state — xterm attaches to this node once
          and keeps it for the life of the screen, so a message that replaced it would tear the
          terminal down to say something about it. Anything to say goes on top instead. */}
      <div className="relative min-h-0 flex-1">
        <div ref={holder} className="absolute inset-0 overflow-hidden bg-[var(--cf-sunken)] p-1" />
        {!cwd ? (
          <Message>{t("repo.noProject")}</Message>
        ) : error ? (
          <Message icon={<Power size={24} className="text-[var(--cf-text-muted)]" aria-hidden />}>
            <span className="cf-selectable">{error}</span>
            <Button className="mt-3" onClick={() => setAttempt((n) => n + 1)}>
              {t("terminal.retry")}
            </Button>
          </Message>
        ) : !sessionId && !dead ? (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <Spinner />
          </div>
        ) : null}
      </div>

      <BottomBar>
        {/* Horizontally scrollable rather than squeezed. Twelve keys at the 44px minimum need more
            width than a phone has, and the ones that fell off the end when they were squeezed were
            the arrows — which are the keys you press over and over. */}
        <div className="cf-scroll-x flex gap-1 px-1.5 py-1.5">
          {KEYS.map((key) => (
            <button
              key={key.label}
              type="button"
              disabled={!sessionId}
              aria-label={key.label}
              // `onPointerDown` with the default prevented, not `onClick`: a click steals focus
              // from the hidden input xterm keeps, which closes the phone keyboard on every
              // Ctrl-C. This sends the byte and leaves focus exactly where it was.
              onPointerDown={(e) => {
                e.preventDefault();
                tapped();
                write(key.data);
              }}
              className={`cf-tap cf-press shrink-0 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] font-mono text-sm disabled:opacity-40 ${
                key.wide ? "min-w-[3.25rem]" : "min-w-11"
              }`}
            >
              {key.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 px-1.5 pb-1.5">
          {dead ? (
            <Button
              full
              size="sm"
              variant="primary"
              icon={<RotateCcw size={14} />}
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t("terminal.reopen")}
            </Button>
          ) : (
            // Brings the phone keyboard back after the key bar or a scroll has dismissed it — there
            // is no other way to focus a canvas-backed terminal on touch, and losing the keyboard
            // used to mean switching tabs and back.
            <Button
              full
              size="sm"
              disabled={!sessionId}
              icon={<Keyboard size={14} />}
              onClick={() => term.current?.focus()}
            >
              {t("terminal.keyboard")}
            </Button>
          )}
        </div>
      </BottomBar>
    </div>
  );
}

/** Something to say, drawn over the terminal rather than instead of it. */
function Message({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--cf-sunken)] px-8 text-center">
      {icon}
      <div className="text-base text-[var(--cf-text-muted)]">{children}</div>
    </div>
  );
}
