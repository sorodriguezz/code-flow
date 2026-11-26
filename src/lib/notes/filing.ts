/**
 * Where a dated note is filed: a book per month inside the book it belongs to — «Reuniones ›
 * Noviembre 2026» — the way the user had been arranging them by hand (2026-11-25).
 *
 * Pure: the store does the creating and the moving (`notesStore.monthBook`, `organizeBookByMonth`).
 */

type Language = "es" | "en";

interface BookLike {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
}

interface NoteLike {
  id: string;
  book_id: string | null;
  created_at: string;
}

const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** «Noviembre 2026» / «November 2026»: the month spelled out and capitalised, then the year. */
export function monthBookName(date: Date, language: Language): string {
  const month = date.toLocaleDateString(language === "en" ? "en-US" : "es-ES", { month: "long" });
  return `${month.charAt(0).toLocaleUpperCase()}${month.slice(1)} ${date.getFullYear()}`;
}

/** The book of `date`'s month inside `parentId`, when there is one — by its name in either
 *  language, so a workspace whose language changed does not get a second book for the same month. */
export function findMonthBook<B extends BookLike>(books: B[], parentId: string, date: Date): B | undefined {
  const names = [monthBookName(date, "es"), monthBookName(date, "en")];
  return books.find((book) => book.parent_id === parentId && names.some((name) => same(book.name, name)));
}

/** The book at the root of the tree that `bookId` hangs from. */
function rootOf<B extends BookLike>(books: B[], bookId: string | null): B | undefined {
  let book = books.find((candidate) => candidate.id === bookId);
  for (let depth = 0; book?.parent_id && depth < 32; depth++) {
    const parent = books.find((candidate) => candidate.id === book?.parent_id);
    if (!parent) break;
    book = parent;
  }
  return book;
}

/**
 * The book new meetings go to: the root book that already holds the most notes with a meeting
 * (in it or in a book inside it), so they keep landing where the user keeps them whatever that book
 * is called; with no meeting anywhere, the root book named `fallbackName`. `undefined` when neither
 * exists — the caller makes one.
 */
export function meetingsHome<B extends BookLike>(books: B[], notes: NoteLike[], withMeeting: ReadonlySet<string>, fallbackName: string): B | undefined {
  const held = new Map<string, number>();
  for (const note of notes) {
    if (!withMeeting.has(note.id)) continue;
    const root = rootOf(books, note.book_id);
    if (root) held.set(root.id, (held.get(root.id) ?? 0) + 1);
  }
  const roots = books.filter((book) => !book.parent_id);
  const most = roots
    .filter((book) => held.has(book.id))
    .sort((a, b) => (held.get(b.id) ?? 0) - (held.get(a.id) ?? 0) || a.sort_order - b.sort_order)[0];
  return most ?? roots.find((book) => same(book.name, fallbackName));
}

/**
 * What «Organizar por mes» does to a book: the notes sitting directly in it, grouped by the month
 * they were written, oldest month first. Notes already inside a book of it are left where they are.
 */
export function monthGroups(notes: NoteLike[], bookId: string, language: Language): { name: string; date: Date; noteIds: string[] }[] {
  const groups = new Map<string, { name: string; date: Date; noteIds: string[] }>();
  for (const note of notes) {
    if (note.book_id !== bookId) continue;
    const date = new Date(note.created_at);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getFullYear()}-${String(date.getMonth()).padStart(2, "0")}`;
    const group = groups.get(key) ?? { name: monthBookName(date, language), date, noteIds: [] };
    group.noteIds.push(note.id);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}
