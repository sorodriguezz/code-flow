import { useLayoutEffect, useRef, useState } from "react";
import { Cpu, FileText, Server, type LucideIcon } from "lucide-react";
import { motion } from "framer-motion";
import { ActivePill } from "../common/ActivePill";
import { useT } from "../../state/languageStore";
import { PromptTemplates } from "./PromptTemplates";
import { ProvidersSection } from "./ProvidersSection";
import { TaskRouting } from "./TaskRouting";
import type { TranslationKey } from "../../lib/i18n/translations";

type AiTab = "providers" | "routing" | "templates";

/**
 * The three groups, in the order you'd actually set them up:
 *   1. **Providers** — which engines exist, whether they're installed, how each is configured.
 *   2. **Model per task** — which of those engines (and model) handles each action.
 *   3. **Prompt templates** — shared instructions, independent of who runs them.
 */
const TABS: { id: AiTab; labelKey: TranslationKey; hintKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "providers", labelKey: "settings.providersTitle", hintKey: "settings.providersHint", icon: Server },
  { id: "routing", labelKey: "settings.taskRoutingTitle", hintKey: "settings.taskRoutingHint", icon: Cpu },
  { id: "templates", labelKey: "settings.templatesTitle", hintKey: "settings.templatesSharedHint", icon: FileText },
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

  // The three panes are nowhere near the same height — arriving at a short one while the settings
  // column was scrolled down through the long provider list left it starting somewhere in the
  // middle. Same fix, and same reason for the layout effect, as `ApiSettingsBody`: land at the top
  // before the frame is painted rather than as a visible correction after it.
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    bodyRef.current?.closest("[data-settings-scroll]")?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.aiSectionTitle")}</h3>
      <p className="mb-4 text-[13px] text-[var(--cf-text-muted)]">{t("settings.aiSectionHint")}</p>

      <div ref={bodyRef} className="flex gap-4">
        {/* `layoutRoot` on a `motion.nav`, for the reason spelled out in `ApiSettingsBody`: the
            rail is sticky, so the pill's before/after rects would otherwise be measured against a
            scroll position the arriving pane has just changed, and the slide would land as a jump.
            Measuring against the rail — which never moves — keeps it a slide. */}
        <motion.nav layoutRoot className="sticky top-0 w-[168px] shrink-0 self-start">
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

        <div className="min-w-0 flex-1">
          <div className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4">
            {/* The rail names the pane, so there's no heading repeated here — but the hint says
                something the label can't (what "inherit" falls back to, that a prompt is shared
                across engines), so it stays. */}
            <p className="mb-4 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(active.hintKey)}</p>

            {tab === "providers" && <ProvidersSection />}
            {tab === "routing" && <TaskRouting />}
            {tab === "templates" && <PromptTemplates />}
          </div>
        </div>
      </div>
    </section>
  );
}
