import { memo } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Book,
  BookOpen,
  Pin,
  type LucideIcon,
} from "lucide-react";
import type { NoteTreeRow as Row } from "../../types/notes";
import { bookInk, ROW, ROW_ACTIVE, ROW_IDLE } from "./notesChrome";

/** Which part of a row a drop would land in. `null` is "not this row". */
type DropEdge = "into" | "before" | "after" | null;

/**
 * One row of the explorer tree — a book or a note.
 *
 * `memo`'d, and that is the whole reason it is a separate file: the tree is flattened upstream
 * (`lib/notes/tree.ts`) precisely so typing in the search box rebuilds the row *list* without
 * re-rendering every row in it. In a workspace of four hundred notes that is the difference
 * between a search box that keeps up with typing and one that doesn't.
 *
 * **Every callback prop is stable and takes the row as an argument.** This is the first half of
 * making the `memo` real: handlers written inline in the parent's `.map()` —
 * `onSelect={() => open(row.id)}` — are a fresh function identity on every parent render, so the
 * shallow compare fails for every row, every time, and the component is memo'd in name only. The
 * parent `useCallback`s these once and the row passes itself back in.
 *
 * **`sameRow` is the second half, and without it the first buys nothing.** `flattenTree` mints a
 * fresh wrapper object for every row on every rebuild — and it rebuilds whenever the note array
 * changes, which is every autosave. A default shallow compare sees four hundred new `row` props
 * and re-renders four hundred rows because one note's word count moved. What actually decides
 * whether a row looks different is the *identity of the note or book inside the wrapper*, which
 * `notesStore` preserves for every row it did not touch (`notes.map` replaces one element). So the
 * comparator reaches through the wrapper.
 */
function sameRow(a: Row, b: Row): boolean {
  if (a.kind !== b.kind || a.id !== b.id || a.depth !== b.depth) return false;
  if (a.kind === "book" && b.kind === "book") {
    return a.book === b.book && a.noteCount === b.noteCount;
  }
  if (a.kind === "note" && b.kind === "note") return a.note === b.note;
  return false;
}

