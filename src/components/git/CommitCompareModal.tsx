import { useEffect, useMemo, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { DiffView } from "./DiffView";
import type { DiffSides } from "./BinaryDiff";
import { SkeletonRows } from "../common/Skeleton";
import { getRevisionsDiff } from "../../lib/tauri/commands";
import { describeGitError } from "../../lib/gitErrors";
import { FILE_STATUS_LETTER_CLASS, fileStatusColor, fileStatusLabelKey, fileStatusLetter } from "../../lib/fileStatus";
import { useT } from "../../state/languageStore";
import type { CommitInfo, FileDiffInfo } from "../../types/domain";

const pathOf = (file: FileDiffInfo) => file.new_path ?? file.old_path ?? "";

/**
 * Two commits of the graph compared directly — the older one's tree to the newer one's, every file
 * that differs on the left and the one picked on the right. ⌘/Ctrl+click on a second row opens it.
 */
export function CommitCompareModal({
  repoPath,
  from,
  to,
  onClose,
}: {
  repoPath: string;
  /** The older side. */
  from: CommitInfo;
  to: CommitInfo;
  onClose: () => void;
}) {
  const t = useT();
  const [files, setFiles] = useState<FileDiffInfo[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiffInfo | null>(null);
  const sides = useMemo<DiffSides>(() => ({ repoPath, old: from.id, new: to.id }), [repoPath, from.id, to.id]);

  useEffect(() => {
    let live = true;
    void getRevisionsDiff(repoPath, from.id, to.id).then(
      (list) => {
        if (!live) return;
        setFiles(list);
        setPicked(list[0] ? pathOf(list[0]) : null);
      },
      (e: unknown) => live && setError(describeGitError(e, t)),
    );
    return () => {
      live = false;
    };
  }, [repoPath, from.id, to.id, t]);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    setFileDiff(null);
    void getRevisionsDiff(repoPath, from.id, to.id, picked).then(
      (list) => live && setFileDiff(list[0] ?? null),
      (e: unknown) => live && setError(describeGitError(e, t)),
    );
    return () => {
      live = false;
    };
  }, [repoPath, from.id, to.id, picked, t]);

  return (
    <ApiModal
      icon={GitCompareArrows}
      title={t("graph.compareTitle", { from: from.short_id, to: to.short_id })}
      subtitle={`${from.summary}  →  ${to.summary}`}
      width="max-w-6xl"
      height="h-[80vh]"
      onClose={onClose}
    >
      {error ? (
        <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p>
      ) : !files ? (
        <SkeletonRows count={8} />
      ) : files.length === 0 ? (
        <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("graph.compareSame")}</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-[300px] shrink-0 overflow-auto border-r border-[var(--cf-border)] py-1">
            {files.map((file) => {
              const path = pathOf(file);
              const selected = path === picked;
              return (
                <button
                  key={`${file.old_path ?? ""}>${file.new_path ?? ""}`}
                  type="button"
                  onClick={() => setPicked(path)}
                  title={`${t(fileStatusLabelKey(file.status))} — ${path}`}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] ${
                    selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
                  }`}
                >
                  <span style={{ color: fileStatusColor(file.status) }} className={FILE_STATUS_LETTER_CLASS}>
                    {fileStatusLetter(file.status)}
                  </span>
                  <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono text-[var(--cf-text)]">
                    {`‎${path}‎`}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {fileDiff ? <DiffView files={[fileDiff]} sides={sides} /> : <SkeletonRows count={10} />}
          </div>
        </div>
      )}
    </ApiModal>
  );
}
