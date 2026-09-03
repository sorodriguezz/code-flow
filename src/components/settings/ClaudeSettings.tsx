import { useLayoutEffect, useRef } from "react";
import { AiCompletionSettings } from "./AiCompletionSettings";
import { AiTasksSettings } from "./AiTasksSettings";
import { useT } from "../../state/languageStore";
import { ProvidersSection } from "./ProvidersSection";
import { QuotaSection } from "./QuotaSection";
import { UsageStatsSection } from "./UsageStatsSection";
import { SettingsRail, useSectionTab } from "./settingsNav";
import { tabsFor } from "../../lib/settingsCatalog";
import { Panel, SettingsHeader } from "../api/settingsChrome";

/**
 * The AI assistant settings, behind a side rail — the same shape as the API client's settings,
 * down to the sliding pill, so a nested nav reads as part of the furniture the Settings window
 * already uses rather than as a second idea.
 *
 * The panes, in the order you'd actually set them up:
 *   1. **Providers** — which engines exist, whether they're installed, how each is configured.
 *   2. **Tasks and prompts** — which engine runs each action, and what it is told to do.
 *   3. **Autocomplete** — the model that runs on this machine and finishes what you type.
 *   4. **Limits** — how far through each provider's plan you are, as the provider reports it.
 *   5. **Usage** — what all of that has actually spent, as this app measured it.
 *
 * Two used to be five and are now one. "Model per task" and "Prompt templates" were separate tabs
 * describing the same sixteen actions from two sides, and the templates pane had to import the
 * routing store just to print which engine would run each prompt — see `AiTasksSettings`.
 *
 * Autocomplete sits third, after the two that configure the assistant and before the two that
 * report on it, and it arrived here from the Editor section — where it was filed while it *was* an
 * editor feature. It is not one any more: the same local model now finishes DBML in the schema
 * workbench and SQL in the database console. A capability three surfaces share belongs with the
 * other AI settings; leaving it under Editor would have meant the database console's completion
 * being configured from a pane named after something else.
 *
 * The last two configure nothing; they read back the consequences of the ones above. They are two
 * tabs and not one because they are two different claims: a limit is the provider's statement about
 * a window still running, spend is this app's record of windows already over. Stacked on one screen
 * they read as one table with two halves, and the usage screen's 5h/30d picker appeared to govern
 * bars it has no say over.
 *
 * The tab list itself lives in `settingsCatalog` now, so the settings search can offer these five
 * panes by name and open one directly.
 */
export function ClaudeSettings() {
  const t = useT();
  const tabs = tabsFor("claude");
  const [tab, setTab] = useSectionTab("claude", tabs, "providers");
  const active = tabs.find((entry) => entry.id === tab) ?? tabs[0];

  // The panes are nowhere near the same height — arriving at a short one while scrolled down
  // through the long provider list left it starting somewhere in the middle. Same fix, and same
  // reason for the layout effect, as `ApiSettingsBody`: land at the top before the frame is painted
  // rather than as a visible correction after it. It scrolls the *pane*, which is the element that
  // moves — see the layout note below.
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    // A fixed frame with one moving part. The heading and the rail used to ride the settings
    // column's own scrollbar: the rail was `sticky top-0`, so it travelled up with the title until
    // it hit the top and only then pinned — which reads as the menu sliding away and snapping back,
    // and the title left for good. Now the section fills the height it is given (`h-full` from
    // `SELF_SCROLLING_SECTIONS`), the heading and rail are fixed rows in it, and the pane beside
    // them is the only thing that scrolls.
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader title={t("settings.aiSectionTitle")} hint={t("settings.aiSectionHint")} />
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <SettingsRail tabs={tabs} active={tab} onSelect={setTab} layoutId="cf-ai-settings-pill" />

        {/* The one moving part. `overflow-y-scroll`, not `auto`: the app styles its scrollbars, so
            one is a real 10px of layout rather than an overlay. Letting it come and go as a pane
            grows past the height — which is exactly what expanding a row does — narrowed the
            content and shifted every row sideways, then shifted them back on collapse. Same
            reserved-gutter fix, and the same reason, as the settings column around it; the track is
            transparent and the thumb isn't drawn when there is nothing to scroll. `pb-6` because
            the pane ends where the dialog does, and a last row flush against that edge reads as cut
            off rather than as the end of the list. */}
        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          <Panel>
            {/* The rail names the pane, so there's no heading repeated here — but the hint says
                something the label can't (what "inherit" falls back to, that a prompt is shared
                across engines), so it stays. */}
            {active?.hintKey && (
              <p className="mb-3 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(active.hintKey)}</p>
            )}

            {tab === "providers" && <ProvidersSection />}
            {tab === "tasks" && <AiTasksSettings />}
            {tab === "completion" && <AiCompletionSettings />}
            {tab === "limits" && <QuotaSection />}
            {tab === "usage" && <UsageStatsSection />}
          </Panel>
        </div>
      </div>
    </section>
  );
}
