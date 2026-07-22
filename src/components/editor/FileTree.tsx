import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { listDir } from "../../lib/tauri/commands";
import { SkeletonRows } from "../common/Skeleton";
import type { FileEntry } from "../../types/domain";
import { useT } from "../../state/languageStore";

function TreeNode({
  repoPath,
  entry,
  depth,
  selectedPath,
  onSelectFile,
}: {
  repoPath: string;
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
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

  return (
    <div>
      <button
        onClick={() => (entry.is_dir ? setExpanded((v) => !v) : onSelectFile(entry.path))}
        style={{ paddingLeft: depth * 14 + 6 }}
        className={`flex w-full items-center gap-1.5 truncate rounded-md py-0.5 pr-2 text-left text-[13px] ${
          isSelected
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        }`}
      >
        {entry.is_dir ? (
          <>
            {expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
            <Folder size={13} className="shrink-0" />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <File size={13} className="shrink-0" />
          </>
        )}
        <span className="truncate">{entry.name}</span>
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
}: {
  repoPath: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
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
        />
      ))}
    </div>
  );
}
