import { clipboardReadText, clipboardWriteText } from "./tauri/commands";

/**
 * Text to and from the clipboard: the webview's own first, the system's when the webview says no.
 *
 * WebKit allows `navigator.clipboard` only inside what it counts as a user gesture. A copy that runs
 * a tick after the mouse-up — the terminal's copy-on-select, which has to wait for xterm to finish
 * the selection — is outside it, and so is a read whose "Paste" bubble the user dismissed: both
 * reject with `NotAllowedError`. The native path (`clipboard_text.rs`) has no such rule, so a refusal
 * there is a real failure and is what reaches the caller.
 */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    await clipboardWriteText(text);
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return clipboardReadText();
  }
}
