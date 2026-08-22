import { useLayoutEffect, useRef, useState } from "react";
import { Braces, Palette, Scissors, Sparkles, type LucideIcon } from "lucide-react";
import { motion } from "framer-motion";
import { ActivePill } from "../common/ActivePill";
import { useT } from "../../state/languageStore";
import { SnippetsSettings } from "./SnippetsSettings";
import { LanguageServersSettings } from "./LanguageServersSettings";
import { IconRulesSettings } from "./IconRulesSettings";
import { AiCompletionSettings } from "./AiCompletionSettings";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Panel, SettingsHeader } from "../api/settingsChrome";

type EditorTab = "snippets" | "languageServers" | "completion" | "icons";

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
const TABS: { id: EditorTab; labelKey: TranslationKey; hintKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "snippets", labelKey: "snippets.title", hintKey: "snippets.hint", icon: Scissors },
  { id: "languageServers", labelKey: "settings.lspTitle", hintKey: "settings.lspHint", icon: Braces },
  // Third, and it belongs with the two above rather than under the AI section: those answer "where
  // do my completions come from", and so does this — the difference is only that this source is a
  // model rather than a snippet file or a compiler. Putting it beside the cloud review engines
  // would file it by *what it is* instead of by what it does to the editor.
  { id: "completion", labelKey: "localai.title", hintKey: "localai.hint", icon: Sparkles },
  // Last, and a little apart in kind from the two above: they answer "where do my completions come
  // from", this one answers "why does that file look like that". It is here rather than under
  // Appearance because it is the editor's tree it repaints, and because it belongs with the other
  // two things about the editor that are global rather than per repository.
  { id: "icons", labelKey: "icons.title", hintKey: "icons.settingsHint", icon: Palette },
];

export function EditorSettings() {
  const t = useT();
  const [tab, setTab] = useState<EditorTab>("snippets");
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

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
        <motion.nav layoutRoot className="w-[168px] shrink-0 self-start">
          {TABS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              title={t(labelKey)}
              className={`relative mb-0.5 flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                tab === id
                  ? "text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
              }`}
            >
              {/* Its own `layoutId`, never shared with another group's pill. */}
              {tab === id && <ActivePill layoutId="cf-editor-settings-pill" />}
              <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{t(labelKey)}</span>
              </span>
            </button>
          ))}
        </motion.nav>

        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          <Panel>
            {/* The rail names the pane, so no heading is repeated here — but the hint says what the
                label cannot, so it stays. Same call as the AI section. */}
            <p className="mb-3 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(active.hintKey)}</p>

            {tab === "snippets" && <SnippetsSettings />}
            {tab === "languageServers" && <LanguageServersSettings />}
            {tab === "completion" && <AiCompletionSettings />}
            {tab === "icons" && <IconRulesSettings />}
          </Panel>
        </div>
      </div>
    </section>
  );
}
