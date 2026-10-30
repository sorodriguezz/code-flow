import { userErrorClassify } from "./tauri/commands";
import { writeClipboardText } from "./clipboard";

/**
 * What «Copiar detalle» puts on the clipboard: the reference code the backend classifier gave the
 * failure (safe to paste into a report) on its own line, then the message. Nothing else.
 */
export function errorDetailText(message: string, reference: string | null | undefined): string {
  const code = reference?.trim();
  return code ? `${code}\n${message}` : message;
}

/**
 * Classifies lazily — only when the user asks to copy, never when the toast mounts — and falls back
 * to the bare message when the classifier is unavailable. Resolves once the text is on the clipboard.
 */
export async function copyErrorDetail(message: string): Promise<void> {
  let reference: string | null = null;
  try {
    reference = (await userErrorClassify(message)).reference;
  } catch {
    reference = null;
  }
  await writeClipboardText(errorDetailText(message, reference));
}
