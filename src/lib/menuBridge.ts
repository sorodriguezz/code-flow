/**
 * What the macOS menu bar's items actually do.
 *
 * The menu itself is built in Rust (`appmenu.rs`) because AppKit resolves menu key equivalents —
 * ⌘, ⌘X ⌘V — before the webview ever sees the keystroke, so the items have to exist there. What
 * they *mean* lives here, because the app already knows how to open its own settings, start its own
 * tour and check for its own updates, and a second implementation in Rust would be a second thing
 * to keep in step with the first.
 *
 * One listener for the whole menu rather than one per item: the payload is the item's id, and a
 * `switch` in one place is easier to keep honest than six subscriptions.
 */

import { listen } from "@tauri-apps/api/event";
import { openExternalUrl } from "./tauri/commands";
import { pushErrorToast } from "../state/toastStore";
import { useUiStore } from "../state/uiStore";
import { useUpdateStore } from "../state/updateStore";
import { useTourStore } from "../state/tourStore";

/** Where "Documentation" and "Report an Issue" go. */
const REPO_URL = "https://github.com/sorodriguezz/code-flow";

export function listenToAppMenu(): Promise<() => void> {
  return listen<string>("cf://menu", ({ payload }) => {
    switch (payload) {
      case "settings":
        // The last section the user was on, not a fixed one: ⌘, means "the settings window", and
        // deciding for them which page of it is a small rudeness the app has no reason to commit.
        useUiStore.getState().openSettings(useUiStore.getState().settingsSection);
        break;
      case "check-updates":
        // `true` is what makes it say "you are up to date" — the periodic check stays quiet, and a
        // menu item the user pressed on purpose that answers with silence reads as broken.
        void useUpdateStore.getState().checkNow(true);
        break;
      case "shortcuts":
        useUiStore.getState().toggleShortcutsModal();
        break;
      case "tour":
        useTourStore.getState().start();
        break;
      case "docs":
        void openExternalUrl(REPO_URL).catch((e: unknown) => pushErrorToast(String(e)));
        break;
      case "report-issue":
        void openExternalUrl(`${REPO_URL}/issues/new`).catch((e: unknown) => pushErrorToast(String(e)));
        break;
      default:
        // "reveal-logs" and "quit" never reach here — Rust handles both and returns before
        // emitting. An unknown id is a menu item added there and not here, which is worth ignoring
        // quietly rather than throwing inside an event handler.
        break;
    }
  });
}
