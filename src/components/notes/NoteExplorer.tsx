import { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
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
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { NoteTreeRow } from "./NoteTreeRow";
import { TemplatePickerModal } from "./TemplatePickerModal";
import { ICON_BUTTON, TagPill } from "./notesChrome";
import { TREE_COLORS } from "../../lib/swatchColors";
import { scopeMenuItems } from "../../lib/scopeMenu";
import { buildBookTree, descendantIds, flattenTree } from "../../lib/notes/tree";
import type { NoteTreeRow as NoteTreeRowData } from "../../types/notes";
import type { RowScope } from "../../types/domain";
import { tagCounts, tagHue } from "../../lib/notes/tags";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useLayoutStore } from "../../state/layoutStore";
import { filterNotes, useNotesStore } from "../../state/notesStore";
import {
  edgeAt,
  useNotesDragStore,
  type NotesDrag,
  type NotesDropPlan,
} from "../../state/notesDragStore";
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
 *
 * **A drop either files or orders**, decided by where in the row it lands and resolved by
 * `planDrop` below. That is the half of the hand-made ordering the user can see: `sort_order` is
 * only ever written by a drag, so this component is the only way the list's order is ever set.
 */
export function NoteExplorer() {
  const notes = useNotesStore((s) => s.notes);
  const books = useNotesStore((s) => s.books);
  const query = useNotesStore((s) => s.query);
  const bodyHits = useNotesStore((s) => s.bodyHits);
  const tagFilter = useNotesStore((s) => s.tagFilter);
  const untaggedOnly = useNotesStore((s) => s.untaggedOnly);
  const expanded = useNotesStore((s) => s.expanded);
  const activeId = useNotesStore((s) => s.activeId);
  const sort = useNotesStore((s) => s.sort);

  const setQuery = useNotesStore((s) => s.setQuery);
  const toggleTag = useNotesStore((s) => s.toggleTag);
  const toggleUntagged = useNotesStore((s) => s.toggleUntagged);
  const clearTags = useNotesStore((s) => s.clearTags);
  const toggleBook = useNotesStore((s) => s.toggleBook);
  const setBookFilter = useNotesStore((s) => s.setBookFilter);
  const openNote = useNotesStore((s) => s.openNote);
  const createNote = useNotesStore((s) => s.createNote);
  const createBook = useNotesStore((s) => s.createBook);
  const renameBook = useNotesStore((s) => s.renameBook);
  const setBookColor = useNotesStore((s) => s.setBookColor);
  const deleteBook = useNotesStore((s) => s.deleteBook);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const duplicateNote = useNotesStore((s) => s.duplicateNote);
  const togglePinned = useNotesStore((s) => s.togglePinned);
  const dropNote = useNotesStore((s) => s.dropNote);
  const dropBook = useNotesStore((s) => s.dropBook);

  const drag = useNotesDragStore((s) => s.drag);
  const over = useNotesDragStore((s) => s.over);
  const press = useNotesDragStore((s) => s.press);
  const beginDrag = useNotesDragStore((s) => s.begin);
  const hoverDrag = useNotesDragStore((s) => s.hover);
  const endDrag = useNotesDragStore((s) => s.end);

  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Which row holds the tree's single tab stop. See `NoteTreeRow`'s roving-tabindex comment. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** The tag cloud folded shut, which is how it starts.
   *
   *  Closed by default because the tree above it is what this panel is for, and a workspace with
   *  forty tags spent a third of the sidebar's height on a list nobody had asked to see — the tags
   *  are a way *into* the notes, reached when you want them, not a permanent header over them.
   *
   *  Local rather than persisted: unlike an open book, this isn't an arrangement anyone builds up
   *  — it's "show me the tags for a moment", and it starts closed again next time. */
  const [tagsCollapsed, setTagsCollapsed] = useState(true);
  /** Narrows the tag list itself. Local like the fold above it, and for the same reason: it is a
   *  "find this one now", not an arrangement. */
  const [tagQuery, setTagQuery] = useState("");
  const tagsByCount = useLayoutStore((s) => s.flags.notesTagsByCount);
  const toggleLayoutFlag = useLayoutStore((s) => s.toggleFlag);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);

  const untitled = t("notes.untitled");

  // `bookId` is omitted, so this is the whole workspace's surviving notes — the tree places each
  // under its own book rather than showing one book's worth.
  const visible = useMemo(
    () => filterNotes(notes, { query, bodyHits, tagFilter, untaggedOnly, sort }),
    [notes, query, bodyHits, tagFilter, untaggedOnly, sort],
  );

  const tree = useMemo(() => buildBookTree(books), [books]);
  const filtering = query.trim().length > 0 || tagFilter.length > 0 || untaggedOnly;
  /**
   * The books drawn open.
   *
   * **A filtered tree ignores which books are shut**, the way `HostExplorer` does: a match hidden
   * inside a closed book is a search that lies about what it found — and with books closed by
   * default, that would be every match. The user's own set comes back the moment the box is
   * cleared, because it was never changed.
   */
  const expandedSet = useMemo(
    () => (filtering ? new Set(books.map((book) => book.id)) : new Set(expanded)),
    [filtering, books, expanded],
  );
  const rows = useMemo(
    () => flattenTree(tree, visible, expandedSet),
    [tree, visible, expandedSet],
  );
  // Alphabetical by default, not `tagCounts`'s own most-used-first order — that order is right for
  // `NoteTagBar`'s autocomplete, where the point is surfacing the *likely* tag first, but wrong for
  // a list a person scans to find one by name. Ties (which is most of them, in a young workspace
  // where every tag has been used once) are what made the frequency order look unsorted to begin
  // with: it fell back to alphabetical anyway, just after a count nobody could see at a glance.
  //
  // Now that the count is a badge on the row rather than a digit inside a chip, frequency is worth
  // offering — a workspace with hundreds of notes has a real "which of these do I actually use"
  // question. So it is a toggle, and a persisted one: an ordering is decided once, not per visit.
  const tags = useMemo(() => {
    // Sorted in place: `tagCounts` ends in `.map().sort()`, so what comes back is freshly built and
    // held by nobody else. The spread that used to be here copied it for no one.
    const counted = tagCounts(notes);
    return tagsByCount
      ? counted.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      : counted.sort((a, b) => a.tag.localeCompare(b.tag));
  }, [notes, tagsByCount]);

  /** Notes carrying no tags at all — the question a list of everything filed provokes.
   *
   *  Counted rather than filtered-then-measured: `filter().length` materialises an array of every
   *  untagged note only to read its size and drop it, and this recomputes on every change to
   *  `notes` — which is every create, rename, tag edit and delete. */
  const untaggedCount = useMemo(
    () => notes.reduce((total, note) => total + (note.tags.length === 0 ? 1 : 0), 0),
    [notes],
  );

  /** The tag list's own search, which is not the note search above it: this one narrows the list of
   *  names, that one narrows the notes. Substring rather than prefix — tags here are compound
   *  (`oracle`, `oracle-12c`), and the half people remember is not reliably the front. */
  const shownTags = useMemo(() => {
    const needle = tagQuery.trim().toLowerCase();
    return needle ? tags.filter(({ tag }) => tag.includes(needle)) : tags;
  }, [tags, tagQuery]);

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

  /**
   * One listener on the container rather than one per row: the pointer leaves the pressed row
   * almost immediately, so a per-row `onPointerMove` would stop firing exactly when the drag is
   * deciding whether it has started.
   *
   * **Bound on the capture phase**, and that is load-bearing rather than tidy. The rows resolve
   * where a drop would land by measuring themselves (`zoneAt`), and this handler *scrolls the list
   * underneath them*. On the bubble phase it would run second, so every move inside the autoscroll
   * band would leave the insertion line drawn against the layout as it was before the scroll — an
   * aim you cannot correct, because correcting it scrolls again. Scrolling first makes the rects
   * the rows read the ones the user is looking at.
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const { origin, drag: live } = useNotesDragStore.getState();
      if (live) {
        autoScroll(treeRef.current, event.clientY);
        return;
      }
      if (!origin) return;
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

  /**
   * What a release over `row`, in zone `edge`, would actually write — or `null` for "nothing".
   *
   * The one rule worth stating outright: **an ordering edge only means something between rows of
   * the same kind.** A note has no place in the sequence of books and a book has none in the
   * sequence of notes — `flattenTree` draws the two as separate runs — so a note over a book's top
   * edge, or a book over a note, collapses to filing. That is both the only coherent reading and
   * the forgiving one: the fallback of an imprecise drop is the thing the tree has always done.
   *
   * The second rule is the books-first one: **a note's destination is never the root.** Every note
   * belongs to a book, so a plan that would leave one outside every book is no plan at all and the
   * row refuses to light up.
   *
   * Used for the highlight *and* for the write, so what lights up under the pointer is by
   * construction what a release performs.
   */
  const planDrop = useCallback(
    (
      live: NotesDrag,
      row: NoteTreeRowData,
      edge: "into" | "before" | "after",
    ): NotesDropPlan | null => {
      // A row is never its own destination — neither inside itself nor next to itself.
      if (live.id === row.id) return null;
      const ordering = edge !== "into" && live.kind === row.kind;

      if (row.kind === "book") {
        /**
         * An **open book has no usable bottom edge**, and this is the one place the geometry and
         * the meaning come apart. `flattenTree` draws an expanded book's contents immediately
         * below its header, so a line along that header's underside sits above the book's own
         * first child — while the drop it stands for places the item after the *whole subtree*,
         * several rows further down. Rather than draw a line that points at the wrong gap, the
         * band falls back to filing, which is what the middle of the row already means. Ordering
         * that book downwards is still one gesture away: the top edge of the next sibling.
         */
        const drawnOpen =
          expandedSet.has(row.id) &&
          (row.noteCount > 0 || books.some((book) => book.parent_id === row.id));
        if (!ordering || (edge === "after" && drawnOpen)) {
          // A book into its own subtree is refused by the backend too (`move_book` returns false),
          // but catching it here means the row never lights up as a target in the first place.
          if (live.kind === "book" && forbidden?.has(row.id)) return null;
          return { mode: "into", bookId: row.book.id };
        }
        // Next to a book is *among its siblings*, so the destination is its parent — which may
        // itself be inside the subtree being dragged, and which is the root for a top-level book.
        // Only a book can be ordered here, so a null destination is a book at the root: allowed.
        const parentId = row.book.parent_id;
        if (forbidden?.has(parentId ?? "")) return null;
        return { mode: "order", anchorId: row.id, after: edge === "after", bookId: parentId };
      }

      const bookId = row.note.book_id;
      // A note row with no book is a row from before the books-first rule (see `flattenTree`).
      // Nothing may be dropped relative to it: there is no list for the drop to join.
      if (bookId === null) return null;
      if (!ordering) {
        if (live.kind === "book" && forbidden?.has(bookId)) return null;
        return { mode: "into", bookId };
      }
      return { mode: "order", anchorId: row.id, after: edge === "after", bookId };
    },
    [forbidden, expandedSet, books],
  );

  /** The zone of `row` the pointer is in — measured here, not in the row, so that an ordinary
   *  mouse-over of the tree costs no layout. See `NoteTreeRow`'s `onHover`. */
  const zoneAt = (event: React.PointerEvent, row: NoteTreeRowData) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return edgeAt(row.kind, event.clientY - rect.top, rect.height);
  };

  const onHoverRow = useCallback(
    (event: React.PointerEvent, row: NoteTreeRowData) => {
      const { drag: live } = useNotesDragStore.getState();
      // Guarded before anything is measured: this fires for every pixel of every ordinary pass of
      // the pointer across the tree, and nothing below it is free.
      if (!live) return;
      hoverDrag(planDrop(live, row, zoneAt(event, row)));
    },
    [hoverDrag, planDrop],
  );

  const commit = useCallback(
    (plan: NotesDropPlan | null) => {
      const { drag: live } = useNotesDragStore.getState();
      if (!live || !plan) return;
      const anchor = plan.mode === "order" ? { id: plan.anchorId, after: plan.after } : null;
      if (live.kind === "book") {
        void dropBook(live.id, plan.bookId, anchor);
        return;
      }
      // `planDrop` never hands a note a null book; this is the type system being told so.
      if (plan.bookId !== null) void dropNote(live.id, plan.bookId, anchor);
    },
    [dropNote, dropBook],
  );

  const commitDrop = useCallback(
    (event: React.PointerEvent, row: NoteTreeRowData) => {
      const { drag: live } = useNotesDragStore.getState();
      if (!live) return;
      // Re-resolved from the release point rather than read off the store's `over`, so a drop is
      // decided by where the pointer actually let go — the two agree, because it is the same
      // function over the same inputs.
      commit(planDrop(live, row, zoneAt(event, row)));
    },
    [commit, planDrop],
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
      // Not while filtering. Every book is drawn open then, whatever the stored set says, so a
      // toggle would write the opposite of what the chevron shows and the row would not move —
      // a click that appears to do nothing and quietly rearranges the tree once the box is
      // cleared. Navigating to the book still works, which is the half that has any meaning here.
      if (!filtering) toggleBook(row.id);
      // And the main pane goes to that book, so clicking a book in the sidebar means the same
      // thing as clicking its card on the shelf. It takes effect behind an open note rather than
      // closing it: a click on a book is navigation, not a request to put the writing away.
      setBookFilter(row.id);
    },
    [toggleBook, setBookFilter, filtering],
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
          if (row.kind === "book" && !expandedSet.has(row.id)) toggleBook(row.id);
          else focus(index + 1);
          break;
        case "ArrowLeft":
          if (row.kind === "book" && expandedSet.has(row.id)) toggleBook(row.id);
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
          if (row.kind === "book") toggleBook(row.id);
          else void openNote(row.id);
      }
    },
    [rows, focusedId, expandedSet, toggleBook, openNote],
  );

  // ---------- menus ----------

  /** `event` is needed for its coordinates: the colour entry replaces the menu in place, at the
   *  same point the first one opened at. */
  const bookMenu = useCallback(
    (event: React.MouseEvent, bookId: string, name: string, scope: RowScope): MenuItem[] => {
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
              items: TREE_COLORS.map((swatch) => ({
                label: t(swatch.labelKey),
                leading: (
                  <span
                    className="h-3 w-3 rounded-full border border-[var(--cf-border)]"
                    style={{ background: swatch.value || "transparent" }}
                  />
                ),
                onClick: () => void setBookColor(bookId, swatch.value),
              })),
            });
          },
        },
        // Scope, between filing and deleting: it is a decision about where the book lives, which
        // is the same kind of act as renaming and recolouring it above.
        ...scopeMenuItems({
          scope,
          anchor: { x: event.clientX, y: event.clientY },
          openMenu: setMenu,
          // Read off the store at click time rather than closed over, so this callback's identity
          // stays stable — `NoteTreeRow`'s hand-written memo comparator compares `onMenu`.
          onSetGlobal: (global) => void useNotesStore.getState().setBookScope(bookId, global),
          onMoveToWorkspace: (workspaceId) =>
            void useNotesStore.getState().moveBookToWorkspace(bookId, workspaceId),
          separated: true,
        }),
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
              // The message says the count, because this deletes the writing too and the number is
              // the whole difference between an ordinary confirmation and one worth reading. Taken
              // from `notes` rather than from the filtered list: what a search happens to be hiding
              // is still going to be deleted.
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
            ? bookMenu(event, row.book.id, row.book.name, row.book.scope)
            : noteMenu(row.note.id, row.note.title, row.note.pinned),
      });
    },
    [bookMenu, noteMenu],
  );

  // ---------- render ----------

  /** Where the live drop plan would land *in this row*, for the highlight. See `NoteTreeRow`.
   *
   *  An `into` plan lights up every row of the destination book, not just the one under the
   *  pointer: what is about to happen is "this goes in there", and the book is the there. An
   *  `order` plan lights up exactly its anchor, because what is about to happen is a position. */
  const dropEdgeFor = (row: NoteTreeRowData): "into" | "before" | "after" | null => {
    if (!drag || !over) return null;
    if (over.mode === "order") {
      return over.anchorId === row.id ? (over.after ? "after" : "before") : null;
    }
    // The row being dragged shows as lifted rather than as its own destination.
    if (drag.id === row.id) return null;
    return over.bookId === (row.kind === "book" ? row.book.id : row.note.book_id) ? "into" : null;
  };

  /**
   * The root strip's plan: **books only**, and only one that isn't already at the root.
   *
   * A note can no longer be dropped here at all, because "outside every book" is not a place a note
   * can be — so what used to be the way to unfile one is now the way to promote a subbook to the
   * top level, and nothing else.
   */
  const rootPlan: NotesDropPlan | null =
    drag?.kind === "book" && drag.fromBookId !== null ? { mode: "into", bookId: null } : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onPointerMoveCapture={onPointerMove}
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
              collapsed={row.kind === "book" && !expandedSet.has(row.id)}
              dropEdge={dropEdgeFor(row)}
              dragging={drag?.id === row.id}
              focused={row.id === (focusedId ?? rows[0]?.id)}
              untitledLabel={untitled}
              onSelect={onSelectRow}
              onToggle={onToggleRow}
              onHover={onHoverRow}
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
            over?.mode === "into" && over.bookId === null
              ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
              : ""
          }`}
          onPointerEnter={() => hoverDrag(rootPlan)}
          onPointerUp={() => commit(rootPlan)}
          aria-hidden
        />
      </div>

      {(tags.length > 0 || untaggedCount > 0) && (
        <div data-tour="notes-tags" className="shrink-0 border-t border-[var(--cf-border)] p-2">
          {/* A row of controls, so the fold is its own button rather than the whole strip: the
              sort toggle sits beside it and a header that folded on any click would swallow it. */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTagsCollapsed((c) => !c)}
              aria-expanded={!tagsCollapsed}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              {tagsCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <Tags size={11} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{t("notes.tags")}</span>
              {/* The one filter this section owns that nothing else on screen repeats: an active
                  tag shows as a chip under the search box whether this is folded or not, but
                  "untagged" is a row in the list below and nowhere else. Folded is the default
                  now, so without this the tree could sit filtered with nothing anywhere saying
                  why. */}
              {tagsCollapsed && untaggedOnly && (
                <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-1.5 font-medium normal-case text-[var(--cf-accent)]">
                  {t("notes.untagged")}
                </span>
              )}
              <span className="tabular-nums font-normal normal-case">{tags.length}</span>
            </button>
            {!tagsCollapsed && (
              <button
                type="button"
                onClick={() => toggleLayoutFlag("notesTagsByCount")}
                aria-pressed={tagsByCount}
                title={tagsByCount ? t("notes.tagSortByCount") : t("notes.tagSortByName")}
                aria-label={tagsByCount ? t("notes.tagSortByCount") : t("notes.tagSortByName")}
                className={`shrink-0 rounded p-0.5 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
                  tagsByCount ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
                }`}
              >
                <ArrowUpDown size={11} />
              </button>
            )}
          </div>

          {!tagsCollapsed && (
            <>
              {/* Always, not only once the list is long enough to need it. It was gated on a
                  count at first, on the theory that a box over six tags saves nothing — but a
                  control that comes and goes as notes are tagged is one you cannot learn is there,
                  and its absence reads as missing rather than as unnecessary. A row of height is
                  the cheaper half of that trade. */}
              <div className="relative mt-1.5">
                <Search
                  size={11}
                  className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
                />
                <input
                  value={tagQuery}
                  onChange={(event) => setTagQuery(event.target.value)}
                  onKeyDown={(event) => event.key === "Escape" && setTagQuery("")}
                  placeholder={t("notes.searchTag")}
                  aria-label={t("notes.searchTag")}
                  spellCheck={false}
                  className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] py-0.5 pl-5 pr-1.5 text-[11px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
                />
              </div>

              {/* One tag per row rather than a wrapped cloud of chips.
                  A cloud is compact and it is what this was, but it makes the two things the list
                  is for hard: the counts sat inside the chips at different x positions on every
                  line, so they could not be compared by eye, and finding one name meant reading a
                  ragged block instead of running down a column. Rows put the names on one edge and
                  the counts on the other, which is what makes both scannable. */}
              <div className="mt-1 max-h-64 overflow-y-auto">
                {untaggedCount > 0 && !tagQuery.trim() && (
                  <TagRow
                    label={t("notes.untagged")}
                    count={untaggedCount}
                    active={untaggedOnly}
                    onClick={toggleUntagged}
                  />
                )}
                {shownTags.map(({ tag, count }) => (
                  <TagRow
                    key={tag}
                    label={tag}
                    hue={tagHue(tag)}
                    count={count}
                    active={tagFilter.includes(tag)}
                    onClick={() => toggleTag(tag)}
                  />
                ))}
                {shownTags.length === 0 && tagQuery.trim() && (
                  <p className="px-1.5 py-2 text-center text-[11px] text-[var(--cf-text-muted)]">
                    {t("notes.noTagMatches")}
                  </p>
                )}
              </div>
            </>
          )}
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
 * One tag in the list: a colour dot, the name, and how many notes carry it.
 *
 * The dot rather than the full chip `TagPill` draws elsewhere. A chip is right where a tag appears
 * *among prose or cards* and has to be picked out of it; in a column where every row is a tag, the
 * chip's background says nothing the position doesn't, and forty washed pills stacked up read as a
 * paint chart. The hue is the same one `tagHue` gives the chip, so a tag is still recognisably
 * itself between this list and the notes it labels.
 *
 * The count sits in its own pill on the right edge — the one place it can be compared down the
 * column, which is the question a count answers.
 */
function TagRow({
  label,
  hue,
  count,
  active,
  onClick,
}: {
  label: string;
  /** Absent for "Untagged", which is not a tag and gets a hollow ring instead of a colour. */
  hue?: number;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-[3px] text-left text-[11.5px] ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${hue === undefined ? "border border-[var(--cf-text-muted)]" : ""}`}
        style={hue === undefined ? undefined : { background: `oklch(65% 0.13 ${hue})` }}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* `tabular-nums` so a column of counts lines up on its digits rather than shuffling as they
          change width — the whole reason for putting them on one edge. */}
      <span
        className={`shrink-0 rounded-full px-1.5 py-px text-[10px] tabular-nums ${
          active
            ? "bg-[var(--cf-accent)]/20 text-[var(--cf-accent)]"
            : "bg-black/[0.06] text-[var(--cf-text-muted)] dark:bg-white/[0.08]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

/** How close to the list's edge the pointer has to be before the list follows it. */
const AUTOSCROLL_EDGE = 28;
/** How far one move-event's worth of scrolling travels. */
const AUTOSCROLL_STEP = 14;

/**
 * Scrolls the tree when a drag reaches its top or bottom edge.
 *
 * Without it the reachable drop targets are the ones already on screen, which in a workspace of a
 * few hundred notes means a note can only ever be moved as far as one screenful — and the pointer
 * is held down, so the wheel and the scrollbar are both out of reach.
 *
 * Driven by the pointer's own move events rather than by a timer: it scrolls while the user keeps
 * moving and stops the instant they stop, which is both the behaviour a hand expects and one with
 * no interval to leak if the drag ends somewhere this component never hears about.
 */
function autoScroll(list: HTMLElement | null, clientY: number) {
  if (!list) return;
  const rect = list.getBoundingClientRect();
  if (clientY < rect.top + AUTOSCROLL_EDGE) list.scrollTop -= AUTOSCROLL_STEP;
  else if (clientY > rect.bottom - AUTOSCROLL_EDGE) list.scrollTop += AUTOSCROLL_STEP;
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
