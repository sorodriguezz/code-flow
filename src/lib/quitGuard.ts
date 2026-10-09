import { listen } from "@tauri-apps/api/event";
import { quitAppConfirmed, quitGuardAck, quitGuardArm, quitGuardCancel } from "./tauri/commands";
import { showMainWindow } from "./tauri/windows";
import { flowsArmedNames } from "./tauri/flowsCommands";
import { meetingsStatus } from "./tauri/meetingsCommands";
import { broadcast, onWindowMessage } from "./windowBus";
import { collectUnsaved, discardAllUnsaved, saveAllUnsaved, type UnsavedItem } from "./unsavedWork";
import { chooseAction } from "../state/confirmStore";
import { translate } from "../state/languageStore";
import { pushErrorToast } from "../state/toastStore";
import { useWindowStore } from "../state/windowStore";

/**
 * The main window's half of the quit question — the Rust half, and why it holds the quit at all, is
 * `quit_guard.rs`.
 *
 * When a quit the user asked for is waiting, this looks at everything unsaved — this window's own
 * registry (`lib/unsavedWork.ts`) and the last list each satellite reported — and either quits at
 * once, when there is nothing, or brings the window forward and asks: save it all and quit, quit
 * without it, or stay. Nothing unsaved costs the user nothing: no window is shown, no question
 * asked, the tray's Quit is as instant as it always was.
 *
 * Main window only — `App` installs it. The satellites answer to it rather than asking themselves:
 * a quit ends every window at once, and one question is the right number.
 */

/** How long a satellite gets to save its buffers when "save all" asks it to, before its files are
 *  reported as not saved — which keeps the app open, so waiting too little costs a retry, never
 *  work. */
const SATELLITE_SAVE_MS = 15_000;

/** How long a satellite gets to clear its crash journal on "quit without saving". */
const SATELLITE_DISCARD_MS = 2_000;

/** How many unsaved items the question lists before counting the rest. */
const LISTED = 8;

function describe(item: UnsavedItem): string {
  return item.detail ? `${item.label} — ${item.detail}` : item.label;
}

