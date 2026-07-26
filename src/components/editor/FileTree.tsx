import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  Folder,
  FolderPlus,
  RefreshCw,
} from "lucide-react";
import { createDir, createFile, listDir } from "../../lib/tauri/commands";
import { SkeletonRows } from "../common/Skeleton";
import type { FileEntry } from "../../types/domain";
import { fileStatusColor, fileStatusLabelKey } from "../../lib/fileStatus";
import { fileIconFor } from "../../lib/fileIcon";
import { useRepoStore } from "../../state/repoStore";
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
  changedPaths: Map<string, string>;
}) {
  const t = useT();
  const isExpanded = entry.is_dir && expanded.has(entry.path);
  const children = childrenByDir.get(entry.path) ?? null;

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
        onClick={() => (entry.is_dir ? onToggleDir(entry.path) : onSelectFile(entry.path))}
        onDoubleClick={() => !entry.is_dir && onOpenFile?.(entry.path)}
        style={{ paddingLeft: depth * 14 + 6 }}
        className={`flex w-full items-center gap-1.5 truncate rounded-md py-0.5 pr-2 text-left text-[13px] ${
          isSelected
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        } ${isSelected ? "" : color ? "" : "text-[var(--cf-text-muted)]"}`}
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
  changedPaths,
}: {
  repoPath: string;
  selectedPath: string | null;
  /** Single click — opens the file as a reusable preview tab. */
  onSelectFile: (path: string) => void;
  /** Double click — opens the file for good, pinning its tab. */
  onOpenFile?: (path: string) => void;
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
        // Clicking empty space below the tree targets the repo root, so a new file created
        // right after lands at the top level instead of inside a previously clicked folder.
        onClick={(e) => {
          if (e.target === e.currentTarget) setFocus({ path: "", isDir: true });
        }}
        className="min-h-0 flex-1 overflow-auto py-1"
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
                changedPaths={changedPaths}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
