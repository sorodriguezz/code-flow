/**
 * How the phone talks to the desktop.
 *
 * Two channels, mirroring exactly the two the desktop webview uses: a request/response call that
 * stands in for Tauri's `invoke`, and a subscription that stands in for its `listen`. That
 * symmetry is deliberate — the screens in this folder are written against the same command names
 * and the same event names as `src/lib/tauri/`, so anything learned about one side transfers.
 *
 * There is no polling loop anywhere in this client. The desktop emits, the server forwards, the
 * screens re-render. A phone on a weak connection that misses frames is told so explicitly
 * (`state:resync`) rather than left quietly wrong.
 */

const TOKEN_KEY = "codeflow.remote.token";
const NAME_KEY = "codeflow.remote.name";
/**
 * This device's own id, as the desktop knows it.
 *
 * `/api/pair` has always answered one and this client has always thrown it away. It is what
 * `state:invalidate` stamps as `origin`, and without it stored there is no way to tell a change
 * somebody else made from the echo of one made here — so every tap on this phone came back as an
 * instruction to refetch the screen it had just drawn.
 */
const DEVICE_KEY = "codeflow.remote.device";

/** Raised when the desktop no longer recognises this device — revoked, or the install was reset. */
export class Unpaired extends Error {
  constructor() {
    super("unpaired");
  }
}

/**
 * Raised when the desktop knows this device perfectly well and will not do *this*.
 *
 * The distinction this class exists for is the one bug that made the whole feature look broken.
 * The server used to answer a switched-off command with the same 401 it answers a bad token with,
 * and this client resolved the ambiguity the only way it could — by assuming the worst and deleting
 * its own token. Since the terminal switch is off by default and the client discovered that switch
 * by *calling* a terminal command, a phone unpaired itself at startup while the desktop's device
 * list went on showing it as active. That is "se revoca el permiso en el teléfono pero en la app
 * sigue vigente", exactly.
 *
 * The server now answers 403 for a refusal, and this is that. It is an ordinary failure: report it,
 * do not touch the token.
 */
export class NotAllowed extends Error {
  constructor() {
    super("not_allowed");
  }
}

/**
 * Everyone who wants to know the moment this device stops being paired.
 *
 * A module-level set rather than a return value because the token can be dropped from inside any
 * `rpc` call, including ones whose callers do nothing with the failure — and the event layer, which
 * has no caller at all, needs to hear about it too. Without this the socket's reconnect loop would
 * discover the missing token, return silently, and never announce anything.
 */
const unpairedListeners = new Set<() => void>();

/** Subscribe to "this device is no longer paired". Returns the unsubscribe. */
export function onUnpaired(listener: () => void): () => void {
  unpairedListeners.add(listener);
  return () => unpairedListeners.delete(listener);
}

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Safari in private browsing throws on `localStorage` rather than returning null. Treated as
    // "not paired", which is the truth from this client's point of view — it just cannot remember
    // across reloads.
    return null;
  }
}

export function storedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * The id the desktop knows this device by, or `null` on a client paired before it was recorded.
 *
 * `null` is safe rather than merely tolerable: it makes the origin filter fail *open*, so a phone
 * that cannot recognise its own echo refetches a little more than it needs to instead of missing a
 * change somebody else made. The other way round would be a screen that silently stops updating.
 */
export function storedDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

function remember(token: string, name: string, deviceId: string | undefined) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(NAME_KEY, name);
    // A desktop older than this client answers no id. Written only when there is one, so the
    // absence stays distinguishable from an empty string.
    if (deviceId) localStorage.setItem(DEVICE_KEY, deviceId);
  } catch {
    // Same case as above. The session still works until the tab is closed.
  }
}

export function forget() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    // Goes with the token: the next pairing mints a new device row, and a stale id left behind
    // would make this client ignore invalidations addressed to whoever holds it now.
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* nothing to do */
  }
  // Announced, always, and after the removal so a listener that re-reads finds it gone. A token
  // dropped without telling anybody is how the socket used to end up in a reconnect loop it could
  // never leave, with the header stuck on "Reconectando…" forever.
  for (const listener of unpairedListeners) listener();
}

