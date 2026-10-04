import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WINDOW } from "./windowIdentity";
// Type-only: this module must stay a leaf, or the store that imports it to broadcast would import
// it back through this line.
import type { AiRunAbout } from "../state/aiRunStore";
import type { UnsavedItem } from "./unsavedWork";
import type { IslandTab } from "./editorIslands";

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
 * What it cannot carry is the state that was never written down. Which model is running right now
 * is a fact about this process, not about SQLite. That is what this is for, and the list is
 * deliberately short — anything that *could* be a row should be a row.
 *
 * **The workspace used to be on here and is not any more.** Every window now holds its own, chosen
 * in its own title bar and recorded under its own settings key (`workspaceStore`'s `windowKey`), so
 * there is nothing to tell anybody: a satellite no longer follows the main window, and a fresh one
 * picks up its opening position from the stored setting rather than from a message.
 *
 * # Every window hears its own emit
 *
 * Tauri's `emit` goes to every window including the sender. Handing a window back its own message
 * is how a broadcast would become an infinite round trip, so every frame carries the label it came
 * from and [`onWindowMessage`] drops the ones this window sent. Nothing downstream has to remember
 * to check.
 */

/** The one event name. One channel with a `kind` inside beats one Tauri listener per message type:
 *  each `listen` is an IPC subscription, and there is no ordering guarantee between two of them. */
const CHANNEL = "windows:bus";

/** What the windows say to each other. Adding a case here is a deliberate act — see the note. */
export type WindowMessage =
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
  | { kind: "focus-main" }
  /**
   * Put this diagram on screen, please.
   *
   * The one message that asks another window to *show* something, which is why it is worth being
   * precise about what it is not: it is not a window following another one. It is a user pressing
   * "open this schema in Diagrams" in the editor, where the Diagrams app happens to live in a
   * different window — the detached one if there is one, the main window otherwise. Nobody sends
   * this except in answer to that press. See `lib/dbmlBridge.ts`.
   *
   * The workspace travels with the id because a diagram id means nothing without one: the
   * receiving window holds its own workspace (invariant 3), and being handed a diagram from
   * another one has to move it rather than draw an empty gallery. That is a choice the user just
   * made, not a window following, which is why the receiver records it.
   *
   * **`to` is required, and it is the only addressed message on this bus.** Every other frame here
   * is an announcement — "a run started", "completion is thinking" — which every window is entitled
   * to act on. This one is an instruction, and exactly one window may carry it out: with the
   * Diagrams app detached, an unaddressed frame would be obeyed by the satellite *and* by the shell,
   * which would then draw a second Diagrams view over the rail it had already handed away. The
   * label is `MAIN_LABEL` or a satellite's; a window whose label does not match drops it.
   */
  | { kind: "open-diagram"; to: string; workspaceId: string; diagramId: string }
  /**
   * Put this conversation on screen, please.
   *
   * What "Open in CodeFlow" in the ask box actually does. Before it, that button broadcast
   * `focus-main` and nothing else: the main window came forward still showing whatever it was
   * showing, with a sidebar listed before the conversation existed — so the one gesture the quick
   * ask offers for "keep this" landed on a window that had never heard of it.
   *
   * **Addressed, for the same reason `open-diagram` is.** With the chat app detached onto its own
   * window, an unaddressed frame would be obeyed by that window *and* by the shell, and the shell
   * would draw a second chat over the rail it has already handed away.
   *
   * No workspace travels with the id, and that is the one way it differs from `open-diagram`: the
   * conversation list is flat and global on purpose (see `ConversationSidebar`), so a conversation
   * is addressable by its own id from any workspace and the receiving window has nowhere to move
   * to.
   */
  | { kind: "open-chat"; to: string; conversationId: string }
  /**
   * What a satellite has unsaved, sent whenever the set changes — see `lib/unsavedWork.ts`.
   *
   * Never a row, which is why it rides here: an editor buffer nobody saved exists only in the
   * webview holding it. The main window keeps the last list per window, because it is the one that
   * asks before a quit, and a satellite's buffers die with the process like anything else.
   */
  | { kind: "unsaved-state"; items: UnsavedItem[] }
  /** The main window asking every satellite to send its list again — after a reload of its own. */
  | { kind: "unsaved-refresh" }
  /**
   * "Save what you listed" / "the user chose to lose it", addressed to one satellite and answered
   * with `unsaved-done` — waited for, because the process ends right after: a discard is the
   * satellite clearing its crash journal, and that write has to land first.
   */
  | { kind: "unsaved-save" | "unsaved-discard"; to: string; requestId: string }
  /** The answer to either: the labels that could not be saved (always empty for a discard). */
  | { kind: "unsaved-done"; requestId: string; failed: string[] }
  /*
   * A floating editor and the main window handing one file between them — see `lib/editorIslands`
   * for the whole protocol. All of these are *sent* (`sendTo`) rather than broadcast: each has
   * exactly one window that may act on it, and two of them carry a whole file's text, which every
   * other window has no business receiving.
   */
  /** A floating editor that has just opened, asking the main window for its file's buffer. */
  | { kind: "island-claim"; requestId: string; projectId: string; path: string }
  /** The main window's answer: the tab as it was there, or `null` when it was not open — the
   *  floating editor then reads the file from disk. */
  | { kind: "island-handoff"; requestId: string; tab: IslandTab | null }
  /** "I have it": the main window drops the copy it kept until the buffer was safely across. */
  | { kind: "island-taken"; ref: string }
  /** A floating editor closing, giving its tab back. `reveal` is the title bar's "return" button:
   *  the main window also comes forward on that file. */
  | {
      kind: "island-return";
      requestId: string;
      projectId: string;
      repoPath: string;
      tab: IslandTab;
      reveal: boolean;
    }
  /** The main window has the returned tab — only then may the floating editor go. */
  | { kind: "island-returned"; requestId: string }
  /** Open another file of the repository in the main window — a go-to-definition from a floating
   *  editor, which holds its one file and nothing else. */
  | { kind: "island-open"; projectId: string; path: string; line?: number; column?: number }
  /** Jump to a line in a floating editor, when an open in the main window landed on its file. */
  | { kind: "island-reveal"; line: number; column?: number }
  /** The file a floating editor holds was moved (`movedTo`) or deleted (`null`) from the main
   *  window's explorer. */
  | { kind: "island-recall"; movedTo: string | null };

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
 * Sends to one window only — `MAIN_LABEL` or a satellite's label.
 *
 * For the messages exactly one window may act on, and above all for the ones that carry a file's
 * text: `emit` evaluates the payload in every webview, `emitTo` only in the one it names. Resolves
 * once the backend has it, which is what a window about to close waits for; rejects when it could
 * not be sent, so a caller that must know (a buffer on its way out) can keep it instead.
 */
export function sendTo(label: string, message: WindowMessage): Promise<void> {
  return emitTo(label, CHANNEL, { from: WINDOW.label, message } satisfies Frame);
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

/**
 * [`onWindowMessage`], resolving only once the listener is attached.
 *
 * For a question whose answer must not be missed: ask before the listener is in place and a fast
 * answer arrives to nobody. The floating editor's claim on its buffer is the case — an answer lost
 * there is a file read from disk while its unsaved text sits forgotten in the main window.
 */
export async function listenWindowMessages(
  handler: (message: WindowMessage, from: string) => void,
): Promise<() => void> {
  const unlisten = await listen<Frame>(CHANNEL, (event) => {
    if (event.payload.from === WINDOW.label) return;
    handler(event.payload.message, event.payload.from);
  });
  return () => void unlisten();
}
