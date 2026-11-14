import { listen } from "@tauri-apps/api/event";
import { isMainWindow } from "./windowIdentity";
import { collabTakeJoinLink } from "./tauri/collabCommands";
import { useSharedChatStore } from "../state/sharedChatStore";

/**
 * `codeflow://chat-join?…` links opened from outside: an invitation to a shared workspace chat.
 * The backend holds the link and says one arrived; the main window takes it and shows the join
 * dialog, which previews it and joins nothing until the person picks a nick and says so. Also taken
 * once at start, for the link that launched the app. Same shape as `lib/db/shareLinks.ts`.
 */
let started = false;

async function take(): Promise<void> {
  const link = await collabTakeJoinLink().catch(() => null);
  if (link) useSharedChatStore.setState({ pendingJoin: link });
}

export function startSharedChatLinks(): void {
  if (started || !isMainWindow()) return;
  started = true;
  void listen("collab:join-link", () => void take());
  void take();
}
