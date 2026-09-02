import { emit, listen } from "@tauri-apps/api/event";
import { WINDOW } from "./windowIdentity";
// Type-only: this module must stay a leaf, or the store that imports it to broadcast would import
// it back through this line.
import type { AiRunAbout } from "../state/aiRunStore";

/**
 * How the windows tell each other things.
 *
 * # Why this exists at all, when `state:invalidate` already did
 *
 * `state:invalidate` (see `lib/tauri/events.ts`) says *"a row changed, go and re-read it"*. That
 * covers everything durable, which is most of what crosses a window boundary, and it should go on
 * being what carries those changes — the reload goes through the loader the view already uses, so
 * no emitter has to know the shape of any store.
 *
 * What it cannot carry is the state that was never written down. Which workspace the user is
 * looking at is a fact about the main window, not a row in a table; which model is running right
 * now is a fact about this process, not about SQLite. Those are what this is for, and the list is
 * deliberately short — anything that *could* be a row should be a row.
 *
 * # Every window hears its own emit
 *
 * Tauri's `emit` goes to every window including the sender. Handing a window back its own message
 * is how "workspace changed" would become an infinite round trip, so every frame carries the label
 * it came from and [`onWindowMessage`] drops the ones this window sent. Nothing downstream has to
 * remember to check.
 */

/** The one event name. One channel with a `kind` inside beats one Tauri listener per message type:
 *  each `listen` is an IPC subscription, and there is no ordering guarantee between two of them. */
const CHANNEL = "windows:bus";

/** What the windows say to each other. Adding a case here is a deliberate act — see the note. */
export type WindowMessage =
  /** The main window moved to another workspace. Satellites follow it: an app window showing the
   *  collections of a workspace the user has left is the one thing this design refuses to do. */
  | { kind: "workspace"; workspaceId: string | null }
  /**
   * A model started or stopped somewhere.
   *
   * The status bar lives in the main window, and a run started from a satellite would otherwise be
   * invisible there: `aiRunStore` is per-webview, and the backend's `ai:*` events say what a run is
   * *printing*, never that it began. So the window that starts one announces it and every other
   * window registers the same run — which is exactly right, because the run itself is in the Rust
   * process and the `ai:output-batch` events already reach every window. The main window therefore
   * ends up with a real entry, not a placeholder: it names the run, fills with its output, and its
   * stop button works, because cancelling is addressed to the backend by run id.
   *
   * `about` is `AiRunAbout` — plain data throughout, which is what lets it cross the boundary.
   */
  | { kind: "run-started"; runId: string; about: AiRunAbout | null }
  | { kind: "run-finished"; runId: string }
  /**
   * Advance this chain, please.
   *
   * Only the main window runs the agent-chain executor (`chainStore.pump`), because two executors
   * claim the same step twice. A satellite that has a reason to advance one — its Agents view has
   * a "start" button and a gate to approve — says so here instead of doing it.
   */
  | { kind: "pump"; chainId: string }
  /**
   * Inline completion is thinking somewhere.
   *
   * Smaller than a run and tracked differently: it has no id worth carrying, it lasts a few hundred
   * milliseconds, and what the status bar draws for it is one orb. So the message is a level rather
   * than an event, and the main window counts how many *other* windows are currently busy. A window
   * that closes mid-completion would otherwise leave the count stuck at one, which is why the count
   * is per window label rather than a number.
   */
  | { kind: "completion"; busy: boolean }
  /** A satellite asking the main window to bring itself forward — what "re-attach" does before the
   *  satellite closes, so the thing that was in it is on screen rather than merely somewhere. */
  | { kind: "focus-main" };

interface Frame {
  from: string;
  message: WindowMessage;
}

/** Sends to every other window. Never throws: a bus message is never the point of the action that
 *  raised it, and a failed emit must not take the caller's own work down with it. */
export function broadcast(message: WindowMessage): void {
  void emit(CHANNEL, { from: WINDOW.label, message } satisfies Frame).catch(() => {});
}

/**
 * Receives what the other windows send. Returns the unsubscribe, which resolves only once the
 * listener is actually attached — so a caller that unsubscribes immediately still tears down.
 *
 * `from` is the sending window's label. Most handlers ignore it; the ones that keep per-window
 * state need it, because "one window is busy" and "the same window said so twice" are different
 * facts and a plain counter cannot tell them apart.
 */
export function onWindowMessage(
  handler: (message: WindowMessage, from: string) => void,
): () => void {
  let stop: (() => void) | null = null;
  let cancelled = false;

  void listen<Frame>(CHANNEL, (event) => {
    // Our own message, handed back by Tauri. Dropping it here rather than at each call site is what
    // keeps "the main window broadcasts the workspace it just switched to" from being a loop.
    if (event.payload.from === WINDOW.label) return;
    handler(event.payload.message, event.payload.from);
  })
    .then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    stop?.();
  };
}
