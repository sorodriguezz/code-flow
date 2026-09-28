import { terminalForeground } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { translate } from "../../state/languageStore";

/**
 * Whether a terminal tab may close — asking first when something other than its shell is running.
 *
 * Closing a tab ends everything it started (see `terminal::end_session`), so a dev server or a build
 * left running in it goes with it. A shell at its prompt closes without a word, the way every
 * terminal closes one; a busy one names what would be stopped. An answer the backend cannot give
 * (the session already gone) is not a reason to keep the tab.
 */
export async function confirmCloseTerminal(sessionId: string): Promise<boolean> {
  const busy = await terminalForeground(sessionId).catch(() => null);
  if (busy === null || busy === undefined) return true;
  const message = busy ? translate("terminal.closeBusy", { name: busy }) : translate("terminal.closeBusyUnnamed");
  return confirmAction(message, true, translate("terminal.closeAnyway"));
}
