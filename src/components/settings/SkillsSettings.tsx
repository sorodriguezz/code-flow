import { useEffect, useState } from "react";
import { PackagePlus } from "lucide-react";
import { listInstalledSkills } from "../../lib/tauri/commands";
import type { InstalledSkill } from "../../types/domain";
import { useT } from "../../state/languageStore";

export function SkillsSettings() {
  const t = useT();
  const [skills, setSkills] = useState<InstalledSkill[]>([]);

  useEffect(() => {
    void listInstalledSkills().then(setSkills);
  }, []);

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
        (e.g. <code>npx skills add &lt;repo&gt; --skill &lt;name&gt;</code>). {t("settings.skillsHintSuffix")}
      </p>

      <div className="mb-3 flex items-center gap-2 rounded-lg border border-dashed border-[var(--cf-border)] p-3 text-[12px] text-[var(--cf-text-muted)]">
        <PackagePlus size={16} />
        {t("settings.skillsComingSoon")}
      </div>

      <div className="space-y-1">
        {skills.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px]">
            <span className="font-medium">{s.name}</span>
            <span className="flex-1 truncate text-[var(--cf-text-muted)]">{s.source_url}</span>
          </div>
        ))}
        {skills.length === 0 && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.noSkills")}</p>}
      </div>
    </section>
  );
}