/** Installs the listener and tells the backend it is answered. Returns the teardown. */
export function installQuitGuard(): () => void {
  /** The last list each satellite reported, by window label. */
  const satellites = new Map<string, UnsavedItem[]>();
  /** Replies still owed by satellites, by request id. One listener for all of them, attached now,
   *  so a reply that comes back fast can never beat a listener still being attached. */
  const replies = new Map<string, (failed: string[]) => void>();
  const stopBus = onWindowMessage((message, from) => {
    if (message.kind === "unsaved-state") {
      if (message.items.length > 0) satellites.set(from, message.items);
      else satellites.delete(from);
    } else if (message.kind === "unsaved-done") {
      replies.get(message.requestId)?.(message.failed);
    }
  });
  // After a reload of this window the map starts empty, while the satellites' buffers did not.
  broadcast({ kind: "unsaved-refresh" });

  const ask = (label: string, kind: "unsaved-save" | "unsaved-discard", timeoutMs: number) =>
    new Promise<string[]>((resolve) => {
      const requestId = crypto.randomUUID();
      const settle = (failed: string[]) => {
        clearTimeout(timer);
        replies.delete(requestId);
        resolve(failed);
      };
      const timer = setTimeout(
        () => settle(kind === "unsaved-save" ? (satellites.get(label) ?? []).map(describe) : []),
        timeoutMs,
      );
      replies.set(requestId, settle);
      broadcast({ kind, to: label, requestId });
    });

  let asking = false;

  const onQuitRequested = async () => {
    // First, before anything is looked at: it is what tells the backend this window is alive.
    void quitGuardAck().catch(() => {});
    // ⌘Q again while the question is up brings it forward; it never stacks a second one.
    if (asking) {
      void showMainWindow().catch(() => {});
      return;
    }
    asking = true;
    try {
      // A satellite that has closed since it reported took its buffers with it.
      const open = new Set(useWindowStore.getState().satellites.map((s) => s.label));
      for (const label of [...satellites.keys()]) if (!open.has(label)) satellites.delete(label);
      // A meeting being recorded stops with the app. What was recorded is kept and finished at the
      // next launch (`meetings_cmd::shutdown`), but a quit in the middle of a call is worth a word.
      const recording = await meetingsStatus()
        .then((status) => status.recording)
        .catch(() => null);
      if (recording) {
        await showMainWindow().catch(() => {});
        const answer = await chooseAction({
          message: translate("quit.meetingMessage"),
          danger: true,
          choices: [{ id: "quit", label: translate("quit.meetingQuit"), variant: "danger" }],
        });
        if (answer !== "quit") {
          await quitGuardCancel();
          return;
        }
      }
      // Active flows stop listening when the process ends — a schedule at 03:00 will not run. Asked
      // before the unsaved work, and only when there are some: most quits have none.
      const armed = await flowsArmedNames().catch(() => [] as string[]);
      if (armed.length > 0) {
        await showMainWindow().catch(() => {});
        const answer = await chooseAction({
          message: translate("quit.flowsMessage", { n: armed.length }),
          items: armed.length > LISTED ? [...armed.slice(0, LISTED), translate("quit.andMore", { n: armed.length - LISTED })] : armed,
          danger: true,
          choices: [{ id: "quit", label: translate("quit.flowsQuit"), variant: "danger" }],
        });
        if (answer !== "quit") {
          await quitGuardCancel();
          return;
        }
      }
      const lines = [...collectUnsaved(), ...[...satellites.values()].flat()].map(describe);
      if (lines.length === 0) {
        await quitAppConfirmed();
        return;
      }
      // The tray's Quit is pressed with the window hidden, and a question in a hidden window is a
      // quit that silently does nothing.
      await showMainWindow().catch(() => {});
      const answer = await chooseAction({
        message: translate("quit.unsavedMessage", { n: lines.length }),
        items:
          lines.length > LISTED
            ? [...lines.slice(0, LISTED), translate("quit.andMore", { n: lines.length - LISTED })]
            : lines,
        danger: true,
        choices: [
          { id: "save", label: translate("quit.saveAndQuit"), variant: "primary" },
          { id: "discard", label: translate("quit.discardAndQuit"), variant: "danger" },
        ],
      });
      if (answer === "save") {
        const failed = [...(await saveAllUnsaved())];
        for (const label of satellites.keys()) failed.push(...(await ask(label, "unsaved-save", SATELLITE_SAVE_MS)));
        if (failed.length > 0) {
          // Staying open is the only safe answer to a save that did not happen: the buffers are
          // still here, and the toast says which.
          pushErrorToast(translate("quit.saveFailed", { names: failed.join(", ") }));
          await quitGuardCancel();
          return;
        }
        await quitAppConfirmed();
      } else if (answer === "discard") {
        await discardAllUnsaved();
        await Promise.all([...satellites.keys()].map((label) => ask(label, "unsaved-discard", SATELLITE_DISCARD_MS)));
        await quitAppConfirmed();
      } else {
        await quitGuardCancel();
      }
    } catch (e) {
      pushErrorToast(String(e));
      await quitGuardCancel().catch(() => {});
    } finally {
      asking = false;
    }
  };

  let disposed = false;
  let stopQuit: (() => void) | null = null;
  void listen("app:quit-requested", () => void onQuitRequested())
    .then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      stopQuit = unlisten;
      // Armed only once the listener is attached: until then a quit must go straight through,
      // since nothing here would hear the question.
      void quitGuardArm(true).catch(() => {});
    })
    .catch(() => {});

  return () => {
    disposed = true;
    stopQuit?.();
    stopBus();
    void quitGuardArm(false).catch(() => {});
  };
}
