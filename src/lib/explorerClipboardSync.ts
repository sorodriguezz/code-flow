import {
  explorerClipboardSnapshot,
  useExplorerClipboardStore,
} from "../state/explorerClipboardStore";
import { broadcast, onWindowMessage } from "./windowBus";

/**
 * Keeps every window's explorer clipboard equal — a Copy in a floating editor pastes in the main
 * window, and the other way round.
 *
 * Each webview has its own `explorerClipboardStore`. Every change made here is broadcast whole; a
 * change from another window is `adopt`ed (the newest `at` wins) with the broadcast held off, so it
 * is never sent straight back. A window that starts listening asks the others what they hold, so a
 * window opened after the Copy still pastes it.
 *
 * Started by the explorer itself (`FileTree`), once per window: a window without a file tree has
 * nothing to paste into, and starts listening the first time it shows one.
 */

let started = false;
let adopting = false;

export function startExplorerClipboardSync(): void {
  if (started) return;
  started = true;

  onWindowMessage((message) => {
    if (message.kind === "explorer-clipboard") {
      adopting = true;
      try {
        useExplorerClipboardStore.getState().adopt(message.clip);
      } finally {
        adopting = false;
      }
    } else if (message.kind === "explorer-clipboard-ask") {
      const clip = explorerClipboardSnapshot();
      if (clip.at > 0) broadcast({ kind: "explorer-clipboard", clip });
    }
  });

  useExplorerClipboardStore.subscribe((state, prev) => {
    if (adopting) return;
    if (
      state.at === prev.at &&
      state.systemStamp === prev.systemStamp &&
      state.paths === prev.paths &&
      state.mode === prev.mode &&
      state.repoPath === prev.repoPath
    ) {
      return;
    }
    broadcast({ kind: "explorer-clipboard", clip: explorerClipboardSnapshot() });
  });

  broadcast({ kind: "explorer-clipboard-ask" });
}
