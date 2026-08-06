import { useState, type ReactNode } from "react";
import { MoreHorizontal, Pencil, Pin } from "lucide-react";
import type { MenuItem } from "../api/CollectionTree";
import { riseDelay } from "../../lib/rise";

/** Where a row's menu was asked for. Only the id is kept, never the row itself: a turn landing
 * replaces the row object, and a menu built from the copy captured on right-click would go on
 * offering "Stop" for a run that has already finished. */
export type RowMenu = { x: number; y: number; id: string };

/** Joins menu blocks, drawing the hairline at each seam. Blocks rather than a flat list with
 * `separated` flags because half these items are conditional — pinned to an item that drops out,
 * the separator drops out with it and the groups silently run together. */
export function menuBlocks(...blocks: MenuItem[][]): MenuItem[] {
  return blocks
    .filter((block) => block.length > 0)
    .flatMap((block, i) => (i === 0 ? block : [{ ...block[0], separated: true }, ...block.slice(1)]));
}

/** How far one level of nesting moves a row in. Small on purpose: the deepest thing this tree draws
 * is a chain's step inside a folder, which is two levels, and a generous indent would spend a
 * quarter of a 320px rail saying so. */
const INDENT = 14;

/**
 * One row of the agent list — a folder, a chain, a task, a chain's step or a template, all of which
 * are "a thing with a glyph, a name, a line of context and a menu".
 *
 * It lives in its own file rather than beside either of its callers because both the tree and the
 * flat status/agent groupings draw it: kept private to one of them, the other would grow a near
 * copy, and the two would drift the first time a row gained a mark.
 *
 * The row is a div wrapping a button rather than a button, because the "…" is a button too and one
 * cannot legally sit inside the other — and for the same reason the chevron `leading` slot is
 * rendered outside the main button by its caller's own element. It keeps its width whether or not
 * the pointer is over the row: revealing the "…" by making space would shift every name to the left
 * as the mouse moved down the list.
 */
export function Row({
  selected,
  onClick,
  onMenu,
  title,
  glyph,
  label,
  meta,
  menuLabel,
  depth = 0,
  at = 0,
  leading,
  chip,
  pinned = false,
  muted = false,
}: {
  selected: boolean;
  onClick: () => void;
  onMenu: (x: number, y: number) => void;
  title: string;
  glyph: ReactNode;
  label: string;
  meta: string;
  menuLabel: string;
  /** Levels of nesting. 0 is a section's own child. */
  depth?: number;
  /** Position in the list it arrives with, which is all the entry animation needs to stagger. */
  at?: number;
  /** Rendered before the glyph — the expander of a row that has children. Its own click handler
   * must stop propagating, or opening a chain would also select it. */
  leading?: ReactNode;
  /** A trailing muted pill. The pinned section uses it to say which folder a row came from, which
   * is the one thing pinning takes away. */
  chip?: string;
  pinned?: boolean;
  /** A row that cannot be opened — a chain step whose task does not exist. It still has to be
   * *there*, or the plan would read as shorter than it is. */
  muted?: boolean;
}) {
  return (
    <div
      // Right-clicking deliberately does *not* select the row the way the file tree's does: the
      // menu acts on the row it was opened from, and selecting would swap the middle column —
      // taking with it any follow-up half-typed into the open task's composer.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
      style={{ paddingLeft: depth * INDENT, ...riseDelay(at) }}
      className={`cf-rise group relative flex w-full items-start rounded-md ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      {leading && <span className="mt-[5px] flex shrink-0 items-center pl-1">{leading}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={muted}
        aria-current={selected ? "page" : undefined}
        title={title}
        className={`flex min-w-0 flex-1 items-start gap-2 rounded-md py-1.5 text-left ${
          leading ? "pl-1" : "pl-2"
        } ${muted ? "cursor-default" : ""}`}
      >
        <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">{glyph}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            {pinned && <Pin size={10} className="shrink-0 text-[var(--cf-text-muted)]" />}
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${
                selected ? "text-[var(--cf-accent)]" : muted ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"
              }`}
            >
              {label}
            </span>
          </span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{meta}</span>
        </span>
        {chip && (
          <span className="mt-[1px] max-w-[38%] shrink-0 truncate rounded bg-black/[0.05] px-1.5 py-[1px] text-[10px] text-[var(--cf-text-muted)] dark:bg-white/[0.07]">
            {chip}
          </span>
        )}
      </button>
      {/* The same menu the right-click opens. Right-click is not discoverable on its own, and this
          list is where someone goes looking for how to get rid of a row. */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={menuLabel}
        title={menuLabel}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu(rect.right - 4, rect.bottom + 2);
        }}
        className="mr-1 mt-[5px] flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:bg-black/[0.06] hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-white/[0.1]"
      >
        <MoreHorizontal size={13} />
      </button>
    </div>
  );
}

/** A row turned into a text field. Its own component so it mounts with the current name as its
 * initial value — and unmounts when the rename ends, which is what stops a half-typed draft from
 * turning up the next time any row is renamed. */
export function RenameRow({
  value,
  onCommit,
  onCancel,
  depth = 0,
}: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  depth?: number;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div
      style={{ paddingLeft: depth * INDENT }}
      className="flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-1"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <Pencil size={12} className="text-[var(--cf-text-muted)]" />
      </span>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(draft);
          if (e.key === "Escape") onCancel();
        }}
        className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-transparent px-1 py-0.5 text-[12px] text-[var(--cf-text)] outline-none"
      />
    </div>
  );
}
