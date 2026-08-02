import { useState } from "react";
import { GitMerge, Loader2, X } from "lucide-react";
import { linkProjectGitlab } from "../../lib/tauri/commands";
import { gitlabHostLabel } from "../../lib/gitlabConnections";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { Select } from "../common/Select";

interface ConnectGitlabModalProps {
  projectId: string;
  /** Hosts the user has a token for — the manual link can only target one of these. */
  hosts: string[];
  onConnected: () => void;
  onClose: () => void;
}

/**
 * Manual fallback for a project whose GitLab remote couldn't be auto-detected — a repository with
 * no recognised origin, or one on a self-managed instance connected after the repo was added.
 *
 * **One path field, not an owner and a repo.** GitLab groups nest arbitrarily, so
 * `acme/backend/services/auth` is an ordinary project; two boxes could not represent it. That full
 * path is also what GitLab's own API addresses a project by, so it is what gets stored.
 */
export function ConnectGitlabModal({ projectId, hosts, onConnected, onClose }: ConnectGitlabModalProps) {
  const t = useT();
  const [host, setHost] = useState(hosts[0] ?? "gitlab.com");
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);

  // A namespace and a project at the very least — the same rule the backend enforces, checked here
  // so the button is simply unavailable rather than the save failing with an error.
  const valid = path.trim().replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).length >= 2;

  const connect = async () => {
    if (!valid || !host) return;
    setSaving(true);
    try {
      await linkProjectGitlab(projectId, path.trim(), host);
      onConnected();
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onClick={saving ? undefined : onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <GitMerge size={14} />
            {t("sidebar.linkGitlabTitle")}
          </h3>
          {!saving && (
            <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={15} />
            </button>
          )}
        </div>

        {hosts.length > 1 && (
          <>
            <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("settings.gitlabHostLabel")}
            </label>
            <Select
              value={host}
              onChange={setHost}
              className="mb-3"
              ariaLabel={t("settings.gitlabHostLabel")}
              options={hosts.map((h) => ({ value: h, label: gitlabHostLabel(h) }))}
            />
          </>
        )}

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("sidebar.gitlabProjectPath")}
        </label>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t("sidebar.gitlabProjectPathPlaceholder")}
          className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-[var(--cf-accent)]"
        />
        <p className="mb-4 mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t("sidebar.gitlabProjectPathHint")}
        </p>

        <div className="flex justify-end gap-2">
          <button
            disabled={saving}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            disabled={saving || !valid}
            onClick={connect}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
            {t("sidebar.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
