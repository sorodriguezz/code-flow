import { memo, useMemo } from "react";
import {
  Book,
  ChevronRight,
  FilePlus2,
  LayoutGrid,
  List,
  NotebookPen,
  Pin,
  Search,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { Select } from "../common/Select";
import { TagPill, bookInk, readingMinutes, relativeTime } from "./notesChrome";
import type { Note, NoteBookRow, NoteSort } from "../../types/notes";
import { filterNotes, useNotesStore } from "../../state/notesStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * What the main pane shows when no note is open: **the shelf**.
 *
 * It browses books first and their contents second, which is the shape the data has — every note
 * lives in a book (see `db/note_queries.rs::create_note`), so a flat wall of every note in the
 * workspace was showing the leaves of a tree and calling it the tree. One click into a book is the
 * whole navigation: the books it contains, then the notes it holds.
 *
 * The one place that hierarchy is suspended is search. A query is a question about the *workspace*,
 * not about the book you happen to be standing in, so results are flat and come from everywhere —
 * anything else would be a search that answers "nothing" while the match sits one shelf over.
 *
 * **Cards render from `excerpt`, never from a body.** That column exists precisely so this view
 * can show a preview of four hundred notes without any of their bodies being in memory — see the
 * `notes` table comment. A card that sliced `content` would undo the whole design.
 */
export function NoteGallery() {
  const notes = useNotesStore((s) => s.notes);
  const books = useNotesStore((s) => s.books);
  const query = useNotesStore((s) => s.query);
  const bodyHits = useNotesStore((s) => s.bodyHits);
  const tagFilter = useNotesStore((s) => s.tagFilter);
  const sort = useNotesStore((s) => s.sort);
  const galleryView = useNotesStore((s) => s.galleryView);
  const bookFilter = useNotesStore((s) => s.bookFilter);
  const setSort = useNotesStore((s) => s.setSort);
  const setGalleryView = useNotesStore((s) => s.setGalleryView);
  const setBookFilter = useNotesStore((s) => s.setBookFilter);
  const openNote = useNotesStore((s) => s.openNote);
  const createNote = useNotesStore((s) => s.createNote);
  const toggleTag = useNotesStore((s) => s.toggleTag);
  const language = useLanguageStore((s) => s.language);
  const t = useT();

  const searching = query.trim().length > 0 || tagFilter.length > 0;

  /** The trail from the shelf down to the open book — the breadcrumb, and the way back up. */
  const trail = useMemo(() => bookTrail(books, bookFilter), [books, bookFilter]);
  /** The book actually being shown, or `null` at the shelf. Re-read from `books` rather than
   *  trusted from `bookFilter`, so a book deleted in another window doesn't leave a dead heading. */
  const openBook = trail.length > 0 ? trail[trail.length - 1] : null;

  /** The books at this level: the open book's children, or the top of the shelf. */
  const shelf = useMemo(
    () =>
      books
        .filter((book) => book.parent_id === (openBook?.id ?? null))
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [books, openBook],
  );

  /**
   * The notes to draw.
   *
   * `bookId` is `undefined` while searching — `filterNotes` reads that as "every book", which is
   * what a workspace-wide search means. Otherwise it is the open book, and at the shelf it is
   * `null`: a book id nothing has any more, so the shelf shows books and no loose notes.
   */
  const visible = useMemo(
    () =>
      filterNotes(notes, {
        query,
        bodyHits,
        tagFilter,
        bookId: searching ? undefined : (openBook?.id ?? null),
        // **A search cannot be shown in the hand-made order**, because there isn't one to show:
        // `sort_order` is a position *within a book*, so ordering results drawn from every book by
        // it would interleave five books' first notes, then five books' second notes. Results fall
        // back to most-recently-edited, which is the ordering a search answer wants anyway. Every
        // other mode is a total order over the workspace and survives the flattening unchanged.
        sort: searching && sort === "manual" ? "updated" : sort,
      }),
    [notes, query, bodyHits, tagFilter, searching, openBook, sort],
  );

  if (notes.length === 0 && books.length === 0) {
    return (
      <EmptyState icon={NotebookPen} title={t("notes.emptyTitle")} subtitle={t("notes.emptySubtitle")} />
    );
  }

  const heading = searching
    ? t("notes.matchCount", { n: visible.length })
    : openBook
      ? t("notes.noteCount", { n: visible.length })
      : t("notes.bookCount", { n: shelf.length });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Breadcrumb trail={trail} onOpen={setBookFilter} rootLabel={t("notes.allBooks")} />
          <h2 className="shrink-0 truncate text-[12px] text-[var(--cf-text-muted)]">{heading}</h2>
        </div>
        <Select
          value={sort}
          onChange={(value) => setSort(value as NoteSort)}
          ariaLabel={t("notes.sortBy")}
          size="sm"
          className="shrink-0"
          style={{ width: "auto" }}
          options={[
            // First and default: the order the user arranged in the sidebar. The other four are
            // views onto the same notes — this one is the only one a drag can write, and the only
            // one that doesn't rearrange itself while a note is being typed into.
            { value: "manual", label: t("notes.sortManual") },
            { value: "updated", label: t("notes.sortUpdated") },
            { value: "created", label: t("notes.sortCreated") },
            { value: "title", label: t("notes.sortTitle") },
            { value: "words", label: t("notes.sortWords") },
          ]}
        />
        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
          <ViewButton
            icon={LayoutGrid}
            label={t("notes.viewGrid")}
            active={galleryView === "grid"}
            onClick={() => setGalleryView("grid")}
          />
          <ViewButton
            icon={List}
            label={t("notes.viewList")}
            active={galleryView === "list"}
            onClick={() => setGalleryView("list")}
          />
        </div>
      </div>

      {searching && visible.length === 0 ? (
        <EmptyState icon={Search} title={t("notes.noMatches")} subtitle={t("notes.noMatchesHint")} />
      ) : !searching && shelf.length === 0 && visible.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-4">
          <EmptyState
            icon={Book}
            title={openBook ? t("notes.bookEmpty") : t("notes.treeEmpty")}
            subtitle={t("notes.bookEmptyHint")}
          />
          <button
            type="button"
            onClick={() => void createNote(openBook?.id ?? null)}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            <FilePlus2 size={13} />
            {t("notes.newNote")}
          </button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {/* `auto-fill` and not `auto-fit`: with two notes in a wide window, `auto-fit` stretches
              them to half the screen each, which turns two cards into two banners. `auto-fill`
              keeps the column width and leaves the space empty, so a card is always a card. */}
          {!searching && shelf.length > 0 && (
            galleryView === "grid" ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                {shelf.map((book) => (
                  <BookCard
                    key={book.id}
                    book={book}
                    // The whole subtree's, not this book's own: a book showing "0" while holding
                    // forty notes one level down is the one number a closed book must not report.
                    count={countWithin(notes, books, book.id)}
                    onOpen={() => setBookFilter(book.id)}
                    label={t("notes.openBook", { name: book.name })}
                    countLabel={t("notes.noteCount", { n: countWithin(notes, books, book.id) })}
                  />
                ))}
              </div>
            ) : (
              <div className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-md border border-[var(--cf-border)]">
                {shelf.map((book) => (
                  <BookListRow
                    key={book.id}
                    book={book}
                    count={countWithin(notes, books, book.id)}
                    onOpen={() => setBookFilter(book.id)}
                    label={t("notes.openBook", { name: book.name })}
                    countLabel={t("notes.noteCount", { n: countWithin(notes, books, book.id) })}
                  />
                ))}
              </div>
            )
          )}

          {visible.length > 0 && (
            galleryView === "grid" ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                {visible.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    snippet={bodyHits[note.id]?.snippet}
                    locale={language}
                    onOpen={() => void openNote(note.id)}
                    onTag={toggleTag}
                    untitled={t("notes.untitled")}
                    readingLabel={t("notes.readingTime", { n: readingMinutes(note.word_count) })}
                  />
                ))}
              </div>
            ) : (
              <div className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-md border border-[var(--cf-border)]">
                {visible.map((note) => (
                  <NoteListRow
                    key={note.id}
                    note={note}
                    snippet={bodyHits[note.id]?.snippet}
                    locale={language}
                    onOpen={() => void openNote(note.id)}
                    onTag={toggleTag}
                    untitled={t("notes.untitled")}
                    readingLabel={t("notes.readingTime", { n: readingMinutes(note.word_count) })}
                  />
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function ViewButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof LayoutGrid;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        active
          ? "bg-[var(--cf-surface)] text-[var(--cf-text)] shadow-sm"
          : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      <Icon size={13} />
    </button>
  );
}

/** The open book's ancestors, outermost first, then itself. Empty at the shelf. */
function bookTrail(books: NoteBookRow[], bookId: string | null): NoteBookRow[] {
  if (!bookId) return [];
  const byId = new Map(books.map((book) => [book.id, book]));
  const trail: NoteBookRow[] = [];
  let current = byId.get(bookId);
  // Bounded by the row count: `move_book` refuses to make a cycle, but a hand-edited database is
  // not the place to hang.
  for (let guard = 0; current && guard <= books.length; guard++) {
    trail.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return trail;
}

/** How many notes a book holds, its subbooks included. */
function countWithin(notes: Note[], books: NoteBookRow[], bookId: string): number {
  const within = new Set([bookId]);
  // The tree is shallow and `books` is already sorted parent-before-child by nothing in
  // particular, so this repeats until it stops growing rather than assuming an order.
  for (let pass = 0; pass < books.length; pass++) {
    let grew = false;
    for (const book of books) {
      if (book.parent_id && within.has(book.parent_id) && !within.has(book.id)) {
        within.add(book.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return notes.filter((note) => note.book_id && within.has(note.book_id)).length;
}

function Breadcrumb({
  trail,
  onOpen,
  rootLabel,
}: {
  trail: NoteBookRow[];
  onOpen: (bookId: string | null) => void;
  rootLabel: string;
}) {
  return (
    <nav className="flex min-w-0 items-center gap-0.5 text-[13px]" aria-label={rootLabel}>
      <Crumb
        label={rootLabel}
        current={trail.length === 0}
        onClick={() => onOpen(null)}
      />
      {trail.map((book, index) => (
        <span key={book.id} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
          <Crumb
            label={book.name}
            tint={bookInk(book.color)}
            current={index === trail.length - 1}
            onClick={() => onOpen(book.id)}
          />
        </span>
      ))}
    </nav>
  );
}

function Crumb({
  label,
  current,
  tint,
  onClick,
}: {
  label: string;
  current: boolean;
  tint?: string;
  onClick: () => void;
}) {
  // The last crumb is where you already are, so it is text rather than a button — a control that
  // does nothing when pressed is worse than no control.
  if (current) {
    return (
      <span
        className="min-w-0 truncate font-semibold text-[var(--cf-text)]"
        style={tint ? { color: tint } : undefined}
        aria-current="page"
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 truncate rounded px-1 py-0.5 text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.05]"
    >
      {label}
    </button>
  );
}

const BookCard = memo(function BookCard({
  book,
  count,
  onOpen,
  label,
  countLabel,
}: {
  book: NoteBookRow;
  count: number;
  onOpen: () => void;
  label: string;
  countLabel: string;
}) {
  const tint = bookInk(book.color);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="group flex min-h-[92px] cursor-pointer flex-col justify-between gap-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3 text-left transition-colors hover:border-[var(--cf-accent)]"
    >
      <div className="flex items-start gap-2">
        <Book size={15} className="mt-px shrink-0" style={tint ? { color: tint } : undefined} />
        <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--cf-text)]">
          {book.name}
        </h3>
        <ChevronRight
          size={13}
          className="mt-px shrink-0 text-[var(--cf-text-muted)] transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </div>
      <span className="text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
        {count > 0 ? countLabel : ""}
      </span>
    </button>
  );
});

const BookListRow = memo(function BookListRow({
  book,
  count,
  onOpen,
  label,
  countLabel,
}: {
  book: NoteBookRow;
  count: number;
  onOpen: () => void;
  label: string;
  countLabel: string;
}) {
  const tint = bookInk(book.color);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
    >
      <Book size={14} className="shrink-0" style={tint ? { color: tint } : undefined} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--cf-text)]">
        {book.name}
      </span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
        {count > 0 ? countLabel : ""}
      </span>
      <ChevronRight
        size={13}
        className="shrink-0 text-[var(--cf-text-muted)] transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </button>
  );
});

const NoteCard = memo(function NoteCard({
  note,
  snippet,
  locale,
  onOpen,
  onTag,
  untitled,
  readingLabel,
}: {
  note: Note;
  /** The stretch of *body* a search matched, shown in place of the excerpt when there is one — the
   *  card should show why it is in the results, not its opening line. */
  snippet?: string;
  locale: string;
  onOpen: () => void;
  onTag: (tag: string) => void;
  untitled: string;
  readingLabel: string;
}) {
  return (
    <article
      // `content-visibility` lets the browser skip layout and paint for cards scrolled out of
      // view. A grid of four hundred is where that starts to matter, and `contain-intrinsic-size`
      // is what keeps the scrollbar from jumping as they are skipped and un-skipped.
      style={{ contentVisibility: "auto", containIntrinsicSize: "160px" }}
      className="group flex h-full min-h-[132px] cursor-pointer flex-col gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3 transition-colors hover:border-[var(--cf-accent)]"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Only when the card itself has focus. `stopPropagation` on the tag chips' click handles
        // the mouse, but a keyboard Enter on a chip fires `keydown` on the chip and *bubbles* here
        // — so filtering by a tag would also open the note behind it.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onOpen();
      }}
      tabIndex={0}
      role="button"
    >
      <div className="flex items-start gap-1.5">
        <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--cf-text)]">
          {note.title || <span className="italic text-[var(--cf-text-muted)]">{untitled}</span>}
        </h3>
        {note.pinned && (
          <Pin size={11} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" fill="currentColor" />
        )}
      </div>

      <p className="line-clamp-3 min-h-0 flex-1 text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
        {snippet || note.excerpt}
      </p>

      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {/* The card is itself a button, so a tag click has to be stopped from reaching it —
              otherwise filtering by a tag also opens the note you filtered from. */}
          {note.tags.slice(0, 3).map((tag) => (
            <span key={tag} onClick={(event) => event.stopPropagation()}>
              <TagPill tag={tag} onClick={() => onTag(tag)} />
            </span>
          ))}
          {note.tags.length > 3 && (
            <span className="text-[10px] text-[var(--cf-text-muted)]">
              +{note.tags.length - 3}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-[var(--cf-text-muted)]">
        <span className="tabular-nums">{relativeTime(note.updated_at, locale)}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{readingLabel}</span>
      </div>
    </article>
  );
});

