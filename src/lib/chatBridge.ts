import { focusSatellite, showMainWindow } from "./tauri/windows";
import { broadcast } from "./windowBus";
import { isMainWindow, MAIN_LABEL, WINDOW } from "./windowIdentity";
import { useUiStore } from "../state/uiStore";
import { useWindowStore } from "../state/windowStore";

/**
 * The bridge between a conversation and whichever window holds the chat workspace.
 *
 * Written for the ask box's *Open in CodeFlow*, which is the one place in the app where a
 * conversation is created in a window that is about to disappear. Everything else that selects a
 * conversation is already standing in the workspace that lists it.
 *
 * # Why the press needs a bridge at all
 *
 * Each window holds its own `conversationStore`. A question asked from the hotkey box writes a real
 * row to SQLite — that is the whole point of the quick ask being a conversation rather than a
 * scratchpad — but the store that would *show* it lives in another webview and was listed before
 * the row existed. So the button used to bring the main window forward and stop there: the app
 * arrived showing whatever it had been showing, and the conversation was somewhere in a sidebar
 * that had not been re-read. Detaching the chat onto its own window made it appear, because that
 * window booted and listed fresh — and closing that window put it out of sight again, for exactly
 * the same reason in reverse.
 *
 * # Where it opens
 *
 * The same rule `dbmlBridge` follows, and it is the satellite design's first invariant: wherever
 * the chat workspace already is. Detached onto its own window, that window gets it and comes
 * forward; otherwise the main window shows it on the rail. Opening a second copy in the shell would
 * be the duplication the whole multi-window design rules out.
 */

/** The rail id the chat workspace is detached under — its window is `sat-app-chat`. The same string
 *  `AppRail` builds its button from and `SatelliteApp`'s `APP_VIEWS` keys on. */
const CHAT_APP_ID = "chat";

/**
 * Selects a conversation in *this* window, bringing the chat workspace up around it.
 *
 * The receiving end of the routing below, and also the local path when the chat workspace is
 * already here.
 *
 * No workspace is switched, unlike the diagram bridge: the conversation list is flat and global
 * (see `ConversationSidebar`), so a conversation asked in one workspace is an ordinary row of the
 * list in every other. `open` re-lists when it has never heard of the conversation, which is the
 * normal case here — the row was written by the window that just handed it over.
 */
export async function showChatHere(conversationId: string): Promise<void> {
  // Imported here rather than at the top of the file, because this module is reached from *both*
  // entry points — `App` and `SatelliteApp` both listen for the message — and a static edge from an
  // entry is what pulls a module into that entry's first load. A Remote or vault window will never
  // open a conversation, and `window.html` exists so it does not carry the machinery for one.
  // `dbmlBridge` reaches `diagramsStore` the same way, for the same reason.
  const { useConversationStore } = await import("../state/conversationStore");
  // In the main window the chat is one app of several on the rail, so it has to be brought up — and
  // this is also what mounts the view the first time, since `App` never mounts a view nobody has
  // visited. In the chat satellite `activeView` is fixed by the window's identity and this is a
  // no-op on it.
  if (isMainWindow()) useUiStore.getState().setActiveView("chat");
  await useConversationStore.getState().open(conversationId);
}

/**
 * Puts a conversation on screen in the window that owns the chat workspace, whichever that is.
 *
 * Never throws: this is what a button press calls, and the conversation is on disk either way — the
 * worst case is the user finding it at the top of the sidebar themselves, which is where the list's
 * recency order already puts it.
 */
export async function openConversationInApp(conversationId: string): Promise<void> {
  const detached = useWindowStore.getState().detachedLabel("app", CHAT_APP_ID);

  // The chat on its own desk wins, and it is the window the user has already said is where chats
  // happen.
  if (detached && detached !== WINDOW.label) {
    broadcast({ kind: "open-chat", to: detached, conversationId });
    try {
      await focusSatellite(detached);
      return;
    } catch {
      /*
       * That window has gone since the satellite list reached this one, and the addressed frame
       * above was therefore delivered to nobody.
       *
       * Falling through rather than returning, which is the whole reason this is a `try` and not a
       * `.catch(() => {})`. A press that routes to a window which no longer exists has to land
       * *somewhere*: swallowing the failure here would leave the user looking at an ask box that
       * said "Open in CodeFlow", did nothing visible, and gave no hint that the conversation was
       * saved. The shell can always show it, so the shell is the fallback.
       */
    }
  }

  if (isMainWindow() || detached === WINDOW.label) {
    await showChatHere(conversationId);
    return;
  }

  // Any other window — the ask box, a repository window — has no chat workspace of its own to show
  // this in. The main window does, and bringing it forward is what makes the press read as "it
  // opened over there" rather than as nothing having happened.
  broadcast({ kind: "open-chat", to: MAIN_LABEL, conversationId });
  // Not the `focus-main` message, which is the main window calling `setFocus()` on itself and is
  // the right amount of work only when that window is already on screen. The ask box is routinely
  // used with the desk hidden in the tray — `close_all` spares this one window precisely so the
  // hotkey keeps working after the main window is put away — and a `setFocus` on a hidden window
  // raises nothing, which is the other half of "it opened and I saw nothing".
  await showMainWindow().catch(() => {
    // The conversation is filed and the message is out either way. A restore that failed costs the
    // user a click on the tray, not the thread.
  });
}
