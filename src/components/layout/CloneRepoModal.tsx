import { useEffect, useState } from "react";
import { GitBranchPlus, Loader2, X } from "lucide-react";
import { defaultCloneDir, gitClone } from "../../lib/tauri/commands";
import { onGitProgress } from "../../lib/tauri/events";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

function deriveName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[\\/]/).pop() ?? "repo";
  return last.replace(/\.git$/i, "") || "repo";
}

export function CloneRepoModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const addProject = useWorkspaceStore((s) => s.addProject);
  const t = useT();
  const [baseDir, setBaseDir] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    void defaultCloneDir().then(setBaseDir);
  }, []);

  useEffect(() => {
    if (!nameEdited && url.trim()) setName(deriveName(url));
  }, [url, nameEdited]);

  // Falls back to the repo's own name whenever the field is left blank — whether the
  // user never touched it, or cleared it out on purpose — rather than blocking Clone.
  const effectiveName = name.trim() || deriveName(url);
  const dest = baseDir && effectiveName ? `${baseDir}/${effectiveName}` : "";

  const clone = async () => {
    if (!url.trim() || !dest) return;
    setCloning(true);
    setLines([]);
    const unlistenProgress = await onGitProgress((e) => {
      if (e.op === "clone") setLines((prev) => [...prev.slice(-200), e.line]);
    });
    try {
      await gitClone(url.trim(), dest);
      await addProject({
        workspace_id: workspaceId,
        name: effectiveName,
        local_path: dest,
        remote_url: url.trim(),
        color: "#6366f1",
        icon: "git-branch",
        ado_org: null,
        ado_project: null,
        ado_repo_id: null,
      });
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
