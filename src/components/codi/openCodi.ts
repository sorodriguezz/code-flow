import { codiOpenWindow } from "../../lib/tauri/codiCommands";
import { pushErrorToast } from "../../state/toastStore";

/** Opens Codi's window, or brings it forward — from the rail's mark held down, `codi.open`, the
 *  status bar's «Codi escucha» and Settings. */
export function openCodi(): void {
  void codiOpenWindow().catch((error: unknown) => pushErrorToast(String(error)));
}
