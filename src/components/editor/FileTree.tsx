import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { listDir } from "../../lib/tauri/commands";
import { SkeletonRows } from "../common/Skeleton";
import type { FileEntry } from "../../types/domain";
import { fileStatusColor, fileStatusLabelKey } from "../../lib/fileStatus";
import { fileIconFor } from "../../lib/fileIcon";
import { useT } from "../../state/languageStore";

function TreeNode({
  repoPath,
  entry,
  depth,
  selectedPath,
  onSelectFile,
  onOpenFile,
  changedPaths,
}: {
  repoPath: string;
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onOpenFile?: (path: string) => void;
  changedPaths: Map<string, string>;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    if (expanded && children === null) {
      void listDir(repoPath, entry.path).then(setChildren);
    }
  }, [expanded, children, repoPath, entry.path]);

  const isSelected = selectedPath === entry.path;
  const ownStatus = changedPaths.get(entry.path);
  // A directory doesn't have its own git status, but VS Code-style explorers still color
  // it when something inside changed — cheap to check since we already have every
  // changed path in hand, no need to have fetched this directory's children yet.
  const hasChangedDescendant =
    entry.is_dir && !ownStatus && [...changedPaths.keys()].some((p) => p.startsWith(`${entry.path}/`));
  const status = ownStatus ?? (hasChangedDescendant ? "modified" : undefined);
  const color = status ? fileStatusColor(status) : undefined;
  const { Icon: FileIcon, color: iconColor } = fileIconFor(entry.path);

  return (
    <div>
      <button
        onClick={() => (entry.is_dir ? setExpanded((v) => !v) : onSelectFile(entry.path))}
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
            {expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
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
      {entry.is_dir && expanded && children && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              repoPath={repoPath}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              onOpenFile={onOpenFile}
              changedPaths={changedPaths}
            />
          ))}
          {children.length === 0 && (
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
  const [entries, setEntries] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    setEntries(null);
    void listDir(repoPath).then(setEntries);
  }, [repoPath]);

  if (!entries) return <SkeletonRows count={10} className="cf-fade-in" />;

  return (
    <div className="py-1">
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          repoPath={repoPath}
          entry={entry}
          depth={0}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onOpenFile={onOpenFile}
          changedPaths={changedPaths}
        />
      ))}
    </div>
  );
}
