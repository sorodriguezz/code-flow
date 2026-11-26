import { useState } from "react";
import changelog from "../../../CHANGELOG.md?raw";
import { useT } from "../../state/languageStore";
import { Markdown } from "../common/Markdown";
import { Select } from "../common/Select";

const releases = changelog.split(/^##[^\S\r\n]+/m).slice(1).map((entry) => {
  const [heading, ...lines] = entry.split(/\r?\n/);
  return { heading: heading.trim(), notes: lines.join("\n").trim() };
});
const versions = releases.map(({ heading }) => ({ value: heading, label: heading }));

export function ChangelogPane() {
  const t = useT();
  const [version, setVersion] = useState(releases[0]?.heading ?? "");
  const release = releases.find(({ heading }) => heading === version);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-[var(--cf-text-muted)]">{t("about.version")}</span>
        <Select value={version} onChange={setVersion} options={versions} ariaLabel={t("about.version")} />
      </div>
      <Markdown source={release?.notes ?? ""} className="cf-markdown-preview select-text text-[13px]" />
    </div>
  );
}
