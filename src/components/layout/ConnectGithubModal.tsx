import { useState } from "react";
import { GitFork, Loader2, X } from "lucide-react";
import { linkProjectGithub } from "../../lib/tauri/commands";
import { githubHostLabel } from "../../lib/githubConnections";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { Select } from "../common/Select";

interface ConnectGithubModalProps {
  projectId: string;
  /** Hosts the user has a token for — the manual link can only target one of these. */
  hosts: string[];
  onConnected: () => void;
  onClose: () => void;
}

// Manual fallback for a project whose GitHub remote couldn't be auto-detected (a repo with no
// recognized GitHub origin, or an unusual URL). Owner/repo are typed rather than picked — a
// token can see far too many repos to enumerate into a dropdown the way an Azure org's are.
export function ConnectGithubModal({ projectId, hosts, onConnected, onClose }: ConnectGithubModalProps) {
  const t = useT();
  const [host, setHost] = useState(hosts[0] ?? "github.com");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [saving, setSaving] = useState(false);

  const connect = async () => {
    if (!owner.trim() || !repo.trim() || !host) return;
    setSaving(true);
    try {
      await linkProjectGithub(projectId, owner.trim(), repo.trim(), host);
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
            <GitFork size={14} />
            {t("sidebar.linkGithubTitle")}
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
              {t("settings.githubHostLabel")}
            </label>
            <Select
              value={host}
              onChange={setHost}
              className="mb-3"
              ariaLabel={t("settings.githubHostLabel")}
              options={hosts.map((h) => ({ value: h, label: githubHostLabel(h) }))}
            />
          </>
        )}

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("sidebar.githubOwner")}
        </label>
        <input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder={t("sidebar.githubOwnerPlaceholder")}
          className="mb-3 w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
        />

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("sidebar.githubRepo")}
        </label>
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder={t("sidebar.githubRepoPlaceholder")}
          className="mb-4 w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
        />

        <div className="flex justify-end gap-2">
          <button
            disabled={saving}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            disabled={saving || !owner.trim() || !repo.trim()}
            onClick={connect}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <GitFork size={13} />}
            {t("sidebar.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
