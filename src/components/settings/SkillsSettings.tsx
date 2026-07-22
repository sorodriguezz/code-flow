import { useEffect, useState } from "react";
import { Loader2, PackagePlus, Trash2 } from "lucide-react";
import { installWorkspaceSkill, listWorkspaceSkills, removeWorkspaceSkill } from "../../lib/tauri/commands";
import { onSkillsProgress } from "../../lib/tauri/events";
import { pushErrorToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { WorkspaceSkill } from "../../types/domain";
import { useT } from "../../state/languageStore";

export function SkillsSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [repo, setRepo] = useState("");
  const [skillName, setSkillName] = useState("");
  const [installing, setInstalling] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  const reload = async (id: string) => {
    setSkills(await listWorkspaceSkills(id));
  };

  useEffect(() => {
    if (workspaceId) void reload(workspaceId);
    else setSkills([]);
  }, [workspaceId]);

  if (!workspaceId) {
    return (
      <section>
        <h3 className="mb-1 text-sm font-semibold">{t("settings.skillsTitle")}</h3>
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.skillsSelectWorkspace")}</p>
      </section>
    );
  }

  const install = async () => {
    if (!repo.trim() || !skillName.trim()) return;
    setInstalling(true);
    setLines([]);
    const unlisten = await onSkillsProgress((e) => setLines((prev) => [...prev.slice(-200), e.line]));
    try {
      await installWorkspaceSkill(workspaceId, repo.trim(), skillName.trim());
      setRepo("");
      setSkillName("");
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setInstalling(false);
      void unlisten();
    }
  };

  const remove = async (id: string) => {
    try {
      await removeWorkspaceSkill(id);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.skillsTitle")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">
        {t("settings.skillsHintPrefix")}{" "}
        <a
          href="https://www.skills.sh/"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--cf-accent)] underline"
        >
          skills.sh
        </a>{" "}
        {t("settings.skillsHintSuffix")}
      </p>

      <div className="mb-3 space-y-2 rounded-lg border border-[var(--cf-border)] p-3">
        <div className="flex gap-1.5">
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            disabled={installing}
            placeholder={t("settings.skillRepoPlaceholder")}
            className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] font-mono outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
          />
          <input
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            disabled={installing}
            placeholder={t("settings.skillNamePlaceholder")}
            className="w-40 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] font-mono outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
          />
          <button
            onClick={install}
            disabled={installing || !repo.trim() || !skillName.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {installing ? <Loader2 size={13} className="animate-spin" /> : <PackagePlus size={13} />}
            {installing ? t("settings.installingSkill") : t("settings.installSkill")}
          </button>
        </div>
        {lines.length > 0 && (
          <div className="max-h-28 overflow-auto rounded-md bg-black/[0.04] p-2 font-mono text-[11px] text-[var(--cf-text-muted)] dark:bg-white/[0.06]">
            {lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        {skills.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px]"
          >
            <span className="font-medium">{s.skill_name}</span>
            <span className="flex-1 truncate text-[var(--cf-text-muted)]">{s.source_repo}</span>
            <button onClick={() => remove(s.id)} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {skills.length === 0 && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.noSkills")}</p>}
      </div>
    </section>
  );
}
