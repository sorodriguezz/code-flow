import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ClipboardCopy,
  EyeOff,
  FilePlus,
  FolderOpen,
  FolderPlus,
  ListTree,
  PenLine,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  createDir,
  createFile,
  deletePath,
  listDir,
  movePath,
  renamePath,
  revealInFileManager,
} from "../../lib/tauri/commands";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { HiddenFilesSection } from "./HiddenFilesSection";
import {
  EMPTY_NESTS,
  EMPTY_PARENTS,
  resolveNesting,
  type NestingLayout,
} from "../../lib/fileNesting";
import { confirmAction } from "../../state/confirmStore";
import { useFileNestingStore } from "../../state/fileNestingStore";
import { useHiddenFilesStore } from "../../state/hiddenFilesStore";
import { usePackageManagerStore } from "../../state/packageManagerStore";
import { SkeletonRows } from "../common/Skeleton";
import type { FileEntry } from "../../types/domain";
import { fileStatusColor, fileStatusLabelKey } from "../../lib/fileStatus";
import { FileGlyph, FileGlyphView } from "../common/FileGlyph";
import { useIconRulesStore } from "../../state/iconRulesStore";
import type { IconRule } from "../../lib/icons/rules";
import { useRepoStore } from "../../state/repoStore";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useRowHoverStore } from "../../state/rowHoverStore";
import { canDropInto, useTreeDragStore, type TreeDrag } from "../../state/treeDragStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";
import { useMinimumSpin } from "../../lib/useMinimumSpin";

/** Repo-relative path of the directory holding `path` ("" for a top-level entry). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

type DraftKind = "file" | "dir";

/** The explorer actions something outside the tree can ask for. Four of them are keybindings, and
 * they all act on the focused row — which is why they live here rather than in the shortcut
 * registry: the registry has no view of the tree. The last two are the odd ones out, and they
 * carry a path: `reveal` a *directory*, which is what an external file drop uses to show what just
 * landed, and `revealFile` a *file*, which is the whole path treatment — open every folder above
 * it, list them, unfold the nest it may sit in, and scroll its row into view.
 *
 * Two members rather than one with a heuristic on the path: the tree cannot tell a file from a
 * directory by looking at the string, and the two are different jobs. One re-lists a folder; the
 * other has to find a row that does not exist yet. */
export type ExplorerCommand = "newFile" | "newFolder" | "rename" | "delete" | "reveal" | "revealFile";

/** An in-progress "new file"/"new folder" entry: the inline input VS Code shows inside the
 * target directory, rather than a modal. */
interface Draft {
  parent: string;
  kind: DraftKind;
}

function ToolbarButton({
  onClick,
  title,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  title: string;
  /** The accessible name, for when the tooltip says more than the name does — a title carrying a
   * "— and here is what it will do" hint reads badly out loud. Defaults to `title`. */
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}

/**
 * The inline name input, used for all three of "new file", "new folder" and "rename" — they are
 * the same gesture (type a name into the tree, Enter to commit, Escape to abandon) and differ only
 * in what they are seeded with and what the Enter does.
 */
function DraftRow({
  kind,
  depth,
  initial = "",
  onSubmit,
  onCancel,
}: {
  kind: DraftKind;
  depth: number;
  /** Pre-filled name. Set when renaming; empty when creating. */
  initial?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);


  // Renaming opens with the *stem* selected rather than the whole name: the extension is almost
  // never the part being changed, and having to un-select it before typing is the difference
  // between a rename and a retype. Only on mount — re-selecting on every keystroke would fight
  // the caret.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !initial) return;
    const dot = initial.lastIndexOf(".");
    if (kind === "file" && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{ paddingLeft: depth * 14 + 6 }}
      className="flex items-center gap-1.5 py-0.5 pr-2 text-[13px]"
    >
      <span className="w-3 shrink-0" />
      {/* Follows what is being typed, so a rule that claims `.spec.ts` shows its icon before the
          file exists — which is also the fastest way to check a rule you just wrote. */}
      <FileGlyph path={name || (kind === "dir" ? "folder" : "file.txt")} isFolder={kind === "dir"} />
      <input
        ref={inputRef}
        autoFocus
        value={name}
        placeholder={t(kind === "dir" ? "editor.newFolderPlaceholder" : "editor.newFilePlaceholder")}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(name);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        // Clicking away abandons the entry rather than committing it — a half-typed name
        // losing focus shouldn't leave a stray file behind.
        onBlur={onCancel}
        className="min-w-0 flex-1 rounded-sm border border-[var(--cf-accent)] bg-[var(--cf-bg)] px-1 py-0 text-[13px] text-[var(--cf-text)] outline-none"
      />
    </div>
  );
}

/**
 * The twisty on a *file* row — the one that unfolds a manifest's scripts, and the one that unfolds
 * a nest.
 *
 * **A `span` with `role="button"`, never a `<button>`.** The row itself is already a `<button>`,
 * and a button inside a button is invalid HTML that the parser un-nests — which takes the row's own
 * click target apart. The alternative, turning the row into a `<div role="button">` the way
 * `EditorTabs` does so it can carry a real close button, would cost every row in this tree the
 * native keyboard activation that nothing else here provides.
 *
 * Both `stopPropagation`s are load-bearing and for different reasons: on `pointerdown` because
 * without it reaching for the twisty arms a drag of the file (`onBeginDrag`), and on `click`
 * because without it the same tap also opens the file. It occupies exactly the `w-3` the spacer
 * did, so every indent measurement and the `data-cf-treepath` the drag hit-test reads are
 * untouched.
 *
 * The cost is that a twisty is not reachable by keyboard — `tabIndex={-1}` keeps it out of the tab
 * order rather than putting an un-activatable stop in it. Both twisties therefore have an
 * equivalent in the row's context menu, which is reachable from the keyboard.
 */
function RowTwisty({
  open,
  title,
  onToggle,
}: {
  open: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-expanded={open}
      aria-label={title}
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="flex w-3 shrink-0 items-center justify-center"
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </span>
  );
}

/**
 * One row, and its subtree when it is an expanded folder.
 *
 * `memo`'d, which is what keeps the tree still while things happen *around* it: opening the context
 * menu, the refresh spinner, a drag crossing folders, the drop-target ring on the root. Every prop
 * below is stable by construction — the callbacks are `useCallback`s in `FileTree` (and, for the
 * two that come from outside, in `EditorView`), the maps and sets are `useMemo`s — because a single
 * re-identified prop turns this from a wall into a per-row comparison that never stops anything.
 */
