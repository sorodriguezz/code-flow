import { invoke } from "@tauri-apps/api/core";
import type {
  NoteBookRow,
  NoteMetaRow,
  NoteRow,
  NoteSearchHit,
  NoteTemplateRow,
  NotesWorkspaceTree,
} from "../../types/notes";

/**
 * IPC surface for the Notes workspace.
 *
 * Kept out of `commands.ts` for the reason `remoteCommands.ts` and `dbCommands.ts` are: nothing
 * here touches git or takes a repository path. What it takes instead is a `workspaceId` on the two
 * calls that read or create — a note belongs to the workspace, not to whichever repository happens
 * to be selected. Anything addressed by its own id doesn't need one.
 *
 * **`notesGetNote` is the only call that returns a body.** Everything else — the tree, every
 * mutation's return value — deals in metadata. That is not an accident of the API: the whole
 * design rests on the note list never carrying megabytes of Markdown, so a second command that
 * returns `content` in bulk would quietly undo it. See `db/note_queries.rs`.
 *
 * **Two calls answer with a value rather than an error where a failure would be ordinary.**
 * `notesSaveNote` and `notesMoveNote` return `null` when the note has been deleted underneath the
 * caller, and `notesMoveBook` returns `false` when a drop would have put a book inside its own
 * subtree. All three are things a second window or a stray drag makes happen; a rejected promise
 * would put a toast on screen for a user who did nothing wrong.
 */

// ---------- load ----------

export const notesLoadTree = (workspaceId: string) =>
  invoke<NotesWorkspaceTree>("notes_load_tree", { workspaceId });

/** One note's body. `null` if it has been deleted. */
export const notesGetNote = (id: string) => invoke<NoteRow | null>("notes_get_note", { id });

// ---------- notes ----------

/** `bookId` is required: every note lives in a book. See `db/note_queries.rs::create_note`. */
export const notesCreateNote = (
  workspaceId: string,
  bookId: string,
  title: string,
  content: string,
  tags: string,
) => invoke<NoteMetaRow>("notes_create_note", { workspaceId, bookId, title, content, tags });

/** The autosave path. `null` means the note was deleted while it was being edited. */
export const notesSaveNote = (id: string, title: string, content: string, tags: string) =>
  invoke<NoteMetaRow | null>("notes_save_note", { id, title, content, tags });

/** Refiles a note into another book. There is no "out of every book" — see `notesCreateNote`. */
export const notesMoveNote = (id: string, bookId: string) =>
  invoke<NoteMetaRow | null>("notes_move_note", { id, bookId });

/**
 * Writes one book's note order — `ids` is that book's whole list, in the order the user arranged it.
 *
 * Positions are per book, so this is always called with the notes of a single book (or of the root).
 * A drag that crossed books calls `notesMoveNote` first: the positions have to be written against
 * the list the note has already joined. See `notesStore.dropNote`.
 */
export const notesReorderNotes = (ids: string[]) =>
  invoke<void>("notes_reorder_notes", { ids });

export const notesSetPinned = (id: string, pinned: boolean) =>
  invoke<void>("notes_set_pinned", { id, pinned });

export const notesDeleteNote = (id: string) => invoke<void>("notes_delete_note", { id });

/** `title` is passed in because "Copy of …" is translated and Rust has no language. */
export const notesDuplicateNote = (id: string, title: string) =>
  invoke<NoteMetaRow | null>("notes_duplicate_note", { id, title });

// ---------- books ----------

export const notesCreateBook = (
  workspaceId: string,
  parentId: string | null,
  name: string,
  color: string,
) => invoke<NoteBookRow>("notes_create_book", { workspaceId, parentId, name, color });

export const notesRenameBook = (id: string, name: string) =>
  invoke<void>("notes_rename_book", { id, name });

export const notesSetBookColor = (id: string, color: string) =>
  invoke<void>("notes_set_book_color", { id, color });

/** `false` means the drop was refused: it would have put the book inside its own subtree. */
export const notesMoveBook = (id: string, parentId: string | null) =>
  invoke<boolean>("notes_move_book", { id, parentId });

/** The books' half of `notesReorderNotes`: one parent's children, in their new order. */
export const notesReorderBooks = (ids: string[]) =>
  invoke<void>("notes_reorder_books", { ids });

/** Removes the book, its subbooks **and every note in them**. Confirm before calling. */
export const notesDeleteBook = (id: string) => invoke<void>("notes_delete_book", { id });

// ---------- templates ----------

export const notesCreateTemplate = (
  workspaceId: string,
  name: string,
  description: string,
  icon: string,
  content: string,
  tags: string,
) =>
  invoke<NoteTemplateRow>("notes_create_template", {
    workspaceId,
    name,
    description,
    icon,
    content,
    tags,
  });

export const notesUpdateTemplate = (row: NoteTemplateRow) =>
  invoke<void>("notes_update_template", { row });

export const notesDeleteTemplate = (id: string) => invoke<void>("notes_delete_template", { id });

// ---------- search ----------

/**
 * Notes whose **body** contains `query`.
 *
 * Titles and tags are not searched here and must not be: the store already holds every note's
 * metadata, so it filters those itself on the keystroke with no round trip. This call exists for
 * the one thing the frontend cannot do — look inside bodies it never loaded — and the two results
 * are merged in `notesStore.visibleNotes`.
 */
export const notesSearch = (workspaceId: string, query: string) =>
  invoke<NoteSearchHit[]>("notes_search", { workspaceId, query });

// ---------- writing with AI ----------

/**
 * Markdown to drop into the open note.
 *
 * No engine argument: this runs on whatever Settings → AI → model per task routes the `notes` task
 * to, the same as every other AI action in the app. `selection` may be empty — that is "write
 * something here" rather than "replace this". `runId` puts it in the AI run log and makes it
 * cancellable.
 */
export const notesWriteWithAi = (args: {
  title: string;
  content: string;
  selection: string;
  instruction: string;
  runId?: string;
}) =>
  invoke<string>("notes_write_with_ai", {
    title: args.title,
    content: args.content,
    selection: args.selection,
    instruction: args.instruction,
    runId: args.runId ?? null,
  });
