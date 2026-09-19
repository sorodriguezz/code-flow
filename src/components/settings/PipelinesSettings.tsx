/**
 * The Pipelines tab's own settings, behind the same rail every other multi-pane section uses.
 *
 * It is the only polling client in the app: every live run costs a request against somebody else's
 * rate limit every five seconds. That is a fine default for one person watching one build and a
 * poor one for a machine watching four repositories on a shared token, which is what the knob in
 * the first pane is for.
 *
 * # Why a rail for what used to be one knob
 *
 * Not to fill space. The second pane answers the question this section is actually opened with —
 * *why is there no Pipelines tab on this repository* — which until now was a footnote underneath
 * the knob, which is the last place anybody looks for it. Giving it a name in the rail is what
 * makes it findable, and it is what the settings search indexes.
 *
 * Same shape as `EditorSettings` and `ClaudeSettings`, down to the sliding pill: a nested nav
 * should read as furniture this window already uses, not as a second idea.
 */

import { useLayoutEffect, useRef } from "react";
import { DEFAULT_PIPELINE_POLL, PIPELINE_POLL_CHOICES } from "../../state/ciStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useT } from "../../state/languageStore";
import { Note, Panel, SettingsHeader } from "../api/settingsChrome";
import { SettingsRail, useSectionTab } from "./settingsNav";
import { tabsFor } from "../../lib/settingsCatalog";

function PollingPane() {
  const t = useT();
  const seconds = usePreferencesStore((s) => s.pipelinePollSeconds);
  const setSeconds = usePreferencesStore((s) => s.setPipelinePollSeconds);

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {PIPELINE_POLL_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => void setSeconds(choice)}
            className={`rounded-md border px-2.5 py-1 text-[11.5px] transition-colors ${
              seconds === choice
                ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "border-[var(--cf-border)] text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            }`}
          >
            {/* Never truncated, and each option reads as a full phrase rather than a bare
                number — "5" beside "10" beside "60" makes the unit somebody's guess. */}
            {t("pipelines.pollSeconds", { n: choice })}
          </button>
        ))}
      </div>
      {seconds === DEFAULT_PIPELINE_POLL && (
        <div className="mt-2">
          <Note>{t("pipelines.pollDefaultNote")}</Note>
        </div>
      )}
    </>
  );
}

function AvailabilityPane() {
  const t = useT();
  return (
    <>
      <p className="mb-2 text-[11.5px] leading-snug text-[var(--cf-text)]">
        {t("pipelines.availabilityBody")}
      </p>
      <Note>{t("pipelines.availabilityHosts")}</Note>
    </>
  );
}

export function PipelinesSettings() {
  const t = useT();
  const tabs = tabsFor("pipelines");
  const [tab, setTab] = useSectionTab("pipelines", tabs, "polling");
  const active = tabs.find((entry) => entry.id === tab) ?? tabs[0];

  // Land at the top before the frame is painted rather than as a visible correction after it: the
  // two panes are different heights, so arriving at one while scrolled through the other would
  // otherwise start it in the middle. Same fix and same reason as `EditorSettings`.
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader title={t("tabbar.pipelines")} hint={t("pipelines.settingsHint")} />
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <SettingsRail tabs={tabs} active={tab} onSelect={setTab} layoutId="cf-pipelines-settings-pill" />

        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          <Panel>
            {/* The rail names the pane, so no heading is repeated here — but the hint says what the
                label cannot, so it stays. Same call as the editor and AI sections. */}
            {active?.hintKey && (
              <p className="mb-3 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(active.hintKey)}</p>
            )}

            {tab === "polling" && <PollingPane />}
            {tab === "availability" && <AvailabilityPane />}
          </Panel>
        </div>
      </div>
    </section>
  );
}