const TreeNode = memo(function TreeNode({
  entry,
  depth,
  selectedPath,
  focusedDir,
  focusedFile,
  expanded,
  childrenByDir,
  hiddenCountByDir,
  nestedByDir,
  nestOpen,
  onToggleNest,
  draft,
  renaming,
  onToggleDir,
  onSelectFile,
  onOpenFile,
  onSubmitDraft,
  onCancelDraft,
  onSubmitRename,
  onCancelRename,
  onContextMenu,
  onBeginDrag,
  suppressClick,
  changedPaths,
  changedDirs,
  iconRules,
  defaultFolderIcon,
  at,
}: {
  entry: FileEntry;
  depth: number;
  /** Place among its siblings, which is all the entry animation needs to stagger. */
  at: number;
  selectedPath: string | null;
  /** The clicked directory, when the last click landed on one — null while a file holds the
   * selection, so only ever one row reads as selected. */
  focusedDir: string | null;
  /**
   * The file the explorer's own actions are aimed at — the last file row clicked, or the one a
   * "Reveal in Explorer" just brought into view.
   *
   * A *second* mark, not a second selection: it draws a ring and only when the row is not already
   * the selected one, which is what keeps "only ever one row reads as selected" true. It exists
   * for the one case `selectedPath` structurally cannot cover — revealing a file from the context
   * menu of a tab that is not the active one, where scrolling to a row and marking nothing leaves
   * the user hunting the very row the action just found for them.
   */
  focusedFile: string | null;
  expanded: Set<string>;
  /** Cached `listDir` results with the hidden rows taken out *and* the nested rows lifted out of
   *  them, keyed by directory ("" = repo root). */
  childrenByDir: Map<string, FileEntry[]>;
  /** How many rows the filter above took out of each directory, so a folder that only *looks*
   *  empty can say which of the two it is. */
  hiddenCountByDir: Map<string, number>;
  /**
   * The rows nested under a file, keyed by the **parent file's own path**.
   *
   * Flat and repo-wide rather than one map per directory: paths are unique across the whole tree,
   * so a single map serves every row and each row does exactly the lookup it wants — no working
   * out which directory it lives in first. Empty (and the *same* empty map every render) when
   * nesting is switched off, so the `memo` above still holds.
   */
  nestedByDir: ReadonlyMap<string, FileEntry[]>;
  /** The file rows whose nest is unfolded. Its own set, not `expanded` — see where it is declared
   *  in `FileTree`. */
  nestOpen: Set<string>;
  onToggleNest: (path: string) => void;
  draft: Draft | null;
  /** The path being renamed in place, if it's this one. */
  renaming: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onSubmitDraft: (name: string) => void;
  onCancelDraft: () => void;
  onSubmitRename: (name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  /** Arms a possible move — the row only becomes a drag once the pointer travels far enough. */
  onBeginDrag: (e: React.PointerEvent<HTMLElement>, entry: FileEntry) => void;
  /** True once, right after a drag, so the trailing click doesn't also select the row. */
  suppressClick: () => boolean;
  changedPaths: Map<string, string>;
  /** Every directory with something changed *under* it, pre-walked once in `EditorView`. */
  changedDirs: Set<string>;
  /** The active icon profile, subscribed to once at the tree's root and handed down — see
   * `FileGlyphView` for why this is a prop and not a store read. */
  iconRules: IconRule[];
  defaultFolderIcon: string | null;
  /** The `package.json` rows whose scripts are unfolded. Separate from `expanded` on purpose —
   *  see the note where it is declared in `FileTree`. */
}) {
  const t = useT();
  const isExpanded = entry.is_dir && expanded.has(entry.path);
  const children = childrenByDir.get(entry.path) ?? null;
  // Folders never nest and are never nested — see `resolveNesting` — so the lookup is skipped for
  // them rather than relied on to miss.
  const nested = entry.is_dir ? null : (nestedByDir.get(entry.path) ?? null);
  const nestShown = nested !== null && nestOpen.has(entry.path);

  // Subscribed as *booleans about this row*, never as the raw drag state: `hover(dir)` fires on
  // every folder the pointer crosses, and a row that took `drag`/`overDir` themselves would
  // re-render every row in the tree on each of those. The same shape `CollectionTree` and
  // `HostExplorer` use.
  const anyDrag = useTreeDragStore((s) => s.drag !== null);
  const isDragging = useTreeDragStore((s) => s.drag?.path === entry.path);
  const isDropTarget = useTreeDragStore((s) => s.overDir === entry.path && entry.is_dir);
  // Only this row and the one being left re-render when the pointer moves between them, which is
  // what makes tracking hover in state affordable on a tree this size.
  const hoverKey = `tree:${entry.path}`;
  const isHovered = useRowHoverStore((s) => s.key === hoverKey);

  const isSelected = entry.is_dir ? focusedDir === entry.path : selectedPath === entry.path;
  // See `focusedFile`: the ring stands in for the highlight when the revealed file is not the one
  // open in the editor. Never both — a row that is already selected says so with its background.
  const isRevealed = !entry.is_dir && !isSelected && focusedFile === entry.path;
  const ownStatus = changedPaths.get(entry.path);
  // A directory doesn't have its own git status, but VS Code-style explorers still color
  // it when something inside changed. One Set lookup: this used to spread `changedPaths.keys()`
  // into an array and scan it *per directory row, per render*, which on a repo with a few hundred
  // changed files was the single most expensive line in the tree.
  const hasChangedDescendant = entry.is_dir && !ownStatus && changedDirs.has(entry.path);
  // Exactly the symmetry above, applied to the other kind of row that now hides things: a closed
  // nest holding a modified spec would otherwise put that change in the Changes tab and nowhere in
  // the tree. Only the *colour* follows — the status letter below stays the file's own, or it
  // would stop meaning "this file differs" and start meaning "something around here does".
  const nestHasChange =
    nested !== null && !nestShown && !ownStatus && nested.some((child) => changedPaths.has(child.path));
  const status = ownStatus ?? (hasChangedDescendant || nestHasChange ? "modified" : undefined);
  const color = status ? fileStatusColor(status) : undefined;

  const draftHere = draft && draft.parent === entry.path ? draft : null;

  // Renaming replaces the row rather than floating over it, so the name stays where the eye
  // already is and the tree doesn't reflow around a dialog.
  if (renaming === entry.path) {
    return (
      <DraftRow
        kind={entry.is_dir ? "dir" : "file"}
        depth={depth}
        initial={entry.name}
        onSubmit={onSubmitRename}
        onCancel={onCancelRename}
      />
    );
  }

  /**
   * Everything a child row simply inherits, gathered once.
   *
   * This component now recurses from two places — a folder's contents and a file's nest — and a
   * prop added to one hand-written list and forgotten in the other is a subtree that silently
   * stops responding to it. Spreading an object costs the `memo` nothing: it compares the
   * resulting props one by one, and every value in here is the same stable reference it was.
   */
  const inherited = {
    selectedPath,
    focusedDir,
    focusedFile,
    expanded,
    childrenByDir,
    hiddenCountByDir,
    nestedByDir,
    nestOpen,
    onToggleNest,
    draft,
    renaming,
    onToggleDir,
    onSelectFile,
    onOpenFile,
    onSubmitDraft,
    onCancelDraft,
    onSubmitRename,
    onCancelRename,
    onContextMenu,
    onBeginDrag,
    suppressClick,
    changedPaths,
    changedDirs,
    iconRules,
    defaultFolderIcon,
  };

  return (
    <div>
      <button
        data-cf-treepath={entry.path}
        data-cf-treedir={entry.is_dir ? "1" : "0"}
        onPointerDown={(e) => onBeginDrag(e, entry)}
        onPointerEnter={() => useRowHoverStore.getState().enter(hoverKey)}
        onPointerLeave={() => useRowHoverStore.getState().leave(hoverKey)}
        // See the same call in `EditorTabs`: stops the press from starting a text selection,
        // while leaving click and double-click intact.
        onMouseDown={(e) => e.preventDefault()}
        onContextMenu={(e) => onContextMenu(e, entry)}
        onClick={() => {
          // A drag ends with a click on the row it started from; the tree must not also treat
          // that as a selection.
          if (suppressClick()) return;
          if (entry.is_dir) onToggleDir(entry.path);
          else onSelectFile(entry.path);
        }}
        onDoubleClick={() => !entry.is_dir && onOpenFile?.(entry.path)}
        style={{ paddingLeft: depth * 14 + 6, ...riseDelay(at) }}
        className={`cf-rise flex w-full items-center gap-1.5 truncate rounded-md py-0.5 pr-2 text-left text-[13px] ${
          isSelected
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : // Nothing but the drop target is highlighted while a drag is in flight.
              isHovered && !anyDrag
              ? "cf-row-hover"
              : ""
        } ${isSelected ? "" : color ? "" : "text-[var(--cf-text-muted)]"} ${
          isDropTarget || isRevealed ? "ring-1 ring-inset ring-[var(--cf-accent)]" : ""
        } ${isDragging ? "opacity-40" : ""}`}
      >
        {entry.is_dir ? (
          <>
            {isExpanded ? (
              <ChevronDown size={12} className="shrink-0" />
            ) : (
              <ChevronRight size={12} className="shrink-0" />
            )}
            <FileGlyphView
              path={entry.path}
              isFolder
              open={isExpanded}
              color={!isSelected && color ? color : undefined}
              rules={iconRules}
              defaultFolderIcon={defaultFolderIcon}
            />
          </>
        ) : (
          <>
            {/* The leading slot — the one that lines up with every folder's chevron and means the
                same thing there as here, "this row has rows under it" — belongs to the nest
                whenever there is one. With nesting off there is never one, so this is exactly the
                layout that shipped: manifest twisty, or spacer. */}
            {nested !== null ? (
              <RowTwisty
                open={nestShown}
                title={t(nestShown ? "nesting.collapse" : "nesting.expand", { n: nested.length })}
                onToggle={() => onToggleNest(entry.path)}
              />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {/* Git status wins over the language color: a modified file has to read as
                modified first, the same way it does in the Changes tab. A custom icon is the one
                exception — it carries its own brand colours and tinting it would make an Angular
                file that changed look like neither. */}
            <FileGlyphView
              path={entry.path}
              color={isSelected ? undefined : (color ?? undefined)}
              rules={iconRules}
              defaultFolderIcon={defaultFolderIcon}
            />
          </>
        )}
        <span className="truncate" style={!isSelected && color ? { color } : undefined}>
          {entry.name}
        </span>
        {ownStatus && (
          <span
            title={t(fileStatusLabelKey(ownStatus))}
            className="ml-auto shrink-0 text-[10px] font-bold uppercase"
            style={{ color }}
          >
            {ownStatus[0]}
          </span>
        )}
      </button>
      {/* The nest. One level deep and no further: `resolveNesting` collapses chains, so every key
          in `nestedByDir` is a row nobody else claimed, and a child handed to this recursion can
          never have a nest of its own — the recursion bottoms out here by construction rather than
          by a depth counter. */}
      {nestShown && nested && (
        <div>
          {nested.map((child, index) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} at={index} {...inherited} />
          ))}
        </div>
      )}
      {isExpanded && (
        <div>
          {draftHere && (
            <DraftRow
              kind={draftHere.kind}
              depth={depth + 1}
              onSubmit={onSubmitDraft}
              onCancel={onCancelDraft}
            />
          )}
          {children?.map((child, index) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} at={index} {...inherited} />
          ))}
          {children && children.length === 0 && !draftHere && (
            <p style={{ paddingLeft: (depth + 1) * 14 + 6 }} className="text-[11px] text-[var(--cf-text-muted)]">
              {/* "Empty" would be a lie about a folder whose every entry is hidden — and the kind
                  of lie that gets reported as a missing file. */}
              {(hiddenCountByDir.get(entry.path) ?? 0) > 0
                ? t("editor.allHiddenHere", { n: hiddenCountByDir.get(entry.path) ?? 0 })
                : t("editor.empty")}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

export function FileTree({
  repoPath,
  selectedPath,
  onSelectFile,
  onOpenFile,
  onPathMoved,
  onPathRemoved,
  command,
  changedPaths,
  changedDirs,
  fsNonce = 0,
  onRefresh,
}: {
  repoPath: string;
  /** The project the terminal dock indexes its shells by. Passed in rather than read from the
   *  project store here: the tree is given its `repoPath` from outside too, and two sources for
   *  one project is how a script ends up running in the previous project's dock. */
  selectedPath: string | null;
  /** Single click — opens the file as a reusable preview tab. */
  onSelectFile: (path: string) => void;
  /** Double click — opens the file for good, pinning its tab. */
  onOpenFile?: (path: string) => void;
  /** A file or folder was moved by dragging. The editor uses this to re-point any tab that was
   * showing it, instead of leaving a tab aimed at a path that no longer exists. */
  onPathMoved?: (from: string, to: string) => void;
  /** A file or folder is gone from disk. The editor closes any tab that was showing it, rather
   * than leaving one aimed at a path that will fail the next time it's read. */
  onPathRemoved?: (path: string) => void;
  /** One of the explorer's actions, asked for from outside and forwarded by `EditorView`. The
   * nonce is what lets the same key fire twice in a row — see `editorCommandStore`. `path` is read
   * by `reveal` (the directory to open and re-list) and by `revealFile` (the file to bring into
   * view); the other four act on the focused row and ignore it. */
  command?: { command: ExplorerCommand; nonce: number; path?: string } | null;
  changedPaths: Map<string, string>;
  /** Every directory with a changed file somewhere under it. Derived alongside `changedPaths` in
   * `EditorView`, in the same walk, so a directory row can answer "does anything inside me differ?"
   * with one lookup instead of a scan of every changed path. */
  changedDirs: Set<string>;
  /**
   * Bumped by `EditorView` whenever the file watcher says this repository moved on disk.
   *
   * The tree had no connection to the watcher at all: `refresh()` was reachable only from the
   * toolbar button, so a file created by a script, a `git checkout`, a branch switch or an agent
   * writing into the working tree left the explorer showing the directory as it was — and the only
   * way to see the truth was to press refresh, which is exactly what a file explorer is supposed to
   * spare you. Open *tabs* were already synced from the same event (`syncOpenTabs`); the tree was
   * the half that never got wired.
   *
   * A nonce rather than a callback, for the same reason `command` above is one: the tree owns its
   * expansion set and its listing cache, and nobody outside it can re-list without them.
   */
  fsNonce?: number;
  /**
   * Extra work the container wants done when the toolbar's Refresh is pressed.
   *
   * That button used to re-list directories and nothing else, so pressing it on a screen that
   * looked stale left every open buffer and every git badge exactly as stale as before — the
   * opposite of what a refresh button is for. The tree still owns its own re-listing; this is the
   * rest of the screen, and that belongs to whoever mounted the tree.
   */
  onRefresh?: () => void;
}) {
  const t = useT();
  // Expansion and the listing cache both live here rather than in each node, so "collapse
  // all" and "refresh" can act on the whole tree at once. "" keys the repo root.
  const [childrenByDir, setChildrenByDir] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * `expanded`, readable from a callback that must not re-identify when it changes.
   *
   * `refresh()` needs the current expansion set, but it also *writes* one — and a `useCallback`
   * that both depends on `expanded` and replaces it re-creates itself on every run. The watcher
   * effect below lists `refresh` in its dependencies, so that re-creation re-armed its timer and
   * scheduled the next sweep: one filesystem event turned the explorer into a permanent 250ms
   * poll over every open directory, for the rest of the session. Assigned during render, like
   * `tRef` and `childrenRef`, so a sweep started on this render reads this render's set.
   */
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /**
   * The file rows whose nest is unfolded.
   *
   * Its own Set for exactly the reason `openScripts` is, and the failure is worse here. `refresh()`
   * calls `listDir` on every member of `expanded`; a *file* path in there reaches
   * `fsops::list_dir`, which calls `read_dir` on a file and fails — and the `() => null` that
   * catches it drops that entry, so the directory falls out of the listing cache entirely. On top
   * of which `refresh` rebuilds `expanded` from whatever answered, which would close every nest on
   * every refresh, including the ones the file watcher fires.
   */
  const [nestOpen, setNestOpen] = useState<Set<string>>(new Set());
  // The clicked row, which is what decides where a new file/folder lands, mirroring VS Code:
  // inside the clicked directory, or alongside the clicked file, or at the root.
  const [focus, setFocus] = useState<{ path: string; isDir: boolean }>({ path: "", isDir: true });
  /** `t` behind a ref, so the callbacks that only *read* a string when they run don't have to
   * re-create on every language render. */
  const tRef = useRef(t);
  tRef.current = t;
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The repo-relative path whose row is currently an input, if any. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  /**
   * The toolbar Refresh's spinner, floored so it is actually visible.
   *
   * Re-listing a few directories over local IPC finishes inside one frame, so a plain boolean was
   * set and cleared in the same React batch and the icon never moved — the button worked and read
   * as dead. The Changes panel's Refresh uses the same hook, which is what makes the two agree.
   */
  const [refreshing, runRefreshing] = useMinimumSpin();
  /**
   * The file a `revealFile` still owes a scroll to, or null.
   *
   * State and not a ref, deliberately: the row does not exist until the listings the request
   * awaited have been *drawn*, so the second half of the job has to be a render away from the
   * first. A ref would be read once, on a tick where there is still nothing to find.
   */
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  /** The tree's own scroller, so a reveal looks for its row inside this tree and nowhere else. */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const childrenRef = useRef(childrenByDir);
  // Listings are async, so a switch to another project can land while one is in flight —
  // every write compares against this before touching state.
  const activeRepoRef = useRef(repoPath);
  const hiddenEntries = useHiddenFilesStore((s) => s.entries);
  const loadHidden = useHiddenFilesStore((s) => s.load);
  const hideEntry = useHiddenFilesStore((s) => s.hide);
  /** Subscribed once here rather than twice per row: every row's glyph wants these, and this
   * component re-renders as a whole when they change, so the rows can take them as props. */
  const iconRules = useIconRulesStore((s) => s.rules);
  const defaultFolderIcon = useIconRulesStore((s) => s.defaultFolderIcon);
  /** The nesting preference. No per-repo `load` to go with it, unlike the two above: a pattern
   *  names filenames rather than paths, so the setting is global and `App` reads it once at
   *  startup. */
  const nestingEnabled = useFileNestingStore((s) => s.enabled);
  const nestingPatterns = useFileNestingStore((s) => s.patterns);
  /** The repo-wide override, or null while the lockfile decides. Subscribed here so that changing
   *  it re-resolves every unfolded manifest at once. */
  const loadManager = usePackageManagerStore((s) => s.load);

  useEffect(() => {
    childrenRef.current = childrenByDir;
  }, [childrenByDir]);

  useEffect(() => {
    void loadHidden(repoPath);
    void loadManager(repoPath);
  }, [repoPath, loadHidden, loadManager]);

  const loadDir = useCallback(
    async (path: string) => {
      const entries = await listDir(repoPath, path || undefined);
      if (activeRepoRef.current !== repoPath) return;
      setChildrenByDir((prev) => new Map(prev).set(path, entries));
    },
    [repoPath],
  );

  useEffect(() => {
    activeRepoRef.current = repoPath;
    let cancelled = false;
    setChildrenByDir(new Map());
    setExpanded(new Set());
    setNestOpen(new Set());
    setFocus({ path: "", isDir: true });
    setDraft(null);
    setRenaming(null);
    setMenu(null);
    // A reveal aimed at the repository being left behind: its row is never going to appear here,
    // and leaving the target standing would have the effect below re-run on every listing of the
    // new project looking for a path that belongs to the old one.
    setRevealTarget(null);
    void listDir(repoPath).then((entries) => {
      if (!cancelled) setChildrenByDir(new Map([["", entries]]));
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const toggleDir = useCallback(
    (path: string) => {
      setFocus({ path, isDir: true });
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else {
          next.add(path);
          // Always re-list on expand: any cached entries render immediately (so collapsing
          // and reopening a folder doesn't flash empty) and get replaced once the fresh
          // listing lands, which is what keeps the tree honest without hitting Refresh.
          void loadDir(path);
        }
        return next;
      });
    },
    [loadDir],
  );

  // Owns no spinner of its own: the watcher calls this several times a minute and a flag flipped
  // from there would put a spinner in the toolbar for changes nobody asked about. Only the button
  // spins, and it does that by wrapping the call — see `useMinimumSpin`.
  const refresh = useCallback(async () => {
    const dirs = ["", ...expandedRef.current];
    const results = await Promise.all(
      dirs.map((dir) =>
        listDir(repoPath, dir || undefined).then(
          (entries) => [dir, entries] as [string, FileEntry[]],
          // A directory that disappeared since it was expanded simply drops out of both
          // the cache and the expanded set instead of failing the whole refresh.
          () => null,
        ),
      ),
    );
    if (activeRepoRef.current !== repoPath) return;
    const loaded = results.filter((r): r is [string, FileEntry[]] => r !== null);
    setChildrenByDir(new Map(loaded));
    // Only when a directory actually dropped out. The overwhelmingly common sweep re-lists the
    // same folders that were already open, and handing back a fresh `Set` for that re-renders
    // every row of the tree for no change — the same trade `syncOpenTabs` makes when a file
    // comes back byte for byte identical. It is also half of the fix above: a new `Set` on
    // every sweep is what re-identified this callback in the first place.
    setExpanded((prev) => {
      const next = loaded.map(([dir]) => dir).filter((dir) => dir !== "");
      return next.length === prev.size && next.every((dir) => prev.has(dir)) ? prev : new Set(next);
    });
  }, [repoPath]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
    // Nests too: they are rows under a row, which is the only thing "collapse" means here.
    setNestOpen(new Set());
    setDraft((prev) => (prev && prev.parent !== "" ? null : prev));
  }, []);

  /** Deps deliberately empty: `TreeNode` is `memo`'d on the assumption that its callbacks never
   *  change identity, and this one has nothing to close over. */
  const toggleNest = useCallback(
    (path: string) =>
      setNestOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    [],
  );

  const startDraft = useCallback(
    (kind: DraftKind) => {
      const parent = focus.isDir ? focus.path : parentDir(focus.path);
      if (parent) {
        setExpanded((prev) => new Set(prev).add(parent));
        if (!childrenRef.current.has(parent)) void loadDir(parent);
      }
      setDraft({ parent, kind });
    },
    [focus, loadDir],
  );

  const submitDraft = useCallback(
    async (name: string) => {
      if (!draft) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setDraft(null);
        return;
      }
      const relPath = draft.parent ? `${draft.parent}/${trimmed}` : trimmed;
      try {
        if (draft.kind === "dir") await createDir(repoPath, relPath);
        else await createFile(repoPath, relPath);
      } catch (e) {
        // The input stays open on failure (name taken, illegal characters) so the name can
        // be corrected without starting over.
        pushErrorToast(String(e));
        return;
      }
      setDraft(null);
      await loadDir(draft.parent);
      // A new file is untracked, and the Changes tab / tree indicators read git status from
      // repoStore — refresh it here rather than waiting on the fs watcher's debounce.
      void useRepoStore.getState().refreshStatus();
      if (draft.kind === "file") onOpenFile?.(relPath);
    },
    [draft, repoPath, loadDir, onOpenFile],
  );

  /**
   * The watcher's answer, coalesced.
   *
   * `refresh()` re-lists every expanded directory, so one call per event would turn a `pnpm build`
   * into a burst of `listDir`s over a tree nobody is looking at that closely. The wait is short
   * enough to feel immediate for the single-file case — a save from another editor, a generated
   * file — and long enough that a checkout's thousands of events cost one sweep.
   *
   * Skipped on the first render: `fsNonce` starts at 0 and the initial listing has just been done
   * by the mount effect above.
   */
  useEffect(() => {
    if (fsNonce === 0) return;
    const id = window.setTimeout(() => void refresh(), 250);
    return () => window.clearTimeout(id);
  }, [fsNonce, refresh]);

  const cancelDraft = useCallback(() => setDraft(null), []);

  /** Renaming the focused row. A folder can be renamed too; only the repo root can't. */
  const startRename = useCallback(() => {
    if (!focus.path) return;
    setDraft(null);
    setRenaming(focus.path);
  }, [focus.path]);

  const submitRename = useCallback(
    async (name: string) => {
      const from = renaming;
      if (!from) return;
      const trimmed = name.trim();
      if (!trimmed || trimmed === from.split("/").pop()) {
        setRenaming(null);
        return;
      }
      try {
        const to = await renamePath(repoPath, from, trimmed);
        setRenaming(null);
        await loadDir(parentDir(from));
        void useRepoStore.getState().refreshStatus();
        // A renamed folder takes every open file under it with it, which is why the editor is told
        // the prefix rather than each path — see `handlePathMoved`.
        onPathMoved?.(from, to);
        setFocus({ path: to, isDir: expanded.has(from) || childrenRef.current.has(from) });
      } catch (e) {
        // Left open on failure, the same as a new-file name that collided: the name is right there
        // to be corrected.
        pushErrorToast(String(e));
      }
    },
    [renaming, repoPath, loadDir, onPathMoved, expanded],
  );

  const cancelRename = useCallback(() => setRenaming(null), []);

  /**
   * Deleting the focused row.
   *
   * Confirmed first and then sent to the OS trash rather than unlinked — see `fsops::delete_path`.
   * The confirm names what is going and says where it goes, because "Delete" on a folder in a tree
   * is one click away from being the wrong folder.
   */
  const deleteFocused = useCallback(async () => {
    const target = focus.path;
    if (!target) return;
    const name = target.split("/").pop() ?? target;
    if (!(await confirmAction(tRef.current("editor.deleteConfirm", { name })))) return;
    try {
      await deletePath(repoPath, target);
    } catch (e) {
      pushErrorToast(String(e));
      return;
    }
    const parent = parentDir(target);
    setFocus({ path: parent, isDir: true });
    setExpanded((prev) => {
      // A deleted folder leaves its own key and its descendants' behind in the expanded set,
      // which would re-list paths that no longer exist on the next refresh.
      const next = new Set([...prev].filter((p) => p !== target && !p.startsWith(`${target}/`)));
      return next;
    });
    // The same tidy-up for nests: a deleted file leaves its own key behind, and a deleted *folder*
    // leaves every unfolded nest under it. Neither would ever be drawn again, but both would keep
    // a path that no longer exists alive in state for the rest of the session.
    setNestOpen((prev) =>
      new Set([...prev].filter((p) => p !== target && !p.startsWith(`${target}/`))),
    );
    await loadDir(parent);
    void useRepoStore.getState().refreshStatus();
    onPathRemoved?.(target);
  }, [focus.path, repoPath, loadDir, onPathRemoved]);

  // The menu is built once per open and its items are closures; reading the actions through refs
  // keeps a click on "Delete" running against the *current* focus rather than whatever it was when
  // the menu was assembled.
  const startDraftRef = useRef(startDraft);
  startDraftRef.current = startDraft;
  const deleteFocusedRef = useRef(deleteFocused);
  deleteFocusedRef.current = deleteFocused;
  /** The nesting layout, for the two menu entries that ask about it. Assigned where it is derived,
   *  far below — see the note there for why it cannot simply be a dependency. */
  const nestRef = useRef<{ nested: ReadonlyMap<string, FileEntry[]>; open: Set<string> }>({
    nested: EMPTY_NESTS,
    open: nestOpen,
  });

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).catch((e) => pushErrorToast(String(e)));
  }, []);

  /** Opens the containing folder in Finder/Explorer. For a file that means its parent: the OS
   * "open" of a *file* launches whatever app owns it, which is a different action entirely. */
  const revealInOs = useCallback(
    (entry: FileEntry | null) => {
      const rel = entry ? (entry.is_dir ? entry.path : parentDir(entry.path)) : "";
      void revealInFileManager(rel ? `${repoPath}/${rel}` : repoPath).catch((e) =>
        pushErrorToast(String(e)),
      );
    },
    [repoPath],
  );

  const openMenu = useCallback((e: React.MouseEvent, entry: FileEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking *is* a selection: every item in the menu acts on the focused row, so the row
    // under the pointer has to become that row before the menu opens.
    setFocus(entry ? { path: entry.path, isDir: entry.is_dir } : { path: "", isDir: true });
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const menuItems = useCallback(
    (entry: FileEntry | null): MenuItem[] => {
      const items: MenuItem[] = [
        { label: t("editor.newFile"), icon: FilePlus, onClick: () => startDraftRef.current("file") },
        { label: t("editor.newFolder"), icon: FolderPlus, onClick: () => startDraftRef.current("dir") },
      ];
      if (entry) {
        items.push(
          { label: t("editor.rename"), icon: PenLine, separated: true, onClick: () => setRenaming(entry.path) },
          {
            label: t("editor.delete"),
            icon: Trash2,
            danger: true,
            onClick: () => void deleteFocusedRef.current(),
          },
        );
      }
      if (entry) {
        // Its own group, away from Delete: the two are the actions most easily confused here, and
        // the one that touches the disk must not sit next to the one that only stops drawing a row.
        items.push({
          label: t("editor.hide"),
          icon: EyeOff,
          separated: true,
          onClick: () => {
            hideEntry({ path: entry.path, isDir: entry.is_dir });
            // The focused row decides where "new file" lands; leaving the focus on something that
            // is no longer drawn would aim the next creation at an invisible folder.
            setFocus({ path: "", isDir: true });
          },
        });
      }
      // Same "view" group as Hide, and offered on the empty space too (`entry === null`): a setting
      // about the explorer is looked for by right-clicking the explorer, not one of its files. The
      // label carries the state because `MenuItem` has no checked form.
      items.push({
        label: t(nestingEnabled ? "nesting.disable" : "nesting.enable"),
        icon: ListTree,
        separated: !entry,
        onClick: () => useFileNestingStore.getState().setEnabled(!nestingEnabled),
      });
      if (entry) {
        const nested = nestRef.current.nested.get(entry.path);
        // The keyboard and screen-reader route to the twisty, which is a `span` and out of the tab
        // order by design — see `RowTwisty`. Only offered where there is actually a nest.
        if (nested && nested.length > 0) {
          const open = nestRef.current.open.has(entry.path);
          items.push({
            label: t(open ? "nesting.collapse" : "nesting.expand", { n: nested.length }),
            onClick: () => toggleNest(entry.path),
          });
        }
      }
      items.push({
        label: t("sidebar.revealInFileManager"),
        icon: FolderOpen,
        separated: true,
        onClick: () => revealInOs(entry),
      });
      if (entry) {
        items.push(
          {
            label: t("editor.copyPath"),
            icon: ClipboardCopy,
            onClick: () => copyToClipboard(`${repoPath}/${entry.path}`),
          },
          { label: t("editor.copyRelativePath"), icon: ClipboardCopy, onClick: () => copyToClipboard(entry.path) },
        );
      }
      return items;
    },
    [t, revealInOs, copyToClipboard, repoPath, hideEntry, nestingEnabled, toggleNest],
  );

  const handleSelectFile = useCallback(
    (path: string) => {
      setFocus({ path, isDir: false });
      onSelectFile(path);
    },
    [onSelectFile],
  );

  /**
   * Moving a file or folder by dragging it onto another folder.
   *
   * Pointer-driven rather than HTML5 drag-and-drop for the same reason the tab strip is: Tauri's
   * native drag handler on the webview intercepts those events before the page sees them. The
   * pointer is hit-tested against the rows' `data-cf-treepath` markers on every move, which is
   * also what lets a *file* row stand in for its parent folder — dropping "next to" something is
   * how people aim.
   */
  const suppressClickRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const treeDrag = useTreeDragStore((s) => s.drag);
  // A boolean, not `overDir` itself: this component only ever asks "is the *root* the target", and
  // subscribing to the raw value re-rendered the whole tree on every folder the pointer crossed.
  const rootIsDropTarget = useTreeDragStore((s) => s.overDir === "");
  const treeOrigin = useTreeDragStore((s) => s.origin);

  const applyMove = useCallback(
    async (from: string, destDir: string) => {
      const fromParent = parentDir(from);
      try {
        const to = await movePath(repoPath, from, destDir);
        if (activeRepoRef.current !== repoPath) return;
        // Both ends changed; the destination may not have been listed yet, in which case this
        // primes it for when it's expanded.
        await Promise.all([loadDir(fromParent), loadDir(destDir)]);
        void useRepoStore.getState().refreshStatus();
        onPathMoved?.(from, to);
      } catch (e) {
        pushErrorToast(String(e));
      }
    },
    [repoPath, loadDir, onPathMoved],
  );

  const beginDrag = useCallback((e: React.PointerEvent<HTMLElement>, entry: FileEntry) => {
    if (e.button !== 0) return;
    const from = { x: e.clientX, y: e.clientY };
    const dragged: TreeDrag = { path: entry.path, isDir: entry.is_dir };
    let started = false;

    /** The folder under the pointer: a folder row itself, a file row's parent, or the root when
     * the pointer is over the tree's empty space. `null` where the move isn't allowed. */
    const dirAt = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const row = el.closest<HTMLElement>("[data-cf-treepath]");
      let dir: string | null = null;
      if (row?.dataset.cfTreepath !== undefined) {
        dir = row.dataset.cfTreedir === "1" ? row.dataset.cfTreepath : parentDir(row.dataset.cfTreepath);
      } else if (el.closest("[data-cf-treeroot]")) {
        dir = "";
      }
      return dir !== null && canDropInto(dragged, dir) ? dir : null;
    };

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_THRESHOLD) return;
        started = true;
        suppressClickRef.current = true;
        setDragCursor(true);
        useTreeDragStore.getState().start(dragged, ev.clientX, ev.clientY);
      }
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      }
      useTreeDragStore.getState().hover(dirAt(ev.clientX, ev.clientY));
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!started) return;
      const dest = dirAt(ev.clientX, ev.clientY);
      setDragCursor(false);
      useTreeDragStore.getState().end();
      if (dest !== null) void applyMoveRef.current(dragged.path, dest);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  const applyMoveRef = useRef(applyMove);
  applyMoveRef.current = applyMove;

  const takeSuppressedClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  /**
   * Keybindings, arriving as requests from `EditorView`.
   *
   * Deliberately the same four actions the context menu offers and no more: a shortcut for
   * "copy relative path" is a shortcut nobody remembers, while new/rename/delete are the ones you
   * reach for mid-flow with a hand already on the keyboard.
   */
  const startRenameRef = useRef(startRename);
  startRenameRef.current = startRename;

  /**
   * Re-lists a directory and opens it, along with every folder on the way down to it.
   *
   * What an external drop calls once its files are on disk. Opening the ancestors is the point:
   * dropping into a collapsed folder deep in the tree would otherwise land the files somewhere the
   * user is told about but can't see, which reads as nothing having happened.
   */
  const revealDir = useCallback(
    (dir: string) => {
      if (dir) {
        const parts = dir.split("/");
        setExpanded((prev) => {
          const next = new Set(prev);
          for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
          return next;
        });
      }
      void loadDir(dir);
    },
    [loadDir],
  );
  const revealDirRef = useRef(revealDir);
  revealDirRef.current = revealDir;

  /**
   * Brings a *file* into view: the "Reveal in Explorer" on an editor tab.
   *
   * The mirror of `revealDir`, and deliberately not the same function. A directory is revealed by
   * opening it; a file is revealed by finding the row that draws it — which may sit in a folder
   * that was never listed, or inside a nest that is folded. So this half opens and lists every
   * folder on the way down and then parks the target, and the effect below does the scroll once
   * the row it is looking for actually exists.
   *
   * The listings go out together rather than one level at a time: `fsops::list_dir` resolves any
   * repo-relative subpath directly, so a directory can be listed without its parent having been
   * listed first. Awaited all the same — the row is drawn from the *leaf* listing, and there is no
   * row to scroll to before it lands.
   */
  const revealFile = useCallback(
    async (file: string) => {
      if (!file) return;
      // A hidden ancestor — or the file itself — is a row that is never drawn, so there would be
      // nothing for the scroll to find and the action would read as broken. Hiding is a filter the
      // user set by hand (see `hiddenFilesStore`), so it is theirs to undo: say so and stop,
      // rather than quietly putting back a row they took out.
      const hidden = useHiddenFilesStore
        .getState()
        .entries.find((entry) => entry.path === file || file.startsWith(`${entry.path}/`));
      if (hidden) {
        useToastStore.getState().pushToast(tRef.current("editor.revealHidden", { name: hidden.path }), "info");
        return;
      }
      const dir = parentDir(file);
      const parts = dir ? dir.split("/") : [];
      const ancestors = parts.map((_, at) => parts.slice(0, at + 1).join("/"));
      // One write, not one per level: every folder on the way down opens on the same render.
      if (ancestors.length > 0) {
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const ancestor of ancestors) next.add(ancestor);
          return next;
        });
      }
      // Caught per level so one directory that has gone away since doesn't take the whole reveal
      // with it — the same trade `refresh` makes.
      await Promise.all(["", ...ancestors].map((each) => loadDir(each).catch(() => {})));
      // The listings are async, so a project switch can have landed while they were in flight.
      if (activeRepoRef.current !== repoPath) return;
      // What a following "new file" or "rename" acts on, so revealing a file also puts the
      // explorer's own keyboard actions on it — which is the state a click on the row would leave.
      setFocus({ path: file, isDir: false });
      setRevealTarget(file);
    },
    [loadDir, repoPath],
  );
  const revealFileRef = useRef(revealFile);
  revealFileRef.current = revealFile;

  // Guarded on the request object rather than its nonce: two callers now share this channel — the
  // keybinding store, which numbers its own requests, and the drop handler, which doesn't — and a
  // number that means different things to each is a number that eventually collides. Identity also
  // still absorbs the double-invoked effect that StrictMode runs in development, which is what the
  // guard was for.
  const handled = useRef<typeof command>(null);
  useEffect(() => {
    if (!command || command === handled.current) return;
    handled.current = command;
    switch (command.command) {
      case "newFile":
        startDraftRef.current("file");
        break;
      case "newFolder":
        startDraftRef.current("dir");
        break;
      case "rename":
        startRenameRef.current();
        break;
      case "delete":
        void deleteFocusedRef.current();
        break;
      case "reveal":
        revealDirRef.current(command.path ?? "");
        break;
      case "revealFile":
        void revealFileRef.current(command.path ?? "");
        break;
    }
  }, [command]);

  /**
   * The listings with the hidden rows taken out, plus how many were taken out of each directory.
   *
   * Filtered here rather than at `listDir`, deliberately: the cache stays the truth about what is
   * on disk, so restoring an entry redraws it immediately instead of needing the folder re-listed.
   * The count is what lets a folder whose every child is hidden say so, rather than claiming to be
   * empty — which is the one way this feature could read as a bug.
   */
  const { visibleByDir, hiddenCountByDir } = useMemo(() => {
    const hidden = new Set(hiddenEntries.map((entry) => entry.path));
    if (hidden.size === 0) {
      return { visibleByDir: childrenByDir, hiddenCountByDir: new Map<string, number>() };
    }
    const visible = new Map<string, FileEntry[]>();
    const counts = new Map<string, number>();
    for (const [dir, entries] of childrenByDir) {
      const kept = entries.filter((entry) => !hidden.has(entry.path));
      visible.set(dir, kept);
      if (kept.length !== entries.length) counts.set(dir, entries.length - kept.length);
    }
    return { visibleByDir: visible, hiddenCountByDir: counts };
  }, [childrenByDir, hiddenEntries]);

  /**
   * The same listings again, with derived files lifted out of their directory and onto their parent.
   *
   * **It consumes the memo above, and that ordering is the whole story for how the two features
   * live together.** Running over the already-filtered lists means a hidden parent never gets the
   * chance to claim anything, so its would-be children simply stay where they were — no special
   * case, no "was the parent hidden?" branch, and no way for hiding one row to take three more with
   * it. It also means `hiddenCountByDir` keeps counting what the filter removed and nothing else:
   * a nested row was not removed, it moved.
   *
   * With nesting off this hands back `visibleByDir` *by identity* and the module's shared empty
   * maps, so not one row's `memo` is invalidated by a feature nobody switched on.
   */
  const { rowsByDir, nestedByDir, nestParentOf } = useMemo<{
    rowsByDir: Map<string, FileEntry[]>;
    nestedByDir: ReadonlyMap<string, FileEntry[]>;
    nestParentOf: ReadonlyMap<string, string>;
  }>(() => {
    if (!nestingEnabled || nestingPatterns.length === 0) {
      return { rowsByDir: visibleByDir, nestedByDir: EMPTY_NESTS, nestParentOf: EMPTY_PARENTS };
    }
    const rows = new Map<string, FileEntry[]>();
    const nested = new Map<string, FileEntry[]>();
    const parents = new Map<string, string>();
    for (const [dir, entries] of visibleByDir) {
      const layout: NestingLayout = resolveNesting(entries, nestingPatterns);
      rows.set(dir, layout.roots);
      // Flattened into two repo-wide maps: paths are unique across the tree, so a row can look
      // itself up without first working out which directory it belongs to.
      for (const [parent, kids] of layout.childrenOf) nested.set(parent, kids);
      for (const [child, parent] of layout.parentOf) parents.set(child, parent);
    }
    return { rowsByDir: rows, nestedByDir: nested, nestParentOf: parents };
  }, [visibleByDir, nestingEnabled, nestingPatterns]);

  // Behind a ref for the same reason the menu's actions are: `menuItems` is declared above this
  // point, and a dependency array cannot name a `const` that is still in its temporal dead zone.
  // The menu is assembled when it opens, by which time this is current — which is also what makes
  // its labels say what the row is doing *now* rather than when the callback was last built.
  nestRef.current = { nested: nestedByDir, open: nestOpen };

  /**
   * Opens the nest holding the file that just became active, and never closes one.
   *
   * The case this exists for: creating `user.service.spec.ts` with the new-file button drops it
   * straight into a closed nest, while `submitDraft` opens it in a tab — so the file is in front of
   * you in the editor and absent from the tree, which is precisely the "it vanished" reading this
   * feature cannot afford. Going through the *selected path* rather than through the creation
   * handler covers the rest of the same class for free: Go to File, a rename that turns a file into
   * a derived one, and the reveal an external drop asks for, none of which need to know that
   * nesting exists.
   */
  /**
   * The nest holding the open file, so selecting a nested file reveals it.
   *
   * The dependency is the **parent's path** and not the map it came out of, and that is the whole
   * point. `nestParentOf` is rebuilt with a new identity every time `childrenByDir` changes — which
   * is every folder expanded, every refresh, every file created or renamed, and every event the
   * watcher delivers. Depending on the map re-ran this on all of them, and since it only ever
   * *adds*, a nest the user had just collapsed by hand sprang open again on the next unrelated
   * listing. While the nested file stayed the active tab there was no way to keep it shut.
   *
   * A string compares by value, so this now runs when the selected file's nest actually changes —
   * a new selection, or a file that becomes nested once its folder finishes loading — and stays out
   * of the way otherwise.
   */
  const nestParent = (selectedPath ? nestParentOf.get(selectedPath) : undefined) ?? null;
  useEffect(() => {
    if (!nestParent) return;
    setNestOpen((prev) => (prev.has(nestParent) ? prev : new Set(prev).add(nestParent)));
  }, [nestParent]);

  /**
   * The second half of `revealFile`: the scroll, once the row exists.
   *
   * Split from the request because the row is drawn by the render that consumes the listings the
   * request awaited — there is no tick at which both the listing and its DOM node are available to
   * the same call. Below the nesting memo, and it has to be: it reads `nestParentOf`.
   */
  useEffect(() => {
    if (!revealTarget) return;
    // A derived file has no row of its own until its parent's nest is unfolded, and `nestParentOf`
    // only knows it is one once the directory has been listed — which is why this is here and not
    // in `revealFile`. Returning lets the render this causes re-enter with the row drawn.
    const nest = nestParentOf.get(revealTarget);
    if (nest && !nestOpen.has(nest)) {
      setNestOpen((prev) => new Set(prev).add(nest));
      return;
    }
    const row = scrollerRef.current?.querySelector<HTMLElement>(
      // The marker the drag hit-test already relies on. A path may legally contain `"` and `\`,
      // and those are the only two characters an attribute-value selector has to escape.
      `[data-cf-treepath="${revealTarget.replace(/["\\]/g, "\\$&")}"]`,
    );
    if (row) {
      // `block: "nearest"` — the same call `EditorTabs` makes: it does nothing when the row is
      // already on screen, so a reveal of a file you can see doesn't jump the tree under you.
      row.scrollIntoView({ block: "nearest" });
      setRevealTarget(null);
      return;
    }
    // Give up only once the parent has actually answered and does not have it — a file deleted or
    // renamed since the tab was opened. Anything else is "not drawn yet", and the listings in the
    // deps bring this back on the render that draws it.
    const listing = childrenByDir.get(parentDir(revealTarget));
    if (listing && !listing.some((entry) => entry.path === revealTarget)) setRevealTarget(null);
    // The *raw* cache, not `rowsByDir`: a nested file is lifted out of the rendered listing but is
    // still in the cache, so asking the filtered one would give up on exactly the files the nest
    // branch above exists to reach. `rowsByDir` and `nestedByDir` are both derived from these
    // three, so they are already covered and would only be dependencies that never fire alone.
  }, [revealTarget, childrenByDir, nestParentOf, nestOpen]);

  // `?? null` is still what tells "not listed yet" from "listed and empty" — the skeleton depends
  // on it.
  const rootEntries = rowsByDir.get("") ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("editor.explorer")}
        </span>
        <ToolbarButton onClick={() => startDraft("file")} title={t("editor.newFile")}>
          <FilePlus size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={() => startDraft("dir")} title={t("editor.newFolder")}>
          <FolderPlus size={13} />
        </ToolbarButton>
        <ToolbarButton
          // `onRefresh` first and `refresh()` second: the latter is what drives this button's own
          // spinner, and the former bumps `fsNonce`, which schedules a second sweep 250ms later
          // through the watcher effect. Two sweeps, not one — harmless, and the honest cost of one
          // button standing for the whole screen.
          onClick={() => {
            void runRefreshing(async () => {
              onRefresh?.();
              await refresh();
            });
          }}
          title={`${t("editor.refreshExplorer")} — ${t("editor.refreshHint")}`}
          ariaLabel={t("editor.refreshExplorer")}
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
        </ToolbarButton>
        <ToolbarButton onClick={collapseAll} title={t("editor.collapseAll")}>
          <ChevronsDownUp size={13} />
        </ToolbarButton>
      </div>
      <div
        ref={scrollerRef}
        data-cf-treeroot=""
        // Clicking empty space below the tree targets the repo root, so a new file created
        // right after lands at the top level instead of inside a previously clicked folder.
        onClick={(e) => {
          if (e.target === e.currentTarget) setFocus({ path: "", isDir: true });
        }}
        // Right-clicking the empty space below the tree is the root's menu — the only way to reach
        // "new file at the top level" once a folder deep in the tree has the focus.
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) openMenu(e, null);
        }}
        // Dropping on that same empty space moves to the repo root.
        className={`min-h-0 flex-1 overflow-auto py-1 ${
          rootIsDropTarget ? "ring-1 ring-inset ring-[var(--cf-accent)]" : ""
        }`}
      >
        {!rootEntries ? (
          <SkeletonRows count={10} className="cf-fade-in" />
        ) : (
          <>
            {draft?.parent === "" && (
              <DraftRow kind={draft.kind} depth={0} onSubmit={submitDraft} onCancel={cancelDraft} />
            )}
            {rootEntries.map((entry, index) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                at={index}
                selectedPath={selectedPath}
                focusedDir={focus.isDir ? focus.path : null}
                focusedFile={focus.isDir ? null : focus.path}
                expanded={expanded}
                childrenByDir={rowsByDir}
                hiddenCountByDir={hiddenCountByDir}
                nestedByDir={nestedByDir}
                nestOpen={nestOpen}
                onToggleNest={toggleNest}
                draft={draft}
                renaming={renaming}
                onToggleDir={toggleDir}
                onSelectFile={handleSelectFile}
                onOpenFile={onOpenFile}
                onSubmitDraft={submitDraft}
                onCancelDraft={cancelDraft}
                onSubmitRename={submitRename}
                onCancelRename={cancelRename}
                onContextMenu={openMenu}
                onBeginDrag={beginDrag}
                suppressClick={takeSuppressedClick}
                changedPaths={changedPaths}
                changedDirs={changedDirs}
                iconRules={iconRules}
                defaultFolderIcon={defaultFolderIcon}
              />
            ))}
          </>
        )}
      </div>

      {/* Below the tree and outside its scroller: it is the only place a hidden entry still exists,
          so it must not be something you have to scroll to the bottom of a repository to find. */}
      <HiddenFilesSection />

      {/* Portalled so no ancestor's `overflow` clips it, and click-through so it never becomes
          the element `elementFromPoint` finds under the cursor. */}
      {treeDrag &&
        treeOrigin &&
        createPortal(
          <div
            ref={ghostRef}
            style={{ transform: `translate(${treeOrigin.x + 12}px, ${treeOrigin.y + 12}px)` }}
            className="pointer-events-none fixed left-0 top-0 z-[100] rounded-md border border-[var(--cf-accent)] bg-[var(--cf-surface)] px-2 py-1 text-[11px] text-[var(--cf-text)] shadow-lg"
          >
            {treeDrag.path.split("/").pop()}
          </div>,
          document.body,
        )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
