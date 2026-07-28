import { useState } from "react";
import { AzureDevOpsSettings } from "./AzureDevOpsSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ProviderTabs } from "../common/ProviderTabs";
import { VCS_PROVIDERS } from "../../lib/vcsProviders";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";

/** The single "Git hosting" settings section — a provider switcher (Azure DevOps / GitHub /
 * GitLab-coming-soon) over whichever provider's credential form is active. Opens on the
 * provider the caller deep-linked to (e.g. a "needs a GitHub token" hint jumps straight here
 * with GitHub selected). */
export function GitHostingSettings() {
  const t = useT();
  const initialProvider = useUiStore((s) => s.settingsHostingProvider);
  const [provider, setProvider] = useState<string>(initialProvider);

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.gitHostingTitle")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.gitHostingHint")}</p>
      <ProviderTabs options={VCS_PROVIDERS} activeId={provider} onSelect={setProvider} layoutId="cf-vcs-provider-pill" />

      {provider === "github" ? <GitHubSettings /> : <AzureDevOpsSettings />}
    </section>
  );
}
