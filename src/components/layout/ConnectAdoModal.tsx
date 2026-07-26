import { useEffect, useState } from "react";
import { Cloud, Loader2, X } from "lucide-react";
import { adoListProjects, adoListRepos, linkProjectAdo } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { Select } from "../common/Select";
import type { AdoProject, AdoRepo } from "../../types/domain";

interface ConnectAdoModalProps {
  projectId: string;
  /** Orgs the user has a PAT for — the manual link picks one of these. */
  orgs: string[];
  onConnected: () => void;
  onClose: () => void;
}

export function ConnectAdoModal({ projectId, orgs, onConnected, onClose }: ConnectAdoModalProps) {
  const t = useT();
  const [org, setOrg] = useState(orgs[0] ?? "");
  const [adoProjects, setAdoProjects] = useState<AdoProject[]>([]);
  const [repos, setRepos] = useState<AdoRepo[]>([]);
  const [adoProjectId, setAdoProjectId] = useState("");
  const [repoId, setRepoId] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!org) return;
    setAdoProjectId("");
    setAdoProjects([]);
    setLoadingProjects(true);
    adoListProjects(org)
      .then(setAdoProjects)
      .catch((e) => pushErrorToast(String(e)))
      .finally(() => setLoadingProjects(false));
  }, [org]);

  useEffect(() => {
    setRepoId("");
    setRepos([]);
    if (!adoProjectId) return;
    setLoadingRepos(true);
    adoListRepos(org, adoProjectId)
      .then(setRepos)
      .catch((e) => pushErrorToast(String(e)))
      .finally(() => setLoadingRepos(false));
  }, [org, adoProjectId]);

  const adoProjectName = adoProjects.find((p) => p.id === adoProjectId)?.name ?? "";

  const connect = async () => {
    if (!org || !adoProjectId || !repoId) return;
    setSaving(true);
    try {
      await linkProjectAdo(projectId, org, adoProjectName, repoId);
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
            <Cloud size={14} />
            {t("sidebar.linkAdoTitle")}
          </h3>
          {!saving && (
            <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={15} />
            </button>
          )}
        </div>

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("settings.organization")}
        </label>
        {orgs.length > 1 ? (
          <Select
            value={org}
            onChange={setOrg}
            className="mb-3"
            ariaLabel={t("settings.organization")}
            options={orgs.map((o) => ({ value: o, label: o }))}
          />
        ) : (
          <p className="mb-3 rounded-md border border-[var(--cf-border)] bg-black/[0.02] px-2.5 py-1.5 text-[13px] dark:bg-white/[0.03]">
            {org}
          </p>
        )}

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("sidebar.adoProject")}
        </label>
        <Select
          disabled={loadingProjects}
          value={adoProjectId}
          onChange={setAdoProjectId}
          className="mb-3"
          ariaLabel={t("sidebar.adoProject")}
          options={[
            { value: "", label: loadingProjects ? t("editor.loading") : t("sidebar.selectAdoProject") },
            ...adoProjects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("sidebar.adoRepo")}
        </label>
        <Select
          disabled={!adoProjectId || loadingRepos}
          value={repoId}
          onChange={setRepoId}
          className="mb-4"
          ariaLabel={t("sidebar.adoRepo")}
          options={[
            { value: "", label: loadingRepos ? t("editor.loading") : t("sidebar.selectAdoRepo") },
            ...repos.map((r) => ({ value: r.id, label: r.name })),
          ]}
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
            disabled={saving || !adoProjectId || !repoId}
            onClick={connect}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Cloud size={13} />}
            {t("sidebar.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
