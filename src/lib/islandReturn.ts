import { getCurrentWindow } from "@tauri-apps/api/window";
import { broadcast } from "./windowBus";
import { useFileIslandStore } from "./editorIslands";
import { WINDOW } from "./windowIdentity";

/**
 * Sends this window's contents back to the main window: bring that one forward, then close this.
 * The order matters — closing first leaves the desk showing whatever was behind, which reads as
 * the thing having been thrown away rather than put back.
 *
 * A floating editor's contents are a buffer, which has to *arrive* before the window may go —
 * its editor does the handing over (`giveBack`) and closes the window once the main window has
 * the file, coming forward on it. Before the editor is up there is nothing in here to hand over:
 * the main window still holds the file, and closing is enough.
 *
 * There is no backend command for this, and none is needed: every way back ends in the window being
 * destroyed, which `windowStore` in the main window hears as the island coming home. Out of
 * `SatelliteTitleBar` because «Codi» returns islands too, and has to take exactly this path — a
 * second one that skipped `giveBack` would close a floating editor with its edits still in it.
 *
 * A no-op in the main window, which is not an island and has nowhere to go back to.
 */
export function returnThisIsland(): void {
  if (WINDOW.main) return;
  const giveBack = WINDOW.satellite?.kind === "file" ? useFileIslandStore.getState().giveBack : null;
  if (giveBack) {
    void giveBack(true);
    return;
  }
  broadcast({ kind: "focus-main" });
  void getCurrentWindow().close();
}
