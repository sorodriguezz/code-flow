/**
 * The vertical rail that five settings sections hang their panes off, and the hook that lets any of
 * them be opened straight onto one.
 *
 * It existed five times before this file: AI, Editor, Backup, the API client and the integrations
 * list each hand-rolled the same `motion.nav` with the same pill, the same 168px width and the same
 * `truncate` on the label. Which is how "Autocompletado con IA" came to render as "Autocompletado
 * co…" in one of them — the rail was two characters too narrow for one label in one language, and
 * there was no single place to fix it.
 *
 * **Labels wrap here; they are never cut.** That is the substantive change over the five copies,
 * and it is a deliberate reversal of what the old rails did. Truncating kept every row exactly one
 * line tall, which is tidy — but the name of a settings pane is not decoration, it is the only
 * thing telling you whether the pane is the one you want, and half of it is worse than a row of
 * uneven height. Wrapping also survives translation: a label that fits in English and not in
 * Spanish now takes two lines instead of losing its ending, and no width has to be re-tuned per
 * language. The rail is wider than it was (168 → 190) so most labels still take one line anyway.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ActivePill } from "../common/ActivePill";
import { useUiStore, type SettingsSectionId } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import type { SettingsTabDef } from "../../lib/settingsCatalog";

/** Wide enough for every shipped label in both languages on one line, bar two that wrap. */
export const RAIL_WIDTH = 190;

/**
 * Which pane a section is showing, honouring a pending deep link from the settings search.
 *
 * The pending id is consumed once and cleared, so re-entering the section later lands on whatever
 * the user last picked rather than replaying an old search. An id that no longer matches a tab —
 * a pane renamed between releases, a stale link — falls through to the first tab instead of
 * rendering an empty pane.
 */
export function useSectionTab(
  section: SettingsSectionId,
  tabs: SettingsTabDef[],
  fallback: string,
): [string, (id: string) => void] {
  const pending = useUiStore((s) => (s.settingsSection === section ? s.settingsTab : null));
  const clearSettingsTab = useUiStore((s) => s.clearSettingsTab);
  const [tab, setTab] = useState<string>(fallback);

  useEffect(() => {
    if (!pending) return;
    if (tabs.some((entry) => entry.id === pending)) setTab(pending);
    clearSettingsTab();
  }, [pending, tabs, clearSettingsTab]);

  // A tab id that is no longer in the list (a pane removed in an update, with the old id still in
  // this component's state) would render nothing at all — fall back rather than blank the pane.
  const safe = tabs.some((entry) => entry.id === tab) ? tab : fallback;
  return [safe, setTab];
}

/**
 * One rail. `layoutId` must be unique per rail — two rails sharing one send the pill flying between
 * them the moment both are mounted.
 */
export function SettingsRail({
  tabs,
  active,
  onSelect,
  layoutId,
}: {
  tabs: SettingsTabDef[];
  active: string;
  onSelect: (id: string) => void;
  layoutId: string;
}) {
  const t = useT();
  return (
    // `layoutRoot`: the pill's before/after rects are measured against the rail, which never
    // scrolls, rather than against the pane beside it, which the arriving tab has just scrolled to
    // the top. Measured against the pane, the slide lands as a jump.
    <motion.nav
      layoutRoot
      style={{ width: RAIL_WIDTH }}
      className="shrink-0 self-start"
      aria-label={t("settings.sectionNavLabel")}
    >
      {tabs.map(({ id, labelKey, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          aria-current={active === id ? "page" : undefined}
          // Selection changes colour and nothing else — no weight change, which would re-measure
          // the label and reflow the row on every click.
          className={`relative mb-0.5 flex w-full items-start rounded-md px-2.5 py-1.5 text-left text-[12.5px] leading-[1.35] transition-colors ${
            active === id
              ? "text-[var(--cf-accent)]"
              : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
          }`}
        >
          {active === id && <ActivePill layoutId={layoutId} />}
          {/* Above the pill, which covers the whole button. */}
          <span className="relative flex min-w-0 flex-1 items-start gap-1.5">
            {/* `mt-[2px]` puts a 13px glyph on the cap height of the first line rather than
                centred against a label that may be two lines tall. */}
            <Icon size={13} className="mt-[2px] shrink-0" />
            {/* No `truncate`, and `break-words` so a single long word — a provider name, a
                language server id — wraps instead of pushing the rail wider. */}
            <span className="min-w-0 flex-1 break-words">{t(labelKey)}</span>
          </span>
        </button>
      ))}
    </motion.nav>
  );
}
