import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  Folder,
  FolderPlus,
  RefreshCw,
} from "lucide-react";
import { createDir, createFile, listDir, movePath } from "../../lib/tauri/commands";
import { SkeletonRows } from "../common/Skeleton";
import type { FileEntry } from "../../types/domain";
import { fileStatusColor, fileStatusLabelKey } from "../../lib/fileStatus";
import { fileIconFor } from "../../lib/fileIcon";
import { useRepoStore } from "../../state/repoStore";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useRowHoverStore } from "../../state/rowHoverStore";
import { canDropInto, useTreeDragStore, type TreeDrag } from "../../state/treeDragStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/** Repo-relative path of the directory holding `path` ("" for a top-level entry). */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

type DraftKind = "file" | "dir";

/** An in-progress "new file"/"new folder" entry: the inline input VS Code shows inside the
 * target directory, rather than a modal. */
interface Draft {
  parent: string;
  kind: DraftKind;
}

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}

function DraftRow({
  kind,
  depth,
  onSubmit,
  onCancel,
}: {
  kind: DraftKind;
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const { Icon: FileIcon, color } = fileIconFor(name || "file.txt");

  return (
    <div
      style={{ paddingLeft: depth * 14 + 6 }}
      className="flex items-center gap-1.5 py-0.5 pr-2 text-[13px]"
    >
      <span className="w-3 shrink-0" />
      {kind === "dir" ? (
        <Folder size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      ) : (
        <FileIcon size={13} className="shrink-0" style={{ color }} />
      )}
      <input
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

function TreeNode({
  entry,
  depth,
  selectedPath,
  focusedDir,
  expanded,
  childrenByDir,
  draft,
  onToggleDir,
  onSelectFile,
  onOpenFile,
  onSubmitDraft,
  onCancelDraft,
  onBeginDrag,
  suppressClick,
  changedPaths,
}: {
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  /** The clicked directory, when the last click landed on one — null while a file holds the
   * selection, so only ever one row reads as selected. */
  focusedDir: string | null;
  expanded: Set<string>;
  /** Cached `listDir` results, keyed by directory ("" = repo root). */
  childrenByDir: Map<string, FileEntry[]>;
  draft: Draft | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onSubmitDraft: (name: string) => void;
  onCancelDraft: () => void;
  /** Arms a possible move — the row only becomes a drag once the pointer travels far enough. */
  onBeginDrag: (e: React.PointerEvent<HTMLElement>, entry: FileEntry) => void;
  /** True once, right after a drag, so the trailing click doesn't also select the row. */
  suppressClick: () => boolean;
  changedPaths: Map<string, string>;
}) {
  const t = useT();
  const isExpanded = entry.is_dir && expanded.has(entry.path);
  const children = childrenByDir.get(entry.path) ?? null;

  const drag = useTreeDragStore((s) => s.drag);
  const overDir = useTreeDragStore((s) => s.overDir);
  const isDragging = drag?.path === entry.path;
  const isDropTarget = entry.is_dir && overDir === entry.path;
  // Only this row and the one being left re-render when the pointer moves between them, which is
  // what makes tracking hover in state affordable on a tree this size.
  const hoverKey = `tree:${entry.path}`;
  const isHovered = useRowHoverStore((s) => s.key === hoverKey);

  const isSelected = entry.is_dir ? focusedDir === entry.path : selectedPath === entry.path;
  const ownStatus = changedPaths.get(entry.path);
  // A directory doesn't have its own git status, but VS Code-style explorers still color
  // it when something inside changed — cheap to check since we already have every
  // changed path in hand, no need to have fetched this directory's children yet.
  const hasChangedDescendant =
    entry.is_dir && !ownStatus && [...changedPaths.keys()].some((p) => p.startsWith(`${entry.path}/`));
  const status = ownStatus ?? (hasChangedDescendant ? "modified" : undefined);
  const color = status ? fileStatusColor(status) : undefined;
  const { Icon: FileIcon, color: iconColor } = fileIconFor(entry.path);
  const draftHere = draft && draft.parent === entry.path ? draft : null;

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
        onClick={() => {
          // A drag ends with a click on the row it started from; the tree must not also treat
          // that as a selection.
          if (suppressClick()) return;
          if (entry.is_dir) onToggleDir(entry.path);
          else onSelectFile(entry.path);
        }}
        onDoubleClick={() => !entry.is_dir && onOpenFile?.(entry.path)}
        style={{ paddingLeft: depth * 14 + 6 }}
        className={`flex w-full items-center gap-1.5 truncate rounded-md py-0.5 pr-2 text-left text-[13px] ${
          isSelected
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : // Nothing but the drop target is highlighted while a drag is in flight.
              isHovered && !drag
              ? "cf-row-hover"
              : ""
        } ${isSelected ? "" : color ? "" : "text-[var(--cf-text-muted)]"} ${
          isDropTarget ? "ring-1 ring-inset ring-[var(--cf-accent)]" : ""
        } ${isDragging ? "opacity-40" : ""}`}
      >
        {entry.is_dir ? (
          <>
            {isExpanded ? (
              <ChevronDown size={12} className="shrink-0" />
            ) : (
              <ChevronRight size={12} className="shrink-0" />
            )}
            <Folder size={13} className="shrink-0" style={!isSelected && color ? { color } : undefined} />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {/* Git status wins over the language color: a modified file has to read as
                modified first, the same way it does in the Changes tab. */}
            <FileIcon size={13} className="shrink-0" style={{ color: isSelected ? undefined : (color ?? iconColor) }} />
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
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              focusedDir={focusedDir}
              expanded={expanded}
              childrenByDir={childrenByDir}
              draft={draft}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              onOpenFile={onOpenFile}
              onSubmitDraft={onSubmitDraft}
              onCancelDraft={onCancelDraft}
              onBeginDrag={onBeginDrag}
              suppressClick={suppressClick}
              changedPaths={changedPaths}
            />
          ))}
          {children && children.length === 0 && !draftHere && (
            <p style={{ paddingLeft: (depth + 1) * 14 + 6 }} className="text-[11px] text-[var(--cf-text-muted)]">
              {t("editor.empty")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  repoPath,
  selectedPath,
  onSelectFile,
  onOpenFile,
  onPathMoved,
  changedPaths,
}: {
  repoPath: string;
  selectedPath: string | null;
  /** Single click — opens the file as a reusable preview tab. */
  onSelectFile: (path: string) => void;
  /** Double click — opens the file for good, pinning its tab. */
  onOpenFile?: (path: string) => void;
  /** A file or folder was moved by dragging. The editor uses this to re-point any tab that was
   * showing it, instead of leaving a tab aimed at a path that no longer exists. */
  onPathMoved?: (from: string, to: string) => void;
  changedPaths: Map<string, string>;
}) {
  const t = useT();
  // Expansion and the listing cache both live here rather than in each node, so "collapse
  // all" and "refresh" can act on the whole tree at once. "" keys the repo root.
  const [childrenByDir, setChildrenByDir] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The clicked row, which is what decides where a new file/folder lands, mirroring VS Code:
  // inside the clicked directory, or alongside the clicked file, or at the root.
  const [focus, setFocus] = useState<{ path: string; isDir: boolean }>({ path: "", isDir: true });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const childrenRef = useRef(childrenByDir);
  // Listings are async, so a switch to another project can land while one is in flight —
  // every write compares against this before touching state.
  const activeRepoRef = useRef(repoPath);

  useEffect(() => {
    childrenRef.current = childrenByDir;
  }, [childrenByDir]);

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
    setFocus({ path: "", isDir: true });
    setDraft(null);
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

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const dirs = ["", ...expanded];
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
      setExpanded(new Set(loaded.map(([dir]) => dir).filter((dir) => dir !== "")));
    } finally {
      setRefreshing(false);
    }
  }, [repoPath, expanded]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
    setDraft((prev) => (prev && prev.parent !== "" ? null : prev));
  }, []);

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

  const cancelDraft = useCallback(() => setDraft(null), []);

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
  const treeOverDir = useTreeDragStore((s) => s.overDir);
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

  const rootEntries = childrenByDir.get("") ?? null;

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
        <ToolbarButton onClick={() => void refresh()} title={t("editor.refreshExplorer")}>
          <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
        </ToolbarButton>
        <ToolbarButton onClick={collapseAll} title={t("editor.collapseAll")}>
          <ChevronsDownUp size={13} />
        </ToolbarButton>
      </div>
      <div
        data-cf-treeroot=""
        // Clicking empty space below the tree targets the repo root, so a new file created
        // right after lands at the top level instead of inside a previously clicked folder.
        onClick={(e) => {
          if (e.target === e.currentTarget) setFocus({ path: "", isDir: true });
        }}
        // Dropping on that same empty space moves to the repo root.
        className={`min-h-0 flex-1 overflow-auto py-1 ${
          treeOverDir === "" ? "ring-1 ring-inset ring-[var(--cf-accent)]" : ""
        }`}
      >
        {!rootEntries ? (
          <SkeletonRows count={10} className="cf-fade-in" />
        ) : (
          <>
            {draft?.parent === "" && (
              <DraftRow kind={draft.kind} depth={0} onSubmit={submitDraft} onCancel={cancelDraft} />
            )}
            {rootEntries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                selectedPath={selectedPath}
                focusedDir={focus.isDir ? focus.path : null}
                expanded={expanded}
                childrenByDir={childrenByDir}
                draft={draft}
                onToggleDir={toggleDir}
                onSelectFile={handleSelectFile}
                onOpenFile={onOpenFile}
                onSubmitDraft={submitDraft}
                onCancelDraft={cancelDraft}
                onBeginDrag={beginDrag}
                suppressClick={takeSuppressedClick}
                changedPaths={changedPaths}
              />
            ))}
          </>
        )}
      </div>

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
    </div>
  );
}
