import { useCallback, useMemo, useRef, useState } from "react";
import {
  Copy,
  FilePlus2,
  BookPlus,
  LayoutTemplate,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Search,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { NoteTreeRow } from "./NoteTreeRow";
import { TemplatePickerModal } from "./TemplatePickerModal";
import { BOOK_COLORS, ICON_BUTTON, TagPill } from "./notesChrome";
import { buildBookTree, descendantIds, flattenTree } from "../../lib/notes/tree";
import type { NoteTreeRow as NoteTreeRowData } from "../../types/notes";
import { tagCounts } from "../../lib/notes/tags";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { filterNotes, useNotesStore } from "../../state/notesStore";
import { useNotesDragStore } from "../../state/notesDragStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useT } from "../../state/languageStore";

/**
 * The explorer: search, the book tree, and the tag filter.
 *
 * **Everything about this component is about not re-rendering four hundred rows.** The tree is
 * flattened into a plain array in a `useMemo` keyed on the four things that can change it, each row
 * is a `memo`'d component taking primitives, and the callbacks handed down are `useCallback`'d
 * against the store's own stable actions. Typing in the search box rebuilds the array — which is
 * one pass — and re-renders only the rows whose membership actually changed.
 *
 * **The drag is pointer-driven**, because Tauri's webview swallows HTML5 `dragstart` — see
 * `notesDragStore`. A press becomes a drag after `DRAG_THRESHOLD` pixels, which is what keeps a
 * click on a note from being interpreted as a one-pixel drag onto itself.
 */
export function NoteExplorer() {
  const notes = useNotesStore((s) => s.notes);
  const books = useNotesStore((s) => s.books);
  const query = useNotesStore((s) => s.query);
  const bodyHits = useNotesStore((s) => s.bodyHits);
  const tagFilter = useNotesStore((s) => s.tagFilter);
  const collapsed = useNotesStore((s) => s.collapsed);
  const activeId = useNotesStore((s) => s.activeId);
  const sort = useNotesStore((s) => s.sort);

  const setQuery = useNotesStore((s) => s.setQuery);
  const toggleTag = useNotesStore((s) => s.toggleTag);
  const clearTags = useNotesStore((s) => s.clearTags);
  const toggleCollapsed = useNotesStore((s) => s.toggleCollapsed);
  const openNote = useNotesStore((s) => s.openNote);
  const createNote = useNotesStore((s) => s.createNote);
  const createBook = useNotesStore((s) => s.createBook);
  const renameBook = useNotesStore((s) => s.renameBook);
  const setBookColor = useNotesStore((s) => s.setBookColor);
  const deleteBook = useNotesStore((s) => s.deleteBook);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const duplicateNote = useNotesStore((s) => s.duplicateNote);
  const togglePinned = useNotesStore((s) => s.togglePinned);
  const moveNote = useNotesStore((s) => s.moveNote);
  const moveBook = useNotesStore((s) => s.moveBook);

  const drag = useNotesDragStore((s) => s.drag);
  const overBookId = useNotesDragStore((s) => s.overBookId);
  const press = useNotesDragStore((s) => s.press);
  const beginDrag = useNotesDragStore((s) => s.begin);
  const hoverDrag = useNotesDragStore((s) => s.hover);
  const endDrag = useNotesDragStore((s) => s.end);

  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Which row holds the tree's single tab stop. See `NoteTreeRow`'s roving-tabindex comment. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);

  const untitled = t("notes.untitled");

  // `bookId` is omitted, so this is the whole workspace's surviving notes — the tree places each
  // under its own book rather than showing one book's worth.
  const visible = useMemo(
    () => filterNotes(notes, { query, bodyHits, tagFilter, sort }),
    [notes, query, bodyHits, tagFilter, sort],
  );

  const tree = useMemo(() => buildBookTree(books), [books]);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);
  const rows = useMemo(
    () => flattenTree(tree, visible, collapsedSet),
    [tree, visible, collapsedSet],
  );
  const tags = useMemo(() => tagCounts(notes), [notes]);

  /** The books a drop may not land in: the dragged book and everything under it. */
  const forbidden = useMemo(
    () => (drag?.kind === "book" ? descendantIds(books, drag.id) : null),
    [drag, books],
  );

  // ---------- drag ----------

  const onPressDown = useCallback(
    (event: React.PointerEvent, row: NoteTreeRowData) => {
      // Left button only: a right-click opens the menu, and a middle-click must not start a drag
      // that has no way to be released.
      if (event.button !== 0) return;
      press(
        {
          kind: row.kind,
          id: row.id,
          fromBookId: row.kind === "book" ? row.book.parent_id : row.note.book_id,
        },
        event.clientX,
        event.clientY,
      );
    },
    [press],
  );

  /**
   * Whether a drag has just ended, so the click that follows it can be ignored.
   *
   * A pointer-driven drag does not suppress the browser's own click: a release over a row fires
   * `pointerup` and *then* `click`, so dropping a note into a book would also toggle that book
   * — or, dropping onto a note row, open the wrong note. A ref rather than state because nothing
   * renders from it and a re-render here would cost the whole tree.
   *
   * Cleared on a timeout rather than by the click it is waiting for. The two events are dispatched
   * in the same input task, so a `setTimeout(0)` scheduled during `pointerup` always runs after
   * the click — and clearing it *only* on the click would leave the flag armed forever whenever a
   * drop lands somewhere that produces no click at all (over the root strip, or on a row the
   * re-render unmounts), swallowing the next real one instead.
   */
  const swallowClick = useRef(false);

  const finishDrag = useCallback(() => {
    setDragCursor(false);
    // Read before `endDrag` clears it: a release with no drag behind it is an ordinary click and
    // must not be swallowed.
    if (useNotesDragStore.getState().drag !== null) {
      swallowClick.current = true;
      setTimeout(() => {
        swallowClick.current = false;
      }, 0);
    }
    endDrag();
  }, [endDrag]);

  // One listener on the container rather than one per row: the pointer leaves the pressed row
  // almost immediately, so a per-row `onPointerMove` would stop firing exactly when the drag is
  // deciding whether it has started.
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const { origin, drag: live } = useNotesDragStore.getState();
      if (live || !origin) return;
      // No button held means this is a plain hover, not a drag. Without the check a press whose
      // release we never saw — the pointer left the window, the OS took the gesture — leaves
      // `origin` armed, and the next time the pointer crosses the sidebar it travels far enough to
      // start a drag nobody began.
      if (event.buttons === 0) {
        finishDrag();
        return;
      }
      const travelled = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
      if (travelled < DRAG_THRESHOLD) return;
      beginDrag();
      setDragCursor(true);
    },
    [beginDrag, finishDrag],
  );

  const commitDrop = useCallback(
    (target: string | null) => {
      const { drag: live } = useNotesDragStore.getState();
      if (!live) return;
      // Same book: nothing to write. Checked here rather than in the store so a drop that means
      // nothing costs nothing — no round trip, no re-render.
      if (live.fromBookId === target) return;
      if (live.kind === "note") void moveNote(live.id, target);
      // A book into its own subtree is refused by the backend too (`move_book` returns false),
      // but catching it here means the row never lights up as a target in the first place.
      else if (!forbidden?.has(target ?? "")) void moveBook(live.id, target);
    },
    [moveNote, moveBook, forbidden],
  );

  const onSelectRow = useCallback(
    (row: NoteTreeRowData) => {
      if (swallowClick.current) return;
      setFocusedId(row.id);
      void openNote(row.id);
    },
    [openNote],
  );

  const onToggleRow = useCallback(
    (row: NoteTreeRowData) => {
      if (swallowClick.current) return;
      setFocusedId(row.id);
      toggleCollapsed(row.id);
    },
    [toggleCollapsed],
  );

  /**
   * Arrow-key navigation over the flattened tree.
   *
   * The flattening is what makes this a few lines rather than a recursive walk: "next row" is
   * `rows[index + 1]`, whatever its depth. Left/Right collapse and expand the way every file tree
   * does — Right on a collapsed book opens it and on an open one steps into it, Left closes it
   * and on a leaf steps out to its parent.
   */
  const onTreeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const KEYS = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "];
      if (!KEYS.includes(event.key)) return;
      const current = focusedId ?? rows[0]?.id ?? null;
      const index = rows.findIndex((row) => row.id === current);
      if (index === -1) return;
      const row = rows[index];
      event.preventDefault();

      const focus = (next: number) => {
        const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
        if (!target) return;
        setFocusedId(target.id);
        // The DOM node has to take focus too, or a screen reader is told nothing moved.
        treeRef.current
          ?.querySelector<HTMLElement>(`[data-note-row="${CSS.escape(target.id)}"]`)
          ?.focus();
      };

      switch (event.key) {
        case "ArrowDown":
          focus(index + 1);
          break;
        case "ArrowUp":
          focus(index - 1);
          break;
        case "Home":
          focus(0);
          break;
        case "End":
          focus(rows.length - 1);
          break;
        case "ArrowRight":
          if (row.kind === "book" && collapsedSet.has(row.id)) toggleCollapsed(row.id);
          else focus(index + 1);
          break;
        case "ArrowLeft":
          if (row.kind === "book" && !collapsedSet.has(row.id)) toggleCollapsed(row.id);
          else {
            // Out to the parent: the nearest row above at a shallower depth.
            for (let at = index - 1; at >= 0; at--) {
              if (rows[at].depth < row.depth) {
                focus(at);
                break;
              }
            }
          }
          break;
        default:
          if (row.kind === "book") toggleCollapsed(row.id);
          else void openNote(row.id);
      }
    },
    [rows, focusedId, collapsedSet, toggleCollapsed, openNote],
  );

  // ---------- menus ----------

  /** `event` is needed for its coordinates: the colour entry replaces the menu in place, at the
   *  same point the first one opened at. */
  const bookMenu = useCallback(
    (event: React.MouseEvent, bookId: string, name: string): MenuItem[] => {
      return [
        {
          label: t("notes.newNoteHere"),
          icon: FilePlus2,
          onClick: () => void createNote(bookId),
        },
        {
          label: t("notes.newSubbook"),
          icon: BookPlus,
          onClick: () => {
            void promptAction(t("notes.newBookPrompt"), {
              confirmLabel: t("notes.create"),
            }).then((value) => value && void createBook(bookId, value));
          },
        },
        {
          label: t("notes.rename"),
          icon: Pencil,
          separated: true,
          onClick: () => {
            void promptAction(t("notes.renameBookPrompt"), {
              initial: name,
              confirmLabel: t("notes.rename"),
            }).then((value) => value && void renameBook(bookId, value));
          },
        },
        {
          label: t("notes.bookColor"),
          icon: Palette,
          onClick: () => {
            // A second menu in place of the first, which `ContextMenu` re-measures for — see its
            // `items.length` dependency. A colour picker modal for nine swatches would be a dialog
            // to dismiss for a decision taken in one click.
            setMenu({
              x: event.clientX,
              y: event.clientY,
              items: BOOK_COLORS.map((color) => ({
                label: color ? "" : t("notes.noColor"),
                leading: (
                  <span
                    className="h-3 w-3 rounded-full border border-[var(--cf-border)]"
                    style={{ background: color || "transparent" }}
                  />
                ),
                onClick: () => void setBookColor(bookId, color),
              })),
            });
          },
        },
        {
          label: t("notes.deleteBook"),
          icon: Trash2,
          danger: true,
          separated: true,
          onClick: () => {
            const inside = notes.filter(
              (note) => note.book_id && descendantIds(books, bookId).has(note.book_id),
            ).length;
            void confirmAction(
              // The message says where the notes go, because "delete book" reads as "delete what
              // is in it" and here it emphatically is not.
              inside > 0
                ? t("notes.deleteBookWithNotes", { name, count: inside })
                : t("notes.deleteBookConfirm", { name }),
              true,
              t("notes.delete"),
            ).then((ok) => ok && void deleteBook(bookId));
          },
        },
      ];
    },
    [t, createNote, createBook, renameBook, setBookColor, deleteBook, notes, books],
  );

  const noteMenu = useCallback(
    (noteId: string, title: string, pinned: boolean): MenuItem[] => [
      {
        label: pinned ? t("notes.unpin") : t("notes.pin"),
        icon: pinned ? PinOff : Pin,
        onClick: () => void togglePinned(noteId),
      },
      {
        label: t("notes.duplicate"),
        icon: Copy,
        onClick: () => void duplicateNote(noteId),
      },
      {
        label: t("notes.delete"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () => {
          void confirmAction(
            t("notes.deleteNoteConfirm", { name: title || untitled }),
            true,
            t("notes.delete"),
          ).then((ok) => ok && void deleteNote(noteId));
        },
      },
    ],
    [t, togglePinned, duplicateNote, deleteNote, untitled],
  );

  /** One handler for both kinds, stable, so `NoteTreeRow`'s `memo` holds — see its comment. */
  const onRowMenu = useCallback(
    (event: React.MouseEvent, row: NoteTreeRowData) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items:
          row.kind === "book"
            ? bookMenu(event, row.book.id, row.book.name)
            : noteMenu(row.note.id, row.note.title, row.note.pinned),
      });
    },
    [bookMenu, noteMenu],
  );

  // ---------- render ----------

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onPointerMove={onPointerMove}
      // On the container, so releasing over a gap between rows ends the drag rather than leaving it
      // live and armed for the next click anywhere in the app.
      onPointerUp={finishDrag}
      // A gesture the OS or the browser takes over — a touch turning into a scroll, a window
      // losing focus mid-drag. Without it `body.cf-dragging` stays on and the whole app keeps a
      // grabbing cursor and refuses to select text until the next successful drag.
      onPointerCancel={finishDrag}
      // Any pointer that leaves the sidebar ends the gesture — a live drag *and* a press that had
      // not yet become one. Guarding on `drag` would leave the pending `origin` set when someone
      // presses a row and slides out without releasing: the release then happens where we never
      // hear it, and the next pointer move back inside measures its travel from the stale origin
      // and starts a drag nobody began.
      onPointerLeave={finishDrag}
    >
      <div className="shrink-0 space-y-2 border-b border-[var(--cf-border)] p-2">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("notes.title")}
          </span>
          <button
            type="button"
            className={ICON_BUTTON}
            title={t("notes.newBook")}
            aria-label={t("notes.newBook")}
            onClick={() => {
              void promptAction(t("notes.newBookPrompt"), {
                confirmLabel: t("notes.create"),
              }).then((value) => value && void createBook(null, value));
            }}
          >
            <BookPlus size={13} />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            title={t("notes.newNote")}
            aria-label={t("notes.newNote")}
            onClick={() => void createNote(null)}
            data-tour="notes-new"
          >
            <FilePlus2 size={13} />
          </button>
        </div>

        <div className="relative" data-tour="notes-search">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
          />
          <input
            ref={searchField}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            placeholder={t("notes.searchPlaceholder")}
            aria-label={t("notes.searchPlaceholder")}
            spellCheck={false}
            className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] py-1 pl-6 pr-6 text-[11.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchField.current?.focus();
              }}
              aria-label={t("notes.clearSearch")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {tagFilter.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {tagFilter.map((tag) => (
              <TagPill
                key={tag}
                tag={tag}
                active
                onRemove={() => toggleTag(tag)}
                removeLabel={t("notes.removeTagFilter", { tag })}
              />
            ))}
            <button
              type="button"
              onClick={clearTags}
              className="text-[10.5px] text-[var(--cf-text-muted)] underline-offset-2 hover:text-[var(--cf-text)] hover:underline"
            >
              {t("notes.clearFilters")}
            </button>
          </div>
        )}
      </div>

      <div
        ref={treeRef}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
        role="tree"
        aria-label={t("notes.title")}
        data-tour="notes-tree"
        onKeyDown={onTreeKeyDown}
      >
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11.5px] text-[var(--cf-text-muted)]">
            {query || tagFilter.length > 0 ? t("notes.noMatches") : t("notes.treeEmpty")}
          </p>
        ) : (
          rows.map((row) => (
            <NoteTreeRow
              key={row.id}
              row={row}
              active={row.kind === "note" && row.id === activeId}
              collapsed={row.kind === "book" && collapsedSet.has(row.id)}
              dropTarget={
                drag !== null &&
                overBookId === (row.kind === "book" ? row.book.id : row.note.book_id) &&
                // The row being dragged never lights up as its own destination, and neither does a
                // book inside the dragged book.
                drag.id !== row.id &&
                !(row.kind === "book" && forbidden?.has(row.id))
              }
              dragging={drag?.id === row.id}
              focused={row.id === (focusedId ?? rows[0]?.id)}
              untitledLabel={untitled}
              onSelect={onSelectRow}
              onToggle={onToggleRow}
              onHover={hoverDrag}
              onDrop={commitDrop}
              onPressDown={onPressDown}
              onMenu={onRowMenu}
            />
          ))
        )}

        {/* The root as a drop target. It has no row of its own — unfiled notes sit at depth 0 with
            nothing above them — so without this strip there is no way to drag a note *out* of a
            book, only deeper into one. `min-h` rather than `flex-1` because the list scrolls: a
            growing spacer would push the scrollbar around as rows are filtered. */}
        <div
          className={`mt-1 min-h-8 rounded-md transition-colors ${
            drag && overBookId === null && drag.fromBookId !== null
              ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
              : ""
          }`}
          onPointerEnter={() => hoverDrag(null)}
          onPointerUp={() => commitDrop(null)}
          aria-hidden
        />
      </div>

      {tags.length > 0 && (
        <div
          data-tour="notes-tags"
          className="max-h-40 shrink-0 overflow-y-auto border-t border-[var(--cf-border)] p-2"
        >
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            <Tags size={11} />
            {t("notes.tags")}
          </div>
          <div className="flex flex-wrap gap-1">
            {tags.map(({ tag, count }) => (
              <TagPill
                key={tag}
                tag={tag}
                count={count}
                active={tagFilter.includes(tag)}
                onClick={() => toggleTag(tag)}
              />
            ))}
          </div>
        </div>
      )}

      <TemplateStrip />

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/**
 * The templates, at the foot of the sidebar.
 *
 * Here rather than behind a button because a template only helps if it is visible at the moment
 * you decide to write something — a picker you have to remember exists is a picker nobody opens.
 * Its own component so that opening the picker re-renders a strip and not the tree above it.
 */
function TemplateStrip() {
  const [open, setOpen] = useState(false);
  const t = useT();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tour="notes-templates"
        className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-2.5 py-2 text-left text-[11.5px] text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
      >
        <LayoutTemplate size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("notes.templates")}</span>
      </button>
      {open && <TemplatePickerModal onClose={() => setOpen(false)} />}
    </>
  );
}
