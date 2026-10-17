import type { Note, NoteBook, NoteBookRow, NoteTreeRow } from "../../types/notes";

/**
 * The book tree, and the flat list the explorer actually draws.
 *
 * Nested data rendered as a nested component tree is the shape that gets slow: renaming one note
 * inside a book six levels down re-renders every ancestor's subtree, because each level's JSX is
 * rebuilt to produce the level below it. Flattening to an array of rows with a `depth` breaks that
 * — the list maps over rows, each row is its own memoised component keyed by id, and a change to
 * one of them touches one of them.
 *
 * It also makes the two things a tree UI needs otherwise-awkward genuinely easy: keyboard
 * navigation is `rows[index ± 1]`, and windowing (should the list ever grow enough to want it) has
 * something to window.
 */

/** The rows as a forest, children resolved. Orphans — a row whose parent is missing — surface at
 *  the root rather than vanishing, which is the difference between a bug that hides data and one
 *  the user can see and fix. */
export function buildBookTree(rows: NoteBookRow[]): NoteBook[] {
  const byId = new Map<string, NoteBook>();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });

  const roots: NoteBook[] = [];
  for (const book of byId.values()) {
    const parent = book.parent_id ? byId.get(book.parent_id) : undefined;
    if (parent) parent.children.push(book);
    else roots.push(book);
  }

  const sort = (list: NoteBook[]) => {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    for (const book of list) sort(book.children);
  };
  sort(roots);
  return roots;
}

/**
 * The tree as the list of rows to draw, honouring which books are open.
 *
 * **`expanded`, not `collapsed`** — a book is closed unless it is in the set. The default matters:
 * a workspace of thirty books that all unfold on sight is a wall of note titles with the books lost
 * inside it. Closed, it is a shelf, and opening one is how you say which one you are working in.
 *
 * Notes come after subbooks within a book — the arrangement every file tree uses, and the one
 * that keeps a book's own contents from being pushed off screen by its children's.
 *
 * `notes` is already filtered (by search, by tag): a book is drawn whether or not
 * anything in it survived the filter, because a book that disappears while you type is a book
 * you cannot drop a note into. What changes is its count. A caller that is *searching* passes every
 * book as expanded — see `NoteExplorer` — because a match hidden inside a shut book is a search
 * that lies about what it found.
 */
export function flattenTree(
  books: NoteBook[],
  notes: Note[],
  expanded: ReadonlySet<string>,
): NoteTreeRow[] {
  // Notes grouped by book once, rather than a `filter` per book per render — the difference
  // between one pass and one pass *per book*.
  const byBook = new Map<string, Note[]>();
  for (const note of notes) {
    const key = note.book_id ?? ROOT;
    const list = byBook.get(key);
    if (list) list.push(note);
    else byBook.set(key, [note]);
  }

  const rows: NoteTreeRow[] = [];

  const walk = (list: NoteBook[], depth: number) => {
    for (const book of list) {
      const own = byBook.get(book.id) ?? [];
      rows.push({
        kind: "book",
        id: book.id,
        depth,
        book,
        // The whole subtree's count, not just this book's: a closed book showing "0" while
        // holding forty notes in its children is the one number a closed row must not report.
        noteCount: countWithin(book, byBook),
      });
      if (!expanded.has(book.id)) continue;
      walk(book.children, depth + 1);
      for (const note of own) rows.push({ kind: "note", id: note.id, depth: depth + 1, note });
    }
  };
  walk(books, 0);

  // A note outside every book is no longer a state the app can produce — `create_note` takes a book
  // and `migrations::file_loose_notes_into_a_book` brought the old ones inside. This stays as the
  // one place such a row could still be *seen*, so a database restored from before that migration
  // shows its notes at the root rather than hiding them behind a rule they predate.
  for (const note of byBook.get(ROOT) ?? []) {
    rows.push({ kind: "note", id: note.id, depth: 0, note });
  }

  return rows;
}

/** The key notes with no book are grouped under. Not a book id — no book may collide with it. */
const ROOT = "\0root";

function countWithin(book: NoteBook, byBook: Map<string, Note[]>): number {
  let total = byBook.get(book.id)?.length ?? 0;
  for (const child of book.children) total += countWithin(child, byBook);
  return total;
}

/** A book's ancestors, outermost first, then itself — the breadcrumb over an open note. */
export function bookPath(books: NoteBookRow[], bookId: string | null): NoteBookRow[] {
  if (!bookId) return [];
  const byId = new Map(books.map((f) => [f.id, f]));
  const path: NoteBookRow[] = [];
  let current = byId.get(bookId);
  // Bounded by the row count: a cycle is impossible through the UI (`move_book` refuses one) but
  // a hand-edited database is not the place to hang.
  for (let guard = 0; current && guard <= books.length; guard++) {
    path.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

/** A book and everything under it. What "does this book contain the drop target" is asked of,
 *  and what a delete confirmation counts. */
export function descendantIds(books: NoteBookRow[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const book of books) {
    if (!book.parent_id) continue;
    const list = children.get(book.parent_id);
    if (list) list.push(book.id);
    else children.set(book.parent_id, [book.id]);
  }
  const found = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop() as string;
    for (const child of children.get(id) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}