export interface Hello {
  app: string;
  pairing: boolean;
  /** A digest of the mobile bundle this server is serving. See `bundle_id` in `server.rs`. */
  bundle: string | null;
}

/** Whether the desktop is reachable at all, and whether it is currently offering a pairing code. */
export async function hello(): Promise<Hello | null> {
  try {
    const res = await fetch("/api/hello", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Hello;
  } catch {
    return null;
  }
}

/**
 * Which build this page was loaded from, remembered so a later one can be noticed.
 *
 * `null` until the first `hello` that carried a digest, which means the check simply does not run
 * on an install whose bundle is missing — the right behaviour, since there is nothing to be stale
 * against.
 */
let loadedBundle: string | null = null;

/** Records the running build, once, at startup. */
export async function rememberBundle(): Promise<void> {
  const info = await hello();
  if (info?.bundle) loadedBundle = info.bundle;
}

/**
 * Reloads the page if the desktop has since started serving a different build.
 *
 * # Why this is not paranoia
 *
 * The entry document names its chunks by content hash. Rebuild the client — every `pnpm tauri dev`
 * iteration, every app update — and those names change, but a phone that already has the page keeps
 * asking for the old ones. Those files are gone, and a 404 for a JavaScript module is not a
 * recoverable state: the module graph never finishes, React never re-renders, and what the user
 * sees is a white screen with a console error naming a file they have never heard of.
 *
 * Checked on socket *re*open rather than on a timer, because that is the moment a phone comes back
 * from a locked screen or a wifi handover, which is exactly when a desktop has had time to be
 * rebuilt underneath it.
 */
export async function reloadIfStale(): Promise<void> {
  if (!loadedBundle) return;
  const info = await hello();
  if (info?.bundle && info.bundle !== loadedBundle) location.reload();
}

/**
 * Redeems the six digits shown on the desktop.
 *
 * The server answers the same refusal for a wrong code, an expired one and a window that was
 * already burnt by earlier guesses, so this cannot tell the user which — and deliberately does not
 * try. "Ese código no sirve, pide otro" is both the honest message and the only useful one.
 */
export async function pair(code: string, name: string): Promise<void> {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  if (!res.ok) throw new Error("pairing rejected");
  const body = (await res.json()) as { ok: boolean; token?: string; deviceId?: string };
  if (!body.ok || !body.token) throw new Error("pairing rejected");
  remember(body.token, name, body.deviceId);
}

/**
 * One command, by the same name the desktop calls it.
 *
 * The reachable set is fixed on the server (`remotectl/dispatch.rs`) — asking for anything outside
 * it comes back as an ordinary rejection, indistinguishable from a bad token, which is why a 401
 * here is treated as "unpaired" rather than retried.
 */
export async function rpc<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const token = storedToken();
  if (!token) throw new Unpaired();

  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ cmd, args }),
  });

  // 401 is the *only* status that means "this token is no good", and dropping the token is a
  // destructive act that must never be reached by any other route. See `NotAllowed`.
  if (res.status === 401) {
    forget();
    throw new Unpaired();
  }
  // 403 is "not this command" — the terminal switch being off, or a client newer than the desktop
  // asking for something the allowlist does not have yet. An ordinary failure; the pairing stands.
  if (res.status === 403) {
    throw new NotAllowed();
  }

  const body = (await res.json()) as { ok: boolean; value?: T; error?: string };
  if (!body.ok) throw new Error(body.error ?? "command failed");
  return body.value as T;
}

export interface Frame {
  event: string;
  payload: unknown;
}

/**
 * The close code the desktop uses for "this device is no longer paired".
 *
 * Must match `CLOSE_REVOKED` in `server.rs`. Everything else — a dropped wifi, a desktop that
 * restarted, a NAT that reaped the flow — is an ordinary close and keeps the backoff; this one is
 * the only code that must *stop* the loop, because retrying with a token the desktop has thrown
 * away can never succeed.
 */
