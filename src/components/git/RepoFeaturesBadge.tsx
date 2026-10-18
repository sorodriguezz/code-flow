import { useState } from "react";
import { FileLock2, HardDrive, LoaderCircle, Webhook } from "lucide-react";
import { useGitToolsStore } from "../../state/gitToolsStore";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { gitLfsPull } from "../../lib/tauri/gitCommands";

/**
 * The Changes screen's note that commits here are not plain libgit2 commits: hooks run, commits are
 * signed, LFS paths are staged as pointers — see `git/features.rs`. One glyph per fact, details in the
 * tooltip; nothing at all for a repository with none of them, which is most of them.
 */
export function RepoFeaturesBadge() {
  const features = useGitToolsStore((s) => s.features);
  const repoPath = useRepoStore((s) => s.repoPath);
  const [pulling, setPulling] = useState(false);
  const t = useT();
  if (!features) return null;
  const hooks = features.hooks.length > 0;
  const signing = features.signing !== null;
  if (!hooks && !signing && !features.lfs) return null;

  const lines: string[] = [t("features.title")];
  if (hooks) {
    lines.push(
      features.hooks_path
        ? t("features.hooksAt", { hooks: features.hooks.join(", "), path: features.hooks_path })
        : t("features.hooks", { hooks: features.hooks.join(", ") }),
    );
  }
  if (signing) lines.push(t("features.signing", { format: features.signing ?? "" }));
  if (features.lfs) lines.push(features.lfs_available ? t("features.lfs") : t("features.lfsMissing"));

  return (
    <span
      title={lines.join("\n")}
      className="flex shrink-0 items-center gap-1 rounded-md px-1 text-[var(--cf-text-faint)]"
      aria-label={lines.join(". ")}
    >
      {hooks && <Webhook size={12} />}
      {signing && <FileLock2 size={12} />}
      {features.lfs &&
        (features.lfs_available && repoPath ? (
          // With LFS installed the glyph is also its one verb: fetch the objects the checkout points
          // at — a clone made before LFS was installed holds only pointers.
          <button
            type="button"
            disabled={pulling}
            title={`${lines.join("\n")}\n\n${t("features.lfsPull")}`}
            aria-label={t("features.lfsPull")}
            onClick={() => {
              setPulling(true);
              gitLfsPull(repoPath)
                .then(async () => {
                  await useRepoStore.getState().refreshStatus();
                  pushSuccessToast(t("binaryDiff.lfsPulled"));
                })
                .catch((e: unknown) => pushErrorToast(String(e)))
                .finally(() => setPulling(false));
            }}
            className="rounded hover:text-[var(--cf-text)]"
          >
            {pulling ? <LoaderCircle size={12} className="animate-spin" /> : <HardDrive size={12} />}
          </button>
        ) : (
          <HardDrive size={12} className={features.lfs_available ? undefined : "text-[var(--cf-warning)]"} />
        ))}
    </span>
  );
}
