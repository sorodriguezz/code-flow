import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AzureDevOpsSettings } from "./AzureDevOpsSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ActivePill } from "../common/ActivePill";
import { VCS_PROVIDERS } from "../../lib/vcsProviders";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import type { VcsProvider } from "../../types/domain";

/** The single "Git hosting" settings section — a provider switcher (Azure DevOps / GitHub /
 * GitLab-coming-soon) over whichever provider's credential form is active. Opens on the
 * provider the caller deep-linked to (e.g. a "needs a GitHub token" hint jumps straight here
 * with GitHub selected).
 *
 * Behind a side rail, the same shape as the AI assistant and API client sections down to the
 * sliding pill: one nested-nav idea across the window rather than a row of provider cards here
 * and a rail everywhere else.
 */
export function GitHostingSettings() {
  const t = useT();
  const initialProvider = useUiStore((s) => s.settingsHostingProvider);
  const [provider, setProvider] = useState<VcsProvider>(initialProvider);

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

  // Only the two wired providers can be selected, so the hint tracks the same fork as the body.
  const hintKey = provider === "github" ? "settings.githubHint" : "settings.azureHint";

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.gitHostingTitle")}</h3>
      <p className="mb-4 text-[13px] text-[var(--cf-text-muted)]">{t("settings.gitHostingHint")}</p>

      <div ref={bodyRef} className="flex gap-4">
        {/* `layoutRoot` on a `motion.nav`, for the reason spelled out in `ApiSettingsBody`: the
            rail is sticky, so the pill's before/after rects would otherwise be measured against a
            scroll position the arriving pane has just changed, and the slide would land as a jump.
            Measuring against the rail — which never moves — keeps it a slide. */}
        <motion.nav layoutRoot className="sticky top-0 w-[168px] shrink-0 self-start">
          {VCS_PROVIDERS.map(({ id, label, icon: Icon, available }) => (
            <button
              key={id}
              disabled={!available}
              // `disabled` is what stops GitLab being picked; the `id` check is what tells the
              // compiler so, since `VcsProvider` covers only the providers that have a form.
              onClick={() => id !== "gitlab" && setProvider(id)}
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
          <div className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4">
            {/* The rail names the provider, so its form no longer repeats it as a heading — but the
                hint says what the label can't (which host a token is for, that a PAT is stored in
                the keychain), so it stays. */}
            <p className="mb-4 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(hintKey)}</p>

            {provider === "github" ? <GitHubSettings /> : <AzureDevOpsSettings />}
          </div>
        </div>
      </div>
    </section>
  );
}