const CLOSE_REVOKED = 4401;

/**
 * How often the desktop sends its heartbeat, and how long this client will sit in silence before
 * concluding the socket is dead.
 *
 * Mirrors `PING_INTERVAL` in `server.rs`. Two intervals of tolerance rather than one, so a single
 * heartbeat lost to a busy radio does not cost a reconnect.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;
const SILENCE_LIMIT_MS = HEARTBEAT_INTERVAL_MS * 2;

/** How often the silence above is measured. Cheap enough to run while backgrounded. */
const WATCHDOG_INTERVAL_MS = 5_000;

/**
 * The event stream, with reconnection.
 *
 * A phone disconnects constantly — the screen locks, wifi hands over to cellular, the browser
 * backgrounds the tab — so a socket that gives up on the first close would be a socket that works
 * once. Backoff climbs to eight seconds and stays there rather than growing without bound: the
 * desktop is on the same network, so if it is reachable at all it is reachable quickly, and a phone
 * coming out of a pocket should not wait a minute to catch up.
 *
 * `onStatus` exists so the UI can say "reconectando" instead of silently showing stale rows, which
 * is the failure people misread as the app being broken.
 *
 * `onReopen` fires on every connection *after* the first. It is the half that actually restores
 * sync: while the socket was down the desktop went on emitting into nothing, and those frames are
 * gone — so coming back has to re-read rather than resume. The first connection does not call it,
 * because `bootstrap` has just done the same work.
 */
