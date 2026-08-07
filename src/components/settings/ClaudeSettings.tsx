import { useLayoutEffect, useRef, useState } from "react";
import { ChartColumn, Cpu, FileText, Server, type LucideIcon } from "lucide-react";
import { motion } from "framer-motion";
import { ActivePill } from "../common/ActivePill";
import { useT } from "../../state/languageStore";
import { PromptTemplates } from "./PromptTemplates";
import { ProvidersSection } from "./ProvidersSection";
import { TaskRouting } from "./TaskRouting";
import { UsageStatsSection } from "./UsageStatsSection";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Panel, SettingsHeader } from "../api/settingsChrome";

type AiTab = "providers" | "routing" | "templates" | "usage";

/**
 * The groups, in the order you'd actually set them up:
 *   1. **Providers** — which engines exist, whether they're installed, how each is configured.
 *   2. **Model per task** — which of those engines (and model) handles each action.
 *   3. **Prompt templates** — shared instructions, independent of who runs them.
 *   4. **Usage** — what all of that has actually spent. Last because it is the only one that
 *      configures nothing: it reads back the consequences of the three above.
 */
const TABS: { id: AiTab; labelKey: TranslationKey; hintKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "providers", labelKey: "settings.providersTitle", hintKey: "settings.providersHint", icon: Server },
  { id: "routing", labelKey: "settings.taskRoutingTitle", hintKey: "settings.taskRoutingHint", icon: Cpu },
  { id: "templates", labelKey: "settings.templatesTitle", hintKey: "settings.templatesSharedHint", icon: FileText },
  { id: "usage", labelKey: "usage.statsTitle", hintKey: "usage.statsHint", icon: ChartColumn },
];

/**
 * The AI assistant settings, behind a side rail — the same shape as the API client's settings,
 * down to the sliding pill, so a nested nav reads as part of the furniture the Settings window
 * already uses rather than as a second idea.
 *
 * It replaces three stacked cards that all opened collapsed: every group cost a click to reach,
 * opening one pushed the others off screen, and the provider list is long enough that scrolling
 * past it was the only way to reach the two below. One rail, one pane, nothing to unfold.
 */
export function ClaudeSettings() {
  const t = useT();
  const [tab, setTab] = useState<AiTab>("providers");
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  // The three panes are nowhere near the same height — arriving at a short one while scrolled down
  // through the long provider list left it starting somewhere in the middle. Same fix, and same
  // reason for the layout effect, as `ApiSettingsBody`: land at the top before the frame is painted
  // rather than as a visible correction after it. It scrolls the *pane* now, which is the element
  // that moves — see the layout note below.
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
        {/* `layoutRoot` on a `motion.nav`, for the reason spelled out in `ApiSettingsBody`: the
            pill's before/after rects would otherwise be measured against a scroll position the
            arriving pane has just changed, and the slide would land as a jump. Measuring against
            the rail — which never moves — keeps it a slide. It no longer needs `sticky`: it is
            outside the scrolling element now, so it cannot move in the first place. */}
        <motion.nav layoutRoot className="w-[168px] shrink-0 self-start">
          {TABS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              title={t(labelKey)}
              // Colour and the pill carry the selection; no weight change, which would re-measure
              // the label and reflow the row.
              className={`relative mb-0.5 flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                tab === id
                  ? "text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
              }`}
            >
              {/* Its own `layoutId`: sharing one with another group's pill would send it flying
                  between the two the moment both are on screen. */}
              {tab === id && <ActivePill layoutId="cf-ai-settings-pill" />}
              {/* Above the pill, which covers the whole button. */}
              <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{t(labelKey)}</span>
              </span>
            </button>
          ))}
        </motion.nav>

        {/* The one moving part. `overflow-y-scroll`, not `auto`: the app styles its scrollbars, so
            one is a real 10px of layout rather than an overlay. Letting it come and go as a pane
            grows past the height — which is exactly what expanding a row does — narrowed the
            content and shifted every row sideways, then shifted them back on collapse. Same
            reserved-gutter fix, and the same reason, as the settings column around it; the track is
            transparent and the thumb isn't drawn when there is nothing to scroll. `pb-6` because
            the pane ends where the dialog does, and a last row flush against that edge reads as cut
            off rather than as the end of the list. */}
        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          {/* The API client's own panel, not a second box that looks nearly like it: a raised fill
              and a wider radius here made this pane read as a different kind of surface from the
              one two sections away, which is the sort of difference nobody can name and everybody
              notices. */}
          <Panel>
            {/* The rail names the pane, so there's no heading repeated here — but the hint says
                something the label can't (what "inherit" falls back to, that a prompt is shared
                across engines), so it stays. */}
            <p className="mb-3 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(active.hintKey)}</p>

            {tab === "providers" && <ProvidersSection />}
            {tab === "routing" && <TaskRouting />}
            {tab === "templates" && <PromptTemplates />}
            {tab === "usage" && <UsageStatsSection />}
          </Panel>
        </div>
      </div>
    </section>
  );
}
