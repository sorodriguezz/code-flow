import { useEffect, useState } from "react";
import { GitBranchPlus, Loader2, X } from "lucide-react";
import { defaultCloneDir, findDuplicateProjects, gitClone } from "../../lib/tauri/commands";
import type { DuplicateProject } from "../../lib/tauri/commands";
import { onGitProgress } from "../../lib/tauri/events";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { Project } from "../../types/domain";
import { DEFAULT_WORKSPACE_COLOR } from "../../lib/workspaceColors";

function deriveName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[\\/]/).pop() ?? "repo";
  return last.replace(/\.git$/i, "") || "repo";
}

export function CloneRepoModal({
  workspaceId,
  initialUrl,
  onClose,
  onCloned,
}: {
  workspaceId: string;
  /** Prefills the URL field — used when the clone was offered for a specific repository (the
   * "this pull request's repo isn't in CodeFlow yet" path). */
  initialUrl?: string;
  onClose: () => void;
  /** Fires with the freshly-added project, before `onClose`, so the caller can continue whatever
   * it needed the repository for. */
  onCloned?: (project: Project) => void;
}) {
  const addProject = useWorkspaceStore((s) => s.addProject);
  const t = useT();
  /** The clone root and the separator to append a name with, both from Rust. The separator is not
   *  cosmetic: this used to build the destination as `${baseDir}/${name}`, a forward slash onto a
   *  root that on Windows is `C:\\CodeFlow\\repos`, and the mixed path it produced went on to live
   *  in `projects.local_path` for the life of the project. */
  const [base, setBase] = useState({ root: "", separator: "/" });
  const [url, setUrl] = useState(initialUrl ?? "");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  /** The repository this workspace already holds, when the URL turns out to name it. Kept in the
   *  modal rather than pushed as a toast: the answer is about the URL still in the field, and it
   *  has to stay readable while the user edits it or goes to switch workspace. */
  const [duplicate, setDuplicate] = useState<DuplicateProject | null>(null);

  useEffect(() => {
    void defaultCloneDir().then(setBase);
  }, []);

  useEffect(() => {
    if (!nameEdited && url.trim()) setName(deriveName(url));
  }, [url, nameEdited]);

  // A refusal is about the URL that earned it. Typing a different one clears it rather than
  // leaving a message that now points at nothing.
  useEffect(() => setDuplicate(null), [url]);

  // Falls back to the repo's own name whenever the field is left blank — whether the
  // user never touched it, or cleared it out on purpose — rather than blocking Clone.
  const effectiveName = name.trim() || deriveName(url);
  const dest = base.root && effectiveName ? `${base.root}${base.separator}${effectiveName}` : "";

  const clone = async () => {
    if (!url.trim() || !dest) return;
    setCloning(true);
    setLines([]);
    setDuplicate(null);
    // Asked before a byte is fetched. A workspace holds a repository once, and the copy it already
    // holds is usually somewhere else entirely — which is the whole reason a path comparison never
    // caught this. Finding out afterwards would mean a finished download in a folder nobody wanted
    // and a project that can't be registered anyway.
    try {
      const [existing] = await findDuplicateProjects(workspaceId, [
        { path: dest, remote_url: url.trim() },
      ]);
      if (existing) {
        setDuplicate(existing);
        setCloning(false);
        return;
      }
    } catch (e) {
      pushErrorToast(String(e));
      setCloning(false);
      return;
    }
    const unlistenProgress = await onGitProgress((e) => {
      if (e.op === "clone") setLines((prev) => [...prev.slice(-200), e.line]);
    });
    try {
      await gitClone(url.trim(), dest);
      const project = await addProject({
        workspace_id: workspaceId,
        name: effectiveName,
        local_path: dest,
        remote_url: url.trim(),
        color: DEFAULT_WORKSPACE_COLOR,
        icon: "git-branch",
        ado_org: null,
        ado_project: null,
        ado_repo_id: null,
        github_owner: null,
        github_repo: null,
        github_host: null,
      gitlab_project: null,
      gitlab_host: null,
      });
      onCloned?.(project);
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setCloning(false);
      void unlistenProgress();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onClick={cloning ? undefined : onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[460px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <GitBranchPlus size={14} />
            {t("clone.title")}
          </h3>
          {!cloning && (
            <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={15} />
            </button>
          )}
        </div>

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">{t("clone.url")}</label>
        <input
          autoFocus
          disabled={cloning}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/user/repo.git"
          className="mb-3 w-full overflow-x-auto rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
        />

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">{t("clone.folderName")}</label>
        <input
          disabled={cloning}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
          placeholder={deriveName(url) || "repo"}
          className="mb-1 w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
        />
        <p className="mb-3 truncate font-mono text-[11px] text-[var(--cf-text-muted)]" title={dest}>
          {dest || "…"}
        </p>

        {duplicate && (
          <p className="mb-3 rounded-md border border-[var(--cf-warning)]/40 bg-[var(--cf-warning)]/[0.08] px-2 py-1.5 text-[11px] text-[var(--cf-warning)]">
            {t("import.duplicateRepo", { name: duplicate.name, path: duplicate.local_path })}
          </p>
        )}

        {lines.length > 0 && (
          <div className="mb-3 max-h-32 overflow-auto rounded-md bg-black/[0.04] p-2 font-mono text-[11px] text-[var(--cf-text-muted)] dark:bg-white/[0.06]">
            {lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            disabled={cloning}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            disabled={cloning || !url.trim()}
            onClick={clone}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {cloning ? <Loader2 size={13} className="animate-spin" /> : <GitBranchPlus size={13} />}
            {cloning ? t("clone.cloning") : t("clone.clone")}
          </button>
        </div>
      </div>
    </div>
  );
}