export function connectEvents(
  onFrame: (frame: Frame) => void,
  onStatus: (connected: boolean) => void,
  onReopen: () => void,
): () => void {
  let socket: WebSocket | null = null;
  let timer: number | undefined;
  let delay = 500;
  let closed = false;
  /** Whether this is a reconnection rather than the first connection — the staleness check has
   *  nothing to compare on the first one, and `rememberBundle` has just run. */
  let reopened = false;
  /**
   * When this client last heard anything at all.
   *
   * The measurement that catches a **half-open** flow: a router or a carrier drops the connection
   * without either end being told, and the browser goes on reporting `readyState === OPEN` against
   * a socket where nothing will ever arrive again. `readyState` alone cannot see that, which is why
   * the app could sit for an hour with a connected header over data frozen at the moment the phone
   * went in a pocket.
   *
   * Fed by any inbound frame, including the desktop's heartbeat. It has to be an application frame
   * and not the WebSocket `Pong`, because a browser never surfaces pongs to JavaScript at all.
   */
  let lastFrameAt = Date.now();

  /**
   * Abandons a socket without letting it talk back.
   *
   * Detaching the handlers first is the point: a socket forced closed here would otherwise fire its
   * own `onclose` a moment later and schedule a *second* reconnect, on top of the one already in
   * flight — two live sockets, two resyncs, and a backoff neither of them owns.
   */
  const discard = (sock: WebSocket | null) => {
    if (!sock) return;
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    try {
      sock.close();
    } catch {
      /* already gone; nothing to do */
    }
  };

  const open = () => {
    if (closed) return;
    const token = storedToken();
    // No token and no announcement was the dead end: this returned, no retry was scheduled, and
    // `onStatus` was never called — so the loop stopped forever while the header still said
    // "Reconectando…". Whoever wiped the token has already told the subscribers (see `forget`);
    // what is owed here is the status, so the UI stops claiming a reconnection is coming.
    if (!token) {
      onStatus(false);
      return;
    }
    // A phone coming back from a lock screen is the most likely reader of this line, and the
    // desktop it is coming back to may have been rebuilt in the meantime.
    if (reopened) void reloadIfStale();

    // `ws:` against an `http:` origin, `wss:` against `https:` — the page and the socket must agree
    // or the browser refuses the upgrade as mixed content.
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    // The token travels in the query string because a browser's WebSocket constructor cannot set
    // an Authorization header. See the note on the `/api/events` handler for why that is an
    // acceptable trade here and what would change it.
    const sock = new WebSocket(
      `${scheme}://${location.host}/api/events?token=${encodeURIComponent(token)}`,
    );
    socket = sock;

    sock.onopen = () => {
      delay = 500;
      lastFrameAt = Date.now();
      onStatus(true);
      if (reopened) onReopen();
    };
    sock.onmessage = (event) => {
      lastFrameAt = Date.now();
      try {
        onFrame(JSON.parse(event.data as string) as Frame);
      } catch {
        // A frame this client cannot parse is one a newer desktop sent. Skipping it is right —
        // the alternative is tearing down a working socket over one message.
      }
    };
    sock.onclose = (event) => {
      // Superseded: the watchdog or the visibility check already replaced this socket, and its
      // late close must not touch the connection that took over.
      if (socket !== sock) return;
      onStatus(false);
      socket = null;
      reopened = true;
      if (closed) return;
      // The desktop said, in the close frame itself, that this device has been revoked. Retrying
      // would be a loop against a door that is now bricked up, so the token goes — which publishes
      // `onUnpaired`, puts the pairing screen on, and (via the check below) stops the loop.
      if (event.code === CLOSE_REVOKED) {
        forget();
        return;
      }
      // Nothing to reconnect *as*. Without this the loop would spin against a server that can only
      // answer 401, every 8 seconds, for as long as the tab is open.
      if (!storedToken()) return;
      timer = window.setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
    sock.onerror = () => sock.close();
  };

  open();

  /**
   * Tears down whatever is there and starts again, from either of the two liveness checks.
   *
   * `reopened = true` is the line this was missing, and its absence cost the feature its whole
   * recovery path. `reopened` was set only in `sock.onclose` — and `discard()` above nulls
   * `onclose` *before* closing, precisely so a socket it is abandoning cannot schedule a second
   * reconnect. So every socket replaced from here came back with `reopened` still `false`, and the
   * `open()` below therefore called neither `onReopen()` (which is `resync`, the only thing that
   * re-reads a client that has been out of the loop) nor `reloadIfStale`.
   *
   * That is not the rare path. iOS freezes a backgrounded tab's timers and does not always fire
   * `close` for the socket it kills, so a phone coming out of a pocket is handled *here*, by the
   * watchdog or the visibility check — which means the common case was the one that skipped the
   * resync, and a phone that had been asleep through an hour of work quietly showed the hour-old
   * picture with a connected header over it.
   */
  const restart = () => {
    const dead = socket;
    socket = null;
    discard(dead);
    reopened = true;
    onStatus(false);
    window.clearTimeout(timer);
    delay = 500;
    lastFrameAt = Date.now();
    open();
  };

  // Only an `OPEN` socket can be silent in the way that matters. One still connecting, or already
  // closing, is a case `onclose` and the backoff own — measuring silence against it too would reset
  // that backoff every 50 s and turn a desktop that is simply switched off into a retry storm.
  const watchdog = window.setInterval(() => {
    if (closed || socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastFrameAt <= SILENCE_LIMIT_MS) return;
    restart();
  }, WATCHDOG_INTERVAL_MS);

  // Coming back from a locked screen is the single most common way this socket dies, and the
  // browser does not always fire `close` for it — sometimes it leaves the socket wedged in
  // `CLOSING` instead, which the old `!socket` test read as a healthy connection and left alone
  // forever. Anything that is not `OPEN` is replaced.
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    if (!socket) {
      window.clearTimeout(timer);
      delay = 500;
      // Same reason as `restart`: this is a reconnection, and it owes a resync and a staleness
      // check. Coming back with `reopened` false was a socket that reconnected into silence.
      reopened = true;
      open();
    } else if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      restart();
    }
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    closed = true;
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(watchdog);
    window.clearTimeout(timer);
    discard(socket);
    socket = null;
  };
}
