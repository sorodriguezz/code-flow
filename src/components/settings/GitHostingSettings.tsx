import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { motion } from "framer-motion";
import { AzureDevOpsSettings } from "./AzureDevOpsSettings";
import { BitbucketSettings } from "./BitbucketSettings";
import { GitHubSettings } from "./GitHubSettings";
import { GitLabSettings } from "./GitLabSettings";
import { JiraSettings } from "./JiraSettings";
import { MondaySettings } from "./MondaySettings";
import { ActivePill } from "../common/ActivePill";
import { chipClass } from "../common/recipes";
import { HOSTING_PROVIDERS, type HostingProvider } from "../../lib/vcsProviders";
import { tabsFor } from "../../lib/settingsCatalog";
import { PipelinesPane } from "./PipelinesSettings";
import { BrandGlyph } from "../ai/ProviderGlyph";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Panel, SettingsHeader } from "../api/settingsChrome";
import { RAIL_WIDTH, useSectionTab } from "./settingsNav";

/** One hint per provider, as a lookup rather than a ternary: a chain of `?:` silently falls
 * through to Azure for anything it doesn't name, which is exactly how a third provider ends up
 * describing itself as the first. A `Record<VcsProvider, …>` cannot compile with an arm missing. */
const HINT_KEYS: Record<HostingProvider, TranslationKey> = {
  azure: "settings.azureHint",
  github: "settings.githubHint",
  gitlab: "settings.gitlabHint",
  bitbucket: "settings.bitbucketHint",
  jira: "settings.jiraHint",
  monday: "settings.mondayHint",
};

/** The single "Integrations" settings section — the accounts (Azure DevOps / GitHub / GitLab /
 * Bitbucket / Jira / monday.com), each over its credential form, and since 2026-10-09 what the app
 * does with them: Pipelines' polling, which was a section of its own. Opens on the provider the
 * caller deep-linked to (e.g. a "needs a GitLab token" hint jumps straight here with GitLab
 * selected), or on any pane a search hit names.
 *
 * The two boards sit beside the code hosts because this is where a user connects an external
 * account, not because they host code — they host none, and nothing on the pull-request side offers
 * them.
 *
 * Behind a side rail that falls into two parts (`headingKey` in the catalog), drawn here rather than
 * by `SettingsRail` for the brand marks; the header and the rail stay put while the pane scrolls,
 * like every other railed section.
 */
export function GitHostingSettings() {
  const t = useT();
  const tabs = tabsFor("azure");
  const initialProvider = useUiStore((s) => s.settingsHostingProvider);
  const [tab, setTab] = useSectionTab("azure", tabs, initialProvider);

  // A caller that deep-links to a provider while this section is already on screen. Only on a
  // change: on mount the provider is already the fallback, and running then would undo a pane a
  // search hit or a link just asked for (Pipelines landed on Azure DevOps).
  const lastProvider = useRef(initialProvider);
  useEffect(() => {
    if (lastProvider.current === initialProvider) return;
    lastProvider.current = initialProvider;
    setTab(initialProvider);
  }, [initialProvider, setTab]);

  // The forms are not the same height: land at the top before the frame is painted rather than as a
  // visible correction after it — the same fix as the other railed sections.
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  const provider = HOSTING_PROVIDERS.find((entry) => entry.id === tab);
  const active = tabs.find((entry) => entry.id === tab);
  const hint = provider ? t(HINT_KEYS[provider.id]) : active?.hintKey ? t(active.hintKey) : "";

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader title={t("settings.integrationsTitle")} hint={t("settings.integrationsHint")} />
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* `layoutRoot` on a `motion.nav`, for the reason spelled out in `SettingsRail`: the pill's
            before/after rects are measured against the rail, which never scrolls. */}
        <motion.nav layoutRoot style={{ width: RAIL_WIDTH }} className="shrink-0 self-start" aria-label={t("settings.sectionNavLabel")}>
          {tabs.map((entry, index) => {
            const hosting = HOSTING_PROVIDERS.find((item) => item.id === entry.id);
            const available = hosting?.available ?? true;
            const selected = tab === entry.id;
            const Icon = hosting?.icon ?? entry.icon;
            return (
              <Fragment key={entry.id}>
                {entry.headingKey && (
                  <p
                    className={`mb-1 px-2.5 text-[10.5px] font-semibold uppercase leading-[15px] tracking-[0.07em] text-[var(--cf-text-faint)] ${
                      index === 0 ? "" : "mt-3"
                    }`}
                  >
                    {t(entry.headingKey)}
                  </p>
                )}
                <button
                  type="button"
                  disabled={!available}
                  onClick={() => setTab(entry.id)}
                  aria-current={selected ? "page" : undefined}
                  title={hosting?.label ?? t(entry.labelKey)}
                  // Row for row `SettingsRail`'s look, which this rail can't be (brand marks,
                  // untranslated names, a "coming soon" chip): the pill carries the selection, the
                  // label turns full text and only the glyph takes the accent; no weight change.
                  className={`relative mb-0.5 flex min-h-8 w-full items-start rounded-md px-2.5 py-1.5 text-left text-[13px] leading-[1.35] transition-colors duration-100 ${
                    selected
                      ? "text-[var(--cf-text)]"
                      : available
                        ? "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                        : "cursor-not-allowed text-[var(--cf-text-muted)] opacity-45 grayscale"
                  }`}
                >
                  {/* Its own `layoutId`: sharing one with another group's pill would send it flying
                      between the two the moment both are on screen. */}
                  {selected && <ActivePill layoutId="cf-vcs-provider-pill" mark />}
                  <span className="relative flex min-w-0 flex-1 items-start gap-2">
                    {/* The platform's own mark, and the registry's Lucide glyph for any provider
                        `brandLogos.ts` has none for. The accent reaches only a monochrome mark
                        (GitHub's); the others keep their brand colours. */}
                    <span className={`mt-[2px] shrink-0 ${selected ? "text-[var(--cf-accent)]" : ""}`}>
                      {hosting ? (
                        <BrandGlyph id={hosting.id} size={14} fallback={<Icon size={14} className="shrink-0" />} />
                      ) : (
                        <Icon size={14} className="shrink-0" />
                      )}
                    </span>
                    {/* Wraps rather than truncates — see `settingsNav`, whose rail this one mirrors. */}
                    <span className="min-w-0 flex-1 break-words">{hosting?.label ?? t(entry.labelKey)}</span>
                    {!available && <span className={chipClass("neutral", "-mt-px")}>{t("settings.comingSoon")}</span>}
                  </span>
                </button>
              </Fragment>
            );
          })}
        </motion.nav>

        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          {/* The API client's panel, so the two read as the same surface. */}
          <Panel>
            {/* The rail names the pane, so its form no longer repeats it as a heading — but the hint
                says what the label can't (which host a token is for, that a PAT is stored in the
                keychain), so it stays. */}
            {hint && <p className="mb-3 text-[12px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>}

            {tab === "github" && <GitHubSettings />}
            {tab === "gitlab" && <GitLabSettings />}
            {tab === "bitbucket" && <BitbucketSettings />}
            {tab === "azure" && <AzureDevOpsSettings />}
            {tab === "jira" && <JiraSettings />}
            {tab === "monday" && <MondaySettings />}
            {tab === "pipelines" && <PipelinesPane />}
          </Panel>
        </div>
      </div>
    </section>
  );
}
