import { useId, useRef, useState } from "react";
import { useDialog } from "../../lib/useFocusTrap";
import { FolderGit2, Loader2, X } from "lucide-react";
import { linkProjectBitbucket } from "../../lib/tauri/commands";
import { normalizeBitbucketWorkspace } from "../../lib/bitbucketConnections";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { Select } from "../common/Select";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";

interface ConnectBitbucketModalProps {
  projectId: string;
  /** Workspaces with a saved credential — the manual link can only target one of these. */
  workspaces: string[];
  onConnected: () => void;
  onClose: () => void;
}

/**
 * Manual fallback for a project whose Bitbucket remote couldn't be auto-detected — a mirror, or an
 * `origin` that points somewhere other than bitbucket.org.
 *
 * Two fields, like GitHub's owner and repository: a Bitbucket repository is always exactly a
 * workspace and a slug. The workspace is picked from the connected ones, since a link to one without
 * a credential could do nothing; the slug field also takes a pasted `workspace/slug` or the
 * repository's URL, and keeps the last segment.
 */
export function ConnectBitbucketModal({ projectId, workspaces, onConnected, onClose }: ConnectBitbucketModalProps) {
  const t = useT();
  const [workspace, setWorkspace] = useState(workspaces[0] ?? "");
  const [repo, setRepo] = useState("");
  const [saving, setSaving] = useState(false);

  // A URL names the repository right after the workspace, whatever page of it was copied; anything
  // else is a slug or a `workspace/slug`, whose last segment is the slug.
  const fromUrl = repo.match(/bitbucket\.org\/[^/?#]+\/([^/?#]+)/i)?.[1];
  const slug =
    (fromUrl ?? repo)
      .trim()
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean)
      .pop()
      ?.toLowerCase() ?? "";
  const valid = normalizeBitbucketWorkspace(workspace) !== "" && slug !== "";

  const connect = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await linkProjectBitbucket(projectId, workspace, slug);
      onConnected();
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  // The dialog contract every connect modal keeps: Tab stays inside, Escape closes it unless saving.
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, true, saving ? null : onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onClick={saving ? undefined : onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 id={titleId} className="flex items-center gap-1.5 text-[15px] font-semibold">
            <FolderGit2 size={14} />
            {t("sidebar.linkBitbucketTitle")}
          </h3>
          {!saving && (
            <button onClick={onClose} aria-label={t("common.close")} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={15} />
            </button>
          )}
        </div>

        {workspaces.length > 1 && (
          <>
            <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
              {t("settings.bitbucketWorkspace")}
            </label>
            <Select
              value={workspace}
              onChange={setWorkspace}
              className="mb-3"
              ariaLabel={t("settings.bitbucketWorkspace")}
              options={workspaces.map((w) => ({ value: w, label: w }))}
            />
          </>
        )}

        <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
          {t("sidebar.bitbucketRepoSlug")}
        </label>
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder={t("sidebar.bitbucketRepoSlugPlaceholder")}
          spellCheck={false}
          autoComplete="off"
          className={fieldClass({ className: "w-full font-mono" })}
        />
        <p className="mb-4 mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t("sidebar.bitbucketRepoSlugHint")}
        </p>

        <div className="flex justify-end gap-2">
          <button disabled={saving} onClick={onClose} className={buttonClass({ variant: "ghost" })}>
            {t("common.cancel")}
          </button>
          <button disabled={saving || !valid} onClick={connect} className={buttonClass({ variant: "primary" })}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <FolderGit2 size={13} />}
            {t("sidebar.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
