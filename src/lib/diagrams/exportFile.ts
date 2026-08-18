import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFileBytes } from "../tauri/commands";

/**
 * Getting a diagram out of the app, and a `.drawio` file into it.
 *
 * **Everything here goes through a file dialog the user drives.** A desktop app writing where it
 * likes is a desktop app people stop trusting, and the dialog is also what supplies the extension —
 * so there is no guessing about which format was meant.
 *
 * The export itself is done by the editor (`{ action: "export" }`), which answers with a `data:`
 * URI; this module's job is turning that into bytes and putting them somewhere.
 */

/** What a diagram can be saved as. */
export type ExportFormat = "png" | "svg" | "pdf" | "drawio";

/** The dialog's filter and the extension, per format. */
const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  png: { name: "PNG", extensions: ["png"] },
  svg: { name: "SVG", extensions: ["svg"] },
  pdf: { name: "PDF", extensions: ["pdf"] },
  drawio: { name: "draw.io", extensions: ["drawio", "xml"] },
};

/**
 * Bytes from a `data:` URI.
 *
 * draw.io answers every export as one, base64 or percent-encoded depending on the format, so both
 * are handled rather than assuming the shape of the one that was tested first.
 */
export function bytesFromDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma === -1) {
    throw new Error("Not a data URI");
  }
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  if (meta.endsWith(";base64")) {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/**
 * Asks where to put a file and writes it. `false` if the dialog was dismissed.
 *
 * `defaultPath` carries the diagram's title so the saved file is named after it rather than after
 * whatever the last save was called.
 */
export async function saveBytes(
  bytes: Uint8Array,
  format: ExportFormat,
  suggestedName: string,
): Promise<boolean> {
  const filter = FILTERS[format];
  const path = await save({
    defaultPath: `${safeFileName(suggestedName, "diagram")}.${filter.extensions[0]}`,
    filters: [filter],
  });
  if (!path) return false;
  await writeFileBytes(path, bytes);
  return true;
}

/**
 * Opens a `.drawio` file and returns its text, or `null` if the dialog was dismissed.
 *
 * The read goes through `diagrams_read_drawio` rather than a general "read any file" command,
 * deliberately: a narrow command that only reads what a file dialog just handed back is a much
 * smaller capability to have added to the app than a general one.
 */
export async function openDrawioFile(): Promise<{ name: string; xml: string } | null> {
  const picked = await open({ multiple: false, filters: [FILTERS.drawio] });
  if (typeof picked !== "string") return null;
  const { diagramsReadDrawio } = await import("../tauri/diagramsCommands");
  const xml = await diagramsReadDrawio(picked);
  const name = picked.split(/[\\/]/).pop() ?? "diagram";
  return { name: name.replace(/\.(drawio|xml)$/i, ""), xml };
}

/**
 * A title made safe for a filename.
 *
 * The characters Windows refuses, the path separators — which are the ones that turn a save into a
 * write somewhere else entirely — and the control range. Spaces and hyphens are deliberately kept:
 * stripping them turns "Pipeline de review" into one unreadable word. Trimmed and capped, because
 * a title can be a sentence.
 *
 * The fallback is a parameter rather than the constant it used to be, because the second caller is
 * not saving a diagram: `lib/icons/profileFile.ts` names its file after an icon profile, and an
 * untitled one landing as "diagram.json" would be a lie about what is inside it. Exported rather
 * than copied there for the obvious reason — two sanitisers is two answers to "is a colon legal",
 * and only one of them gets fixed the day it turns out not to be.
 */
export function safeFileName(title: string, fallback: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  return (cleaned || fallback).slice(0, 80);
}
