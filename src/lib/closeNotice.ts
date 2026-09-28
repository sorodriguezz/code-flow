import { listen } from "@tauri-apps/api/event";
import { quitApp, setSetting } from "./tauri/commands";
import { hideMainToTray } from "./tauri/windows";
import { chooseAction } from "../state/confirmStore";
import { translate } from "../state/languageStore";
import { pushErrorToast } from "../state/toastStore";

/** `tray::TRAY_NOTICE_KEY`. */
const NOTICE_KEY = "tray_notice_seen";

/**
 * The first close of the main window, answered here: the backend holds it (`tray::close_action`)
 * and asks this window to say where the app is going before it goes.
 *
 * It used to go without a word — the window vanished, the app kept running in the tray, and nothing
 * on screen said either thing. The notice says so once, offers to quit instead, and names the
 * setting that decides it for good. "Keep in the tray" hides exactly as the button would have;
 * closing the question leaves the window where it is. Main window only — `App` installs it.
 */
export function installCloseNotice(): () => void {
  let asking = false;
  const ask = async () => {
    if (asking) return;
    asking = true;
    try {
      const answer = await chooseAction({
        message: translate("tray.closeNotice"),
        choices: [
          { id: "hide", label: translate("tray.closeNoticeKeep"), variant: "primary" },
          { id: "quit", label: translate("settings.quitApp"), variant: "secondary" },
        ],
      });
      if (answer === "hide") {
        await hideMainToTray();
      } else if (answer === "quit") {
        await setSetting(NOTICE_KEY, "1");
        // Through the quit guard like every other quit: unsaved work is asked about first.
        await quitApp();
      }
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      asking = false;
    }
  };

  let disposed = false;
  let stop: (() => void) | null = null;
  void listen("app:close-notice", () => void ask())
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    stop?.();
  };
}
