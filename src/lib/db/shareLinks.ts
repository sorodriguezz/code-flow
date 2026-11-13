import { listen } from "@tauri-apps/api/event";
import { isMainWindow } from "../windowIdentity";
import { dbTakeSharedCredentialLink } from "../tauri/dbCommands";
import { useUiStore } from "../../state/uiStore";
import { useDbModalStore } from "../../state/dbModalStore";

/**
 * `codeflow://connection?…` links opened from outside — a shared connection clicked in a chat.
 *
 * The backend holds the link (it may carry a password, and an event reaches every window) and says
 * one arrived; the main window takes it and opens the import dialog on the database workspace,
 * which previews it and saves nothing until the user says so. Also taken once at start, for the
 * link that launched the app.
 */
let started = false;

async function take(): Promise<void> {
  const link = await dbTakeSharedCredentialLink().catch(() => null);
  if (!link) return;
  useUiStore.getState().openApiWorkspace("database");
  useDbModalStore.getState().openDbModal({ kind: "importConnection", text: link });
}

/** Starts listening, once, in the main window. Returns nothing to undo: it lives as long as the app. */
export function startConnectionShareLinks(): void {
  if (started || !isMainWindow()) return;
  started = true;
  void listen("db:connection-link", () => void take());
  void take();
}
