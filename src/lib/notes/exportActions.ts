import { open, save } from "@tauri-apps/plugin-dialog";
import { renderMarkdown } from "../markdown";
import { writeFileBytes } from "../tauri/commands";
import { notesGetNote, notesReadImport } from "../tauri/notesCommands";
import { descendantIds } from "./tree";
import { exportFileStem, notesToHtml, renderNotesPdf, type ExportedNote } from "./exportNotes";
import { MARKDOWN_EXTENSIONS, noteFromMarkdownFile, type ImportedMarkdown } from "./importMarkdown";
import { translate, useLanguageStore } from "../../state/languageStore";
import { useNotesStore } from "../../state/notesStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";

/**
 * The file-dialog half of exporting and importing notes: ask where, write, say so.
 *
 * Kept apart from `exportNotes.ts`, which is pure and tested, the same split `lib/diagrams` makes
 * between `exportOptions` and `exportFile`.
 */

export type NoteExportFormat = "md" | "html" | "pdf";

const FILTERS: Record<NoteExportFormat, { name: string; extensions: string[] }> = {
  md: { name: "Markdown", extensions: ["md"] },
  html: { name: "HTML", extensions: ["html"] },
  pdf: { name: "PDF", extensions: ["pdf"] },
};

/**
 * Writes `notes` as one file of `format`, where the user says. Markdown is a single note's text as
 * it is; HTML and PDF hold one note or a whole notebook.
 */
export async function exportNotes(
  format: NoteExportFormat,
  notes: ExportedNote[],
  title: string,
): Promise<void> {
  if (notes.length === 0) return;
  const untitled = translate("notes.untitled");
  try {
    const path = await save({
      defaultPath: `${exportFileStem(title, untitled)}.${FILTERS[format].extensions[0]}`,
      filters: [FILTERS[format]],
    });
    if (!path) return;
    let bytes: Uint8Array;
    if (format === "md") {
      bytes = new TextEncoder().encode(notes[0].content);
    } else if (format === "html") {
      const html = notesToHtml(notes, {
        title,
        lang: useLanguageStore.getState().language,
        untitled,
        render: renderMarkdown,
      });
      bytes = new TextEncoder().encode(html);
    } else {
      bytes = await renderNotesPdf(notes, { title, untitled });
    }
    await writeFileBytes(path, bytes);
    useToastStore.getState().pushToast(translate("notes.exported"), "success");
  } catch (error) {
    pushErrorToast(String(error));
  }
}

/**
 * Every live note in a notebook and the books under it, in the order the tree shows them — each
 * book's notes by hand-made order, the book itself before its sub-books. The open note's draft is
 * written first, so what is exported is what is on screen.
 */
export async function notebookForExport(bookId: string): Promise<ExportedNote[]> {
  await useNotesStore.getState().flush();
  const { books, notes } = useNotesStore.getState();
  const inside = descendantIds(books, bookId);
  const ordered: string[] = [];
  const walk = (parent: string) => {
    ordered.push(parent);
    books
      .filter((book) => book.parent_id === parent)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .forEach((book) => walk(book.id));
  };
  walk(bookId);
  const out: ExportedNote[] = [];
  for (const id of ordered.filter((entry) => inside.has(entry))) {
    const members = notes
      .filter((note) => note.book_id === id)
      .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
    for (const note of members) {
      const row = await notesGetNote(note.id);
      if (row) out.push({ id: row.id, title: row.title, content: row.content });
    }
  }
  return out;
}

/**
 * Picks one or several Markdown files and writes them in as notes of `bookId` (`null`: wherever a
 * new note would go). A file that cannot be read is reported and skipped; the rest still arrive.
 */
export async function importMarkdownFiles(bookId: string | null): Promise<void> {
  try {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Markdown", extensions: MARKDOWN_EXTENSIONS }],
    });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (paths.length === 0) return;
    const files: ImportedMarkdown[] = [];
    for (const path of paths) {
      try {
        files.push(noteFromMarkdownFile(path, await notesReadImport(path)));
      } catch (error) {
        pushErrorToast(String(error));
      }
    }
    const created = await useNotesStore.getState().importMarkdown(bookId, files);
    if (created > 0) {
      useToastStore.getState().pushToast(translate("notes.imported", { n: created }), "success");
    }
  } catch (error) {
    pushErrorToast(String(error));
  }
}
