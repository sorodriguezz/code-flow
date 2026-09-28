import { FileLock2, HardDrive, Webhook } from "lucide-react";
import { useGitToolsStore } from "../../state/gitToolsStore";
import { useT } from "../../state/languageStore";

/**
 * The Changes screen's note that commits here are not plain libgit2 commits: hooks run, commits are
 * signed, LFS paths are staged as pointers — see `git/features.rs`. One glyph per fact, details in the
 * tooltip; nothing at all for a repository with none of them, which is most of them.
 */
export function RepoFeaturesBadge() {
  const features = useGitToolsStore((s) => s.features);
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
      {features.lfs && (
        <HardDrive size={12} className={features.lfs_available ? undefined : "text-[var(--cf-warning)]"} />
      )}
    </span>
  );
}