export const NoteTreeRow = memo(function NoteTreeRow({
  row,
  active,
  collapsed,
  dropEdge,
  dragging,
  focused,
  untitledLabel,
  onSelect,
  onToggle,
  onMenu,
  onPressDown,
  onHover,
  onDrop,
}: {
  row: Row;
  active: boolean;
  collapsed: boolean;
  /**
   * Where in this row the in-flight drag would land, or `null` for "not here".
   *
   * `into` washes the whole row — it is being filed into this book. `before`/`after` draw a line
   * along the edge the item would be inserted at, which is the only honest way to show a *position*:
   * a highlighted row would say "in here" when what is about to happen is "next to here".
   */
  dropEdge: DropEdge;
  /** This row owns the tree's single tab stop. */
  focused: boolean;
  /** *This* row is the one being dragged, so it dims rather than highlighting under the pointer. */
  dragging: boolean;
  /**
   * What an untitled note reads as.
   *
   * Passed in rather than looked up here, and that is not fussiness: `useT` subscribes to
   * `languageStore`, and a subscription per row is four hundred subscriptions re-checked on every
   * store write in the app. The parent holds the one subscription and hands down a string.
   */
  untitledLabel: string;
  onSelect: (row: Row) => void;
  onToggle: (row: Row) => void;
  onMenu: (event: React.MouseEvent, row: Row) => void;
  onPressDown: (event: React.PointerEvent, row: Row) => void;
  /**
   * Called on every pointer move over this row — which is most of them, so it takes the raw event
   * and the parent decides.
   *
   * *Which part* of the row the pointer is in is what a drop needs, and answering it means
   * measuring the row: a `getBoundingClientRect` on every mouse move over every row is a forced
   * layout the tree does not need when nothing is being dragged. The parent knows whether a drag
   * is live, so it is the one that reads `event.currentTarget` — synchronously, in the handler,
   * the same way `onPressDown` already does.
   */
  onHover: (event: React.PointerEvent, row: Row) => void;
  onDrop: (event: React.PointerEvent, row: Row) => void;
}) {
  const isBook = row.kind === "book";

  // The indent is inline rather than a Tailwind class because depth is unbounded — a class per
  // level would be a map of arbitrary size, and the arbitrary bit is exactly what a style handles.
  const indent = 6 + row.depth * 12;

  const Glyph: LucideIcon = isBook ? (collapsed ? Book : BookOpen) : FileText;
  const tint = isBook ? bookInk(row.book.color) : undefined;

  return (
    <div
      role="treeitem"
      aria-expanded={isBook ? !collapsed : undefined}
      aria-selected={active}
      aria-level={row.depth + 1}
      // Roving tabindex: exactly one row is in the tab order at a time and the arrow keys move
      // which. A tree of four hundred rows each taking a tab stop is a tree nobody can tab past —
      // this is the pattern the ARIA tree spec asks for, and the reason the key handling lives on
      // the container rather than here.
      tabIndex={focused ? 0 : -1}
      data-note-row={row.id}
      onClick={() => (isBook ? onToggle(row) : onSelect(row))}
      onContextMenu={(event) => onMenu(event, row)}
      onPointerDown={(event) => onPressDown(event, row)}
      // `pointermove` rather than `pointerenter`: the answer changes as the pointer travels
      // *within* a row, which is precisely what the gesture "a little higher than that" is made of.
      onPointerMove={(event) => onHover(event, row)}
      onPointerUp={(event) => onDrop(event, row)}
      style={{ paddingLeft: indent }}
      className={`${ROW} relative cursor-default outline-none focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
        dropEdge === "into"
          ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
          : dragging
            ? "opacity-40"
            : active
              ? ROW_ACTIVE
              : ROW_IDLE
      }`}
    >
      {/* The insertion line. Absolutely positioned and `pointer-events-none` so it can straddle the
          row's edge without ever being what the pointer is over — a target that moves out from
          under the cursor as it appears is a target you cannot aim at. */}
      {(dropEdge === "before" || dropEdge === "after") && (
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-[var(--cf-accent)] ${
            dropEdge === "before" ? "-top-px" : "-bottom-px"
          }`}
          style={{ left: indent }}
        />
      )}

      {isBook ? (
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-muted)]">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
      ) : (
        // The chevron's width, kept as empty space, so note titles line up with book names
        // instead of sitting twelve pixels to their left.
        <span className="w-3.5 shrink-0" aria-hidden />
      )}

      <Glyph size={13} className="shrink-0" style={tint ? { color: tint } : undefined} />

      <span className={`min-w-0 flex-1 truncate ${isBook ? "font-medium" : ""}`}>
        {isBook ? (
          row.book.name
        ) : row.note.title ? (
          row.note.title
        ) : (
          // Italic and muted so it reads as the absence of a title rather than as a note actually
          // called this.
          <span className="italic text-[var(--cf-text-muted)]">{untitledLabel}</span>
        )}
      </span>

      {!isBook && row.note.pinned && (
        <Pin size={10} className="shrink-0 text-[var(--cf-accent)]" fill="currentColor" />
      )}

      {isBook && row.noteCount > 0 && (
        <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
          {row.noteCount}
        </span>
      )}
    </div>
  );
},
// The wrapper object is new on every tree rebuild; the note or book inside it is not. See the
// component's doc comment — this is what makes the memo hold across an autosave.
(previous, next) =>
  sameRow(previous.row, next.row) &&
  previous.active === next.active &&
  previous.collapsed === next.collapsed &&
  previous.dropEdge === next.dropEdge &&
  previous.dragging === next.dragging &&
  previous.focused === next.focused &&
  previous.untitledLabel === next.untitledLabel &&
  previous.onSelect === next.onSelect &&
  previous.onToggle === next.onToggle &&
  previous.onMenu === next.onMenu &&
  previous.onPressDown === next.onPressDown &&
  previous.onHover === next.onHover &&
  previous.onDrop === next.onDrop,
);
