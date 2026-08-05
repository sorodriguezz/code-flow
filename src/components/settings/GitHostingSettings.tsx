import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AzureDevOpsSettings } from "./AzureDevOpsSettings";
import { GitHubSettings } from "./GitHubSettings";
import { GitLabSettings } from "./GitLabSettings";
import { JiraSettings } from "./JiraSettings";
import { MondaySettings } from "./MondaySettings";
import { ActivePill } from "../common/ActivePill";
import { HOSTING_PROVIDERS, type HostingProvider } from "../../lib/vcsProviders";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Panel, SettingsHeader } from "../api/settingsChrome";

/** One hint per provider, as a lookup rather than a ternary: a chain of `?:` silently falls
 * through to Azure for anything it doesn't name, which is exactly how a third provider ends up
 * describing itself as the first. A `Record<VcsProvider, …>` cannot compile with an arm missing. */
const HINT_KEYS: Record<HostingProvider, TranslationKey> = {
  azure: "settings.azureHint",
  github: "settings.githubHint",
  gitlab: "settings.gitlabHint",
  jira: "settings.jiraHint",
  monday: "settings.mondayHint",
};

/** The single "Integrations" settings section — a provider switcher (Azure DevOps / GitHub / GitLab /
 * Jira / monday.com) over whichever provider's credential form is active. Opens on the provider the caller
 * deep-linked to (e.g. a "needs a GitLab token" hint jumps straight here with GitLab selected).
 *
 * The two boards sit beside the three code hosts because this is where a user connects an external
 * account, not because they host code — they host none, and nothing on the pull-request side offers
 * them.
 *
 * Behind a side rail, the same shape as the AI assistant and API client sections down to the
 * sliding pill: one nested-nav idea across the window rather than a row of provider cards here
 * and a rail everywhere else.
 */
export function GitHostingSettings() {
  const t = useT();
  const initialProvider = useUiStore((s) => s.settingsHostingProvider);
  const [provider, setProvider] = useState<HostingProvider>(initialProvider);

  // Initial state alone is only read on mount, so a caller that deep-links to a provider while
  // this section is already on screen would be silently ignored — same sync as `ApiSettingsBody`.
  useEffect(() => {
    setProvider(initialProvider);
  }, [initialProvider]);

  // GitHub's form carries an extra host field, so the two panes aren't the same height: arriving
  // at the shorter one while the column was scrolled down left it starting mid-pane. Same fix, and
  // same reason for the layout effect, as the other two railed sections — land at the top before
  // the frame is painted rather than as a visible correction after it.
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    bodyRef.current?.closest("[data-settings-scroll]")?.scrollTo({ top: 0 });
  }, [provider]);

  const hintKey = HINT_KEYS[provider];

  return (
    <section>
      <SettingsHeader title={t("settings.integrationsTitle")} hint={t("settings.integrationsHint")} />

      <div ref={bodyRef} className="flex gap-4">
        {/* `layoutRoot` on a `motion.nav`, for the reason spelled out in `ApiSettingsBody`: the
            rail is sticky, so the pill's before/after rects would otherwise be measured against a
            scroll position the arriving pane has just changed, and the slide would land as a jump.
            Measuring against the rail — which never moves — keeps it a slide. */}
        <motion.nav layoutRoot className="sticky top-0 w-[168px] shrink-0 self-start">
          {HOSTING_PROVIDERS.map(({ id, label, icon: Icon, available }) => (
            <button
              key={id}
              disabled={!available}
              onClick={() => setProvider(id)}
              aria-current={provider === id ? "page" : undefined}
              title={label}
              // Colour and the pill carry the selection; no weight change, which would re-measure
              // the label and reflow the row.
              className={`relative mb-0.5 flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                provider === id
                  ? "text-[var(--cf-accent)]"
                  : available
                    ? "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
                    : "cursor-not-allowed text-[var(--cf-text-muted)] opacity-45 grayscale"
              }`}
            >
              {/* Its own `layoutId`: sharing one with another group's pill would send it flying
                  between the two the moment both are on screen. */}
              {provider === id && <ActivePill layoutId="cf-vcs-provider-pill" />}
              {/* Above the pill, which covers the whole button. */}
              <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{label}</span>
                {!available && (
                  <span className="ml-auto shrink-0 rounded bg-black/10 px-1 py-[1px] text-[9px] font-bold uppercase tracking-wide dark:bg-white/10">
                    {t("settings.comingSoon")}
                  </span>
                )}
              </span>
            </button>
          ))}
        </motion.nav>

        <div className="min-w-0 flex-1">
          {/* The API client's panel, so the two read as the same surface — see the note on the
              same swap in `ClaudeSettings`. */}
          <Panel>
            {/* The rail names the provider, so its form no longer repeats it as a heading — but the
                hint says what the label can't (which host a token is for, that a PAT is stored in
                the keychain), so it stays. */}
            <p className="mb-3 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(hintKey)}</p>

            {provider === "github" && <GitHubSettings />}
            {provider === "gitlab" && <GitLabSettings />}
            {provider === "azure" && <AzureDevOpsSettings />}
            {provider === "jira" && <JiraSettings />}
            {provider === "monday" && <MondaySettings />}
          </Panel>
        </div>
      </div>
    </section>
  );
}