const NoteListRow = memo(function NoteListRow({
  note,
  snippet,
  locale,
  onOpen,
  onTag,
  untitled,
  readingLabel,
}: {
  note: Note;
  /** The stretch of *body* a search matched, shown in place of the excerpt when there is one — the
   *  row should show why it is in the results, not its opening line. */
  snippet?: string;
  locale: string;
  onOpen: () => void;
  onTag: (tag: string) => void;
  untitled: string;
  readingLabel: string;
}) {
  return (
    <div
      className="group flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onOpen();
      }}
      tabIndex={0}
      role="button"
    >
      {note.pinned ? (
        <Pin size={11} className="shrink-0 text-[var(--cf-accent)]" fill="currentColor" />
      ) : (
        <span className="w-[11px] shrink-0" aria-hidden />
      )}
      <span className="w-[180px] shrink-0 truncate text-[12.5px] font-semibold text-[var(--cf-text)]">
        {note.title || <span className="italic text-[var(--cf-text-muted)]">{untitled}</span>}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]">
        {snippet || note.excerpt}
      </span>
      {note.tags.length > 0 && (
        <span className="hidden shrink-0 items-center gap-1 sm:flex">
          {/* The row is itself a button, so a tag click has to be stopped from reaching it —
              otherwise filtering by a tag also opens the note you filtered from. */}
          {note.tags.slice(0, 2).map((tag) => (
            <span key={tag} onClick={(event) => event.stopPropagation()}>
              <TagPill tag={tag} onClick={() => onTag(tag)} />
            </span>
          ))}
        </span>
      )}
      <span className="hidden shrink-0 items-center gap-2 text-[10px] tabular-nums text-[var(--cf-text-muted)] md:flex">
        <span>{relativeTime(note.updated_at, locale)}</span>
        <span aria-hidden>·</span>
        <span>{readingLabel}</span>
      </span>
    </div>
  );
});
