import { useState } from "react";
import { FolderGit2, GitBranch, Loader2, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import type { FoundRepo } from "../../lib/tauri/commands";

/**
 * Which of the repositories found inside a picked folder to import.
 *
 * Shown only when the folder is not itself a repository but has repositories directly inside it —
 * the "I keep all my repos in one place" pick, which used to be registered as a single project
 * whose path was the parent. Everything downstream then pointed at that parent: `git status`
 * walking whatever enclosing repository it could find, and a *recursive* file watcher over every
 * working tree in there at once. That is the freeze this dialog exists to make impossible.
 *
 * A list with checkboxes rather than an automatic import of everything found: a folder of twenty
 * repositories is rarely twenty repositories you want open, and adding them all is tidier to
 * describe than to undo.
 */
export function ImportReposModal({
  folder,
  repos,
  existingPaths,
  truncated,
  onImport,
  onClose,
}: {
  folder: string;
  repos: FoundRepo[];
  /** Paths already in this workspace. Those rows are shown, but locked and unchecked — seeing that
   * a repository is *already here* is the answer to "why isn't it in the list", which leaving it
   * out silently is not. */
  existingPaths: string[];
  /** The folder had more entries than the scan looks at, so this list may not be all of them.
   * Said out loud rather than left implied: a truncated list that looks complete is worse than a
   * shorter one that admits it. */
  truncated: boolean;
  onImport: (repos: FoundRepo[]) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const already = new Set(existingPaths);
  const importable = repos.filter((repo) => !already.has(repo.path));
  const [selected, setSelected] = useState<string[]>(() => importable.map((repo) => repo.path));
  const [importing, setImporting] = useState(false);

  const toggle = (path: string) =>
    setSelected((current) =>
      current.includes(path) ? current.filter((p) => p !== path) : [...current, path],
    );

  const allSelected = importable.length > 0 && selected.length === importable.length;

  const confirm = async () => {
    setImporting(true);
    try {
      await onImport(repos.filter((repo) => selected.includes(repo.path)));
      onClose();
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={importing ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[60vh] w-[460px] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <FolderGit2 size={14} />
            {t("import.title")}
          </h3>
          {!importing && (
            <button
              onClick={onClose}
              className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={15} />
            </button>
          )}
        </div>
        <p className="mb-3 truncate font-mono text-[11px] text-[var(--cf-text-muted)]" title={folder}>
          {folder}
        </p>

        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] text-[var(--cf-text-muted)]">
            {t("import.found", { count: String(repos.length) })}
          </span>
          {importable.length > 0 && (
            <button
              onClick={() => setSelected(allSelected ? [] : importable.map((r) => r.path))}
              className="text-[11px] text-[var(--cf-accent)] hover:underline"
            >
              {allSelected ? t("import.selectNone") : t("import.selectAll")}
            </button>
          )}
        </div>

        {truncated && (
          <p className="mb-2 text-[11px] text-[var(--cf-warning)]">
            {t("import.truncated")}
          </p>
        )}
        <div className="mb-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-[var(--cf-border)]">
          {repos.map((repo) => {
            const isAlready = already.has(repo.path);
            return (
              <label
                key={repo.path}
                className={`flex items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1.5 last:border-b-0 ${
                  isAlready ? "opacity-50" : "cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <input
                  type="checkbox"
                  disabled={isAlready || importing}
                  checked={selected.includes(repo.path)}
                  onChange={() => toggle(repo.path)}
                  className="shrink-0 accent-[var(--cf-accent)]"
                />
                <GitBranch size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                  {repo.name}
                </span>
                {isAlready && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                    {t("import.alreadyAdded")}
                  </span>
                )}
              </label>
            );
          })}
        </div>

        <div className="flex shrink-0 justify-end gap-2">
          <button
            disabled={importing}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            disabled={importing || selected.length === 0}
            onClick={() => void confirm()}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {importing && <Loader2 size={13} className="animate-spin" />}
            {t("import.importCount", { count: String(selected.length) })}
          </button>
        </div>
      </div>
    </div>
  );
}
