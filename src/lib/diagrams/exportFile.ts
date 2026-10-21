import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFileBytes } from "../tauri/commands";
import { FORMAT_ARCHIFY, FORMAT_DBML, FORMAT_EXCALIDRAW, FORMAT_MERMAID, FORMAT_MXGRAPH } from "./doc";
import { archifyDocKind, isArchifyHtml } from "./archify/ir";
import { translate } from "../../state/languageStore";
import type { DiagramFormat } from "../../types/diagrams";

/**
 * Getting a diagram out of the app, and a `.drawio`, `.dbml`, `.excalidraw` or archify file into it.
 *
 * **Everything here goes through a file dialog the user drives.** A desktop app writing where it
 * likes is a desktop app people stop trusting, and the dialog is also what supplies the extension —
 * so there is no guessing about which format was meant.
 *
 * The export itself is done by the editor (`{ action: "export" }`), which answers with a `data:`
 * URI; this module's job is turning that into bytes and putting them somewhere.
 */

/**
 * What a diagram can be saved as.
 *
 * Everything past the three pictures is a document rather than a picture, and each belongs to one
 * format: `.drawio` is the mxGraph dialect, `.dbml` the schema one, `.excalidraw` the whiteboard's,
 * and an archify map leaves as its interactive page (`html`) or as the `.architecture.json` archify's
 * own CLI renders (`archify`). A diagram is only ever offered the ones its own format is written in
 * — see `DiagramsView`'s export menus, which are built per format.
 */
export type ExportFormat = "png" | "svg" | "pdf" | "drawio" | "dbml" | "excalidraw" | "html" | "archify" | "mermaid" | "arch";

/** The dialog's filter and the extension, per format. */
const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  png: { name: "PNG", extensions: ["png"] },
  svg: { name: "SVG", extensions: ["svg"] },
  pdf: { name: "PDF", extensions: ["pdf"] },
  drawio: { name: "draw.io", extensions: ["drawio", "xml"] },
  dbml: { name: "DBML", extensions: ["dbml"] },
  excalidraw: { name: "Excalidraw", extensions: ["excalidraw"] },
  html: { name: "HTML", extensions: ["html"] },
  // `json` rather than `architecture.json`: a save panel's type filter is one extension. The double
  // one comes from the suggested name instead — see `DiagramsView.openArchifyExportMenu`.
  archify: { name: "Archify", extensions: ["json"] },
  mermaid: { name: "Mermaid", extensions: ["mmd"] },
  // An Arquitectura document; the suggested name carries the `.arch.json` the bridge opens it by.
  arch: { name: "Arquitectura", extensions: ["json"] },
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
 * The one filter the import dialog offers: every dialect, in one entry.
 *
 * One entry rather than three, because a picker with a *format dropdown* is a question the user
 * should not have to answer — they have a file, and which of the editors opens it is a fact about
 * the file rather than a choice. The extension decides it; see `formatOf`.
 */
const IMPORT_FILTER = {
  name: "Diagram",
  extensions: ["drawio", "xml", "dbml", "excalidraw", "json", "html", "htm", "mmd", "mermaid"],
};

/**
 * Which editor a picked file belongs to, from its extension.
 *
 * Extension and not content sniffing. The dialects are not ambiguous in practice, and a guess
 * that reads the first line would be wrong in exactly the case that matters — an empty file, or a
 * DBML document that happens to open with a comment — while being invisible when it went wrong.
 */
function formatOf(path: string): DiagramFormat {
  if (/\.dbml$/i.test(path)) return FORMAT_DBML;
  if (/\.excalidraw$/i.test(path)) return FORMAT_EXCALIDRAW;
  // Mermaid opens as itself — every diagram type it draws, as written.
  if (/\.(mmd|mermaid)$/i.test(path)) return FORMAT_MERMAID;
  if (/\.(json|html?)$/i.test(path)) return FORMAT_ARCHIFY;
  return FORMAT_MXGRAPH;
}

/**
 * The one exception to "the extension decides, and nothing is inspected": archify's files.
 *
 * `.json` and `.html` say nothing about what is inside — most of either kind is not a diagram — so
 * here the extension only names the candidate, and the content has to back it up: a page archify
 * rendered carries its `generator` stamp, and a document has to read as one of archify's five types.
 * (A Mermaid file opens as a Mermaid diagram now; turning one into an archify map is the Mermaid
 * editor's «Convertir a mapa de arquitectura».)
 *
 * Returns the text to store.
 */
function prepareArchify(path: string, doc: string): string {
  if (/\.html?$/i.test(path)) {
    if (!isArchifyHtml(doc)) throw new Error(translate("diagrams.importNotArchify"));
    return doc;
  }
  const found = archifyDocKind(doc);
  if (found.kind === "document") return doc;
  throw new Error(
    found.kind === "invalid" && found.error === "mode"
      ? translate("archify.unknownMode", { mode: found.mode ?? "" })
      : translate("diagrams.importNotArchify"),
  );
}

/**
 * Opens a `.drawio` or `.dbml` file and returns its text, or `null` if the dialog was dismissed.
 *
 * The read goes through `diagrams_read_import` rather than a general "read any file" command,
 * deliberately: a narrow command that only reads what a file dialog just handed back is a much
 * smaller capability to have added to the app than a general one.
 *
 * The document comes back **uninspected**, which is the same rule the store keeps on the way in: a
 * validator at the door would be a second, worse parser in front of the editor that is about to
 * open the file, and the editors' own failure modes — draw.io's broken-document notice, the
 * workbench's error banner with a caret on the offending line — are visible and recoverable, which
 * a rejection at the door would not be.
 */
export async function openDiagramFile(): Promise<
  { name: string; doc: string; format: DiagramFormat } | null
> {
  const picked = await open({ multiple: false, filters: [IMPORT_FILTER] });
  if (typeof picked !== "string") return null;
  const { diagramsReadImport } = await import("../tauri/diagramsCommands");
  const read = await diagramsReadImport(picked);
  const format = formatOf(picked);
  const doc = format === FORMAT_ARCHIFY ? prepareArchify(picked, read) : read;
  const name = picked.split(/[\\/]/).pop() ?? "diagram";
  return {
    name: name.replace(/\.(drawio|xml|dbml|excalidraw|(?:architecture|workflow|sequence|dataflow|lifecycle)\.json|json|html?|mmd|mermaid)$/i, ""),
    doc,
    format,
  };
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
