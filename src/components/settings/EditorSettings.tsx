import { useLayoutEffect, useRef } from "react";

import { useT } from "../../state/languageStore";
import { SnippetsSettings } from "./SnippetsSettings";
import { LanguageServersSettings } from "./LanguageServersSettings";
import { IconRulesSettings } from "./IconRulesSettings";
import { Panel, SettingsHeader } from "../api/settingsChrome";
import { SettingsRail, useSectionTab } from "./settingsNav";
import { tabsFor } from "../../lib/settingsCatalog";

/**
 * What the editor does while you type, and what it draws while you read, behind one rail.
 *
 * They were two entries in the settings nav and they should not have been: both answer the same
 * question — *where do the things in my completion dropdown come from?* — and one of them is the
 * answer whenever the other isn't. A snippet is what you wrote and the app offers verbatim; a
 * language server is what a compiler worked out. Somebody looking for either is as likely to be
 * looking for the other, which is the same reasoning that put snippets beside the keybindings in
 * the first place, applied one level in.
 *
 * Same shape as `ClaudeSettings`, deliberately down to the sliding pill: a nested nav should read
 * as furniture the Settings window already uses, not as a second idea. (`ReviewSettings` is the
 * other nested nav in this window, but it is the horizontal variant with an underline rather than a
 * pill — see the note in `ActivePill` on why those are two indicators and not one.)
 */

export function EditorSettings() {
  const t = useT();
  const tabs = tabsFor("editor");
  const [tab, setTab] = useSectionTab("editor", tabs, "snippets");
  const active = tabs.find((entry) => entry.id === tab) ?? tabs[0];

  // The two panes are nowhere near the same height — a long snippet list and a fourteen-row server
  // table — so arriving at one while scrolled down through the other left it starting in the
  // middle. Same fix and same reason as `ClaudeSettings`: land at the top before the frame is
  // painted rather than as a visible correction after it.
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader title={t("settings.editorSection")} hint={t("settings.editorSectionHint")} />
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* `layoutRoot`, for the reason `ClaudeSettings` spells out: the pill's before/after rects
            would otherwise be measured against a scroll position the arriving pane has just
            changed, and the slide would land as a jump. */}
        <SettingsRail tabs={tabs} active={tab} onSelect={setTab} layoutId="cf-editor-settings-pill" />

        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          <Panel>
            {/* The rail names the pane, so no heading is repeated here — but the hint says what the
                label cannot, so it stays. Same call as the AI section. */}
            {active?.hintKey && (
              <p className="mb-3 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(active.hintKey)}</p>
            )}

            {tab === "snippets" && <SnippetsSettings />}
            {tab === "languageServers" && <LanguageServersSettings />}
            {tab === "icons" && <IconRulesSettings />}
          </Panel>
        </div>
      </div>
    </section>
  );
}
