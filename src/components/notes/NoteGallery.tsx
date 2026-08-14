import { memo, useMemo } from "react";
import { FilePlus2, NotebookPen, Pin, Search } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { Select } from "../common/Select";
import { TagPill, readingMinutes, relativeTime } from "./notesChrome";
import type { Note, NoteSort } from "../../types/notes";
import { filterNotes, useNotesStore } from "../../state/notesStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * What the main pane shows when no note is open: the workspace's notes as cards.
 *
 * It is a *reading* surface, not a second tree — the sidebar already answers "where is it filed".
 * This one answers "what have I been writing", which is why the default order is most-recent and
 * why every card leads with two lines of the note rather than with its book.
 *
 * **Cards render from `excerpt`, never from a body.** That column exists precisely so this view
 * can show a preview of four hundred notes without any of their bodies being in memory — see the
 * `notes` table comment. A card that sliced `content` would undo the whole design.
 */
export function NoteGallery() {
  const notes = useNotesStore((s) => s.notes);
  const query = useNotesStore((s) => s.query);
  const bodyHits = useNotesStore((s) => s.bodyHits);
  const tagFilter = useNotesStore((s) => s.tagFilter);
  const sort = useNotesStore((s) => s.sort);
  const setSort = useNotesStore((s) => s.setSort);
  const openNote = useNotesStore((s) => s.openNote);
  const createNote = useNotesStore((s) => s.createNote);
  const toggleTag = useNotesStore((s) => s.toggleTag);
  const language = useLanguageStore((s) => s.language);
  const t = useT();

  const visible = useMemo(
    () => filterNotes(notes, { query, bodyHits, tagFilter, sort }),
    [notes, query, bodyHits, tagFilter, sort],
  );

  const searching = query.trim().length > 0 || tagFilter.length > 0;

  if (notes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <EmptyState
          icon={NotebookPen}
          title={t("notes.emptyTitle")}
          subtitle={t("notes.emptySubtitle")}
        />
        <button
          type="button"
          onClick={() => void createNote(null)}
          className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
        >
          <FilePlus2 size={13} />
          {t("notes.newNote")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">
          {searching
            ? t("notes.matchCount", { n: visible.length })
            : t("notes.noteCount", { n: notes.length })}
        </h2>
        <Select
          value={sort}
          onChange={(value) => setSort(value as NoteSort)}
          ariaLabel={t("notes.sortBy")}
          size="sm"
          options={[
            { value: "updated", label: t("notes.sortUpdated") },
            { value: "created", label: t("notes.sortCreated") },
            { value: "title", label: t("notes.sortTitle") },
            { value: "words", label: t("notes.sortWords") },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Search} title={t("notes.noMatches")} subtitle={t("notes.noMatchesHint")} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* `auto-fill` and not `auto-fit`: with two notes in a wide window, `auto-fit` stretches
              them to half the screen each, which turns two cards into two banners. `auto-fill`
              keeps the column width and leaves the space empty, so a card is always a card. */}
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
        </div>
      )}
    </div>
  );
}

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
