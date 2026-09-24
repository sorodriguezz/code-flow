import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ChevronsLeft, ChevronsRight, CornerDownLeft, Search, X, type LucideIcon } from "lucide-react";
import { ThemeSettings } from "./ThemeSettings";
import { ProjectsSettings } from "./ProjectsSettings";
import { GitHostingSettings } from "./GitHostingSettings";
import { ClaudeSettings } from "./ClaudeSettings";
import { ReviewSettings } from "./ReviewSettings";
import { SkillsSettings } from "./SkillsSettings";
import { GitSettings } from "./GitSettings";
import { TerminalSettings } from "./TerminalSettings";
import { GeneralSettings } from "./GeneralSettings";
import { BackupSettings } from "./BackupSettings";
import { RemoteSettings } from "./RemoteSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { VaultSettings } from "./VaultSettings";
import { NotificationSettings } from "./NotificationSettings";
import { PipelinesSettings } from "./PipelinesSettings";
import { ApiSettingsBody } from "../api/ApiSettingsPanel";
import { ActivePill } from "../common/ActivePill";
import { Kbd, iconButtonClass } from "../common/Button";
import { chipClass, fieldClass } from "../common/recipes";
import { ResizeHandle } from "../common/ResizeHandle";
import { Tooltip } from "../common/Tooltip";
import { useLayoutStore } from "../../state/layoutStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { EditorSettings } from "./EditorSettings";
import { useUiStore, type SettingsSectionId } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { scrollEdgeMask, useScrollEdges } from "../../lib/useScrollEdges";
import {
  SELF_SCROLLING_SECTIONS,
  SETTINGS_SECTIONS,
  searchSettings,
  type SettingsHit,
} from "../../lib/settingsCatalog";
import type { TranslationKey } from "../../lib/i18n/translations";

const NAV_MIN = 160;
const NAV_COLLAPSED = 50;
const NAV_MAX = 320;

/**
 * Sections still finding their shape, marked as such wherever they are listed.
 *
 * Not a disabled state and not a feature flag — the section works and is reachable. It is a promise
 * being withheld: that the settings here will keep their names, that the behaviour will not move
 * under a user who has come to rely on it.
 *
 * A set rather than a field on each entry so the answer to "what is still alpha" is one line to
 * read and one line to change when a section graduates.
 */
const ALPHA_SECTIONS = new Set<SettingsSectionId>();

// `SELF_SCROLLING_SECTIONS` is imported from the catalog rather than kept here: it is the second
// half of building a sub-rail, and a section can only be given one in the catalog.

/**
 * One row of the settings nav, wearing the same selected treatment as the Graph/Changes/Editor
 * tabs: the accent fill is the shared [`ActivePill`], so picking a section slides it there rather
 * than repainting two backgrounds.
 *
 * Both groups share the one `layoutId`, deliberately — the pill travels between "Global" and the
 * workspace group as one continuous movement, which is exactly what the eye expects from a single
 * list of sections. It works because every row stays mounted for as long as the nav is open.
 */
function SectionButton({
  id,
  labelKey,
  icon: Icon,
  active,
  collapsed,
  alpha,
  onSelect,
}: {
  id: SettingsSectionId;
  labelKey: TranslationKey;
  icon: LucideIcon;
  active: boolean;
  collapsed: boolean;
  /** Marks the section as not finished yet — see the `ALPHA_SECTIONS` note. */
  alpha?: boolean;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const t = useT();
  const label = t(labelKey);
  return (
    // Collapsed, the tooltip is the only place the name exists — and the only place the alpha mark
    // can be spelled out, since what fits beside a 16px icon is a dot and a dot cannot say which
    // word it stands for. The app's own tooltip rather than `title`, to the right of the rail and
    // without the platform's second-and-a-half wait; unfolded, the row says it all itself.
    <Tooltip
      side="right"
      label={label}
      disabled={!collapsed}
      trailing={alpha ? <span className={chipClass("warn", "uppercase")}>{t("settings.alpha")}</span> : undefined}
    >
      <button
        onClick={() => onSelect(id)}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? label : undefined}
        // Selection changes colour and nothing else — no weight change, exactly like the tabs.
        // Bolding on select re-measures the text and made the row jump every time it was picked.
        // Colour plus the pill is already the whole signal.
        // Folded, a fixed 36×36 centred in the 50px rail rather than the rail's full width: the pill
        // was drawn edge to edge and read as a band across the rail, not as a mark on one icon. The
        // 7px either side and the 4px between rows are the breathing room the user asked for.
        // Unfolded, 32px at least — one line or, for a long name, two.
        className={`relative flex rounded-md text-left text-[13px] leading-[1.35] transition-colors duration-100 ${
          collapsed
            ? "mx-auto mb-1 h-9 w-9 items-center justify-center"
            : "mb-0.5 min-h-8 w-full items-start px-2.5 py-1.5"
        } ${
          active
            ? "text-[var(--cf-accent)]"
            : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        }`}
      >
        {active && <ActivePill layoutId="cf-settings-pill" />}
        {/* Above the pill, which is absolutely positioned over the whole button.
            `flex-1` only while there is a label to stretch. It is what lets the name take the row
            and push the alpha badge to the end — and it is exactly what breaks the folded rail,
            because a sole child that grows leaves the button's `justify-center` no free space to
            distribute, so the icon lands hard against the left edge instead of in the middle.
            Measured: 7px from the rail's left edge rather than 25. Without it the span shrinks to
            its content and the centring works. */}
        <span className={`relative flex min-w-0 items-start gap-2 ${collapsed ? "" : "flex-1"}`}>
          {/* 16px folded, where the glyph is the whole row — the size the app rail's icons read at
              — and 14px beside a label, on the cap height of its first line. */}
          <Icon size={collapsed ? 16 : 14} className={`shrink-0 ${collapsed ? "" : "mt-[2px]"}`} />
          {collapsed
            ? alpha && (
                // The badge, shrunk to the only thing that survives at rail width: a dot on the
                // corner of the icon, in the same warning hue the full badge is written in, so the
                // two read as one mark seen at two sizes rather than as two different signals.
                <span
                  aria-hidden
                  className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--cf-warning)]"
                />
              )
            : (
                <>
                  {/* Wraps. It used to truncate, which kept every row one line tall at any nav
                      width — but the nav can be dragged down to 160px and a section whose name is
                      cut in half there is a section you cannot identify. Two lines is the cost; the
                      name in full is the point. `break-words` so one long word gives way rather
                      than widening the rail. */}
                  <span className="min-w-0 flex-1 break-words">{label}</span>
                  {alpha && (
                    <span className={chipClass("warn", "uppercase")}>{t("settings.alpha")}</span>
                  )}
                </>
              )}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The search results, in place of the nav.
 *
 * They replace the section list rather than dropping over it: the list *is* the index of this
 * window, so a search is a different index, not an overlay on the same one. Arrow keys walk the
 * results and Return opens the highlighted one, because a fifteen-section window is one somebody
 * reaches for the keyboard in.
 */
function SearchResults({
  hits,
  cursor,
  query,
  onPick,
  onHover,
}: {
  hits: SettingsHit[];
  cursor: number;
  query: string;
  onPick: (hit: SettingsHit) => void;
  onHover: (index: number) => void;
}) {
  const t = useT();

  if (hits.length === 0) {
    // `px-2.5` like every heading, row and hit in this rail: this message stands exactly where the
    // list it replaced stood, so a 6px step in the indent is visible.
    return (
      <div className="px-2.5 py-4">
        <p className="text-[13px] font-medium text-[var(--cf-text)]">
          {t("settings.searchNoResults", { query })}
        </p>
        <p className="mt-1 text-[12px] leading-snug text-[var(--cf-text-muted)]">
          {t("settings.searchNoResultsHint")}
        </p>
      </div>
    );
  }

  return (
    <ul className="pt-0.5" role="listbox" aria-label={t("settings.searchPlaceholder")}>
      {hits.map((hit, index) => {
        const Icon = hit.tab?.icon ?? hit.section.icon;
        const selected = index === cursor;
        return (
          <li key={`${hit.section.id}:${hit.tab?.id ?? ""}`}>
            <button
              type="button"
              role="option"
              aria-selected={selected}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(hit)}
              // The highlighted hit wears the selected-row fill every list in the app uses, with its
              // glyph in the accent — the cursor *is* the selection here, so they look alike.
              className={`flex min-h-8 w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100 ${
                selected ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
              }`}
            >
              <Icon size={14} className={`mt-[2px] shrink-0 ${selected ? "text-[var(--cf-accent)]" : ""}`} />
              <span className="min-w-0 flex-1">
                {/* Nothing truncates here either: a result you can only half-read is a result you
                    have to open to identify. */}
                <span className="block break-words text-[13px] leading-snug text-[var(--cf-text)]">
                  {hit.label}
                </span>
                {/* The section it lives in, always — "Proxy" alone doesn't say where to find it
                    again tomorrow. Omitted only when the result *is* the section. */}
                {hit.tab && (
                  <span className="mt-px block break-words text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {hit.breadcrumb}
                  </span>
                )}
              </span>
              {selected && <CornerDownLeft size={13} className="mt-[2px] shrink-0 text-[var(--cf-text-faint)]" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The arrow on a rail edge the list continues past. The fold toggle's shape — a 20px disc on the
 * surface, hairline and small shadow — so the rail's two floating controls read as a pair.
 * Unfolded, it centres on the rows rather than the whole nav: the scrollbar keeps a 10px gutter on
 * the right that the rows never use.
 */
function NavScrollCue({
  direction,
  label,
  folded,
  onClick,
}: {
  direction: "up" | "down";
  label: string;
  folded: boolean;
  onClick: () => void;
}) {
  const Icon = direction === "up" ? ChevronUp : ChevronDown;
  return (
    <div
      // Up sits `top-3`, on the fold toggle's own line (the toggle is `top-6` of the body, and this
      // scroller starts 12px down it) — side by side the two read as one row of rail controls; a
      // few pixels higher they looked like two buttons that had collided.
      className={`pointer-events-none absolute inset-x-0 flex justify-center ${direction === "up" ? "top-3" : "bottom-0.5"} ${
        folded ? "" : "pr-2.5"
      }`}
    >
      <Tooltip side="right" label={label}>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="cf-panel-in pointer-events-auto flex h-5 w-5 items-center justify-center rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)] shadow-sm transition-colors hover:text-[var(--cf-text)]"
        >
          <Icon size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

export function SettingsView() {
  const open = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.openSettings);
  const openSettingsAt = useUiStore((s) => s.openSettingsAt);
  const navWidth = useLayoutStore((s) => s.sizes.settingsNavWidth);
  // The window always opens with the nav folded to its icons (the user's call), and » unfolds it for
  // this visit only. It used to be a remembered layout flag that defaulted to unfolded.
  const [collapsed, setCollapsed] = useState(true);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWorkspaceName = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === activeWorkspaceId)?.name,
  );
  const t = useT();

  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const navScrollRef = useRef<HTMLDivElement>(null);
  // Whether the rail has sections out of view, above or below — see the cues around its scroller.
  const navEdges = useScrollEdges(navScrollRef, open);

  const hits = useMemo(() => searchSettings(query, t), [query, t]);
  const searching = query.trim().length > 0;
  // What the rail actually is: folded to its icons unless a search is showing results, which need
  // the room. The search lives in the header now, so a folded rail no longer has a way into it of
  // its own — it unfolds for as long as there is a query and folds back when the query goes
  // (cleared, Escape, or a result picked). `collapsed` stays the user's own choice throughout.
  const folded = collapsed && !searching;
  // Collapsed, the rail is 50px of pure content: the nav's horizontal padding moved onto its
  // children and the gutter is suppressed there (`cf-no-scrollbar`), so a 14px icon centres on
  // exactly 25.
  //
  // Measured, and worth recording because the obvious culprit was the wrong one. The padding was
  // never what broke this: before the search box existed the span shrink-wrapped and the button's
  // `justify-center` worked, landing the icon within a few pixels of centre even with 24px of
  // padding and a 10px bar in the way. What broke it was the `flex-1` added to that span so labels
  // could wrap — a growing sole child leaves `justify-center` no free space, and the icon dropped
  // to 7px from the left edge. See `SectionButton`.
  const railWidth = folded ? NAV_COLLAPSED : navWidth;

  // A new query starts at the top. Without this the highlight stays on whatever index it was at,
  // which after narrowing the list is a different row than the one the user was looking at.
  useEffect(() => setCursor(0), [query]);

  // Every opening starts with an empty box and the nav folded: a search left over from last time
  // makes the window open on a filtered list with no obvious cause, and a nav unfolded last visit is
  // not how the user wants the next one to start.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setCollapsed(true);
  }, [open]);

  const globalSections = SETTINGS_SECTIONS.filter((entry) => entry.group === "global");
  const workspaceSections = SETTINGS_SECTIONS.filter((entry) => entry.group === "workspace");

  /** A cue's click: most of a rail's height onward, so the next sections land in view with the last
   *  few seen still above them for context. */
  const pageNav = (direction: 1 | -1) => {
    const el = navScrollRef.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ top: direction * el.clientHeight * 0.7, behavior: still ? "auto" : "smooth" });
  };

  const pick = (hit: SettingsHit) => {
    if (hit.tab) openSettingsAt(hit.section.id, hit.tab.id);
    else setSection(hit.section.id);
    setQuery("");
  };

  // Closable via Escape, but deliberately NOT by clicking the backdrop — settings can hold
  // unsaved in-progress input, and an accidental outside click shouldn't discard it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Escape clears the search before it closes the window: while a query is showing, the
        // results *are* what is on screen, and dismissing the whole window to get rid of them
        // throws away the section you were on as well.
        if (query) {
          setQuery("");
          e.stopPropagation();
          return;
        }
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeSettings, query]);

  // Tab stays inside the window. See `useFocusTrap` — this is the largest dialog in the app and
  // the one where walking out of it into the view behind was easiest to do by accident.
  useFocusTrap(panelRef, open);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        data-tour="settings-panel"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("statusbar.settings")}
        // 1040 rather than the 880 it was: the nav takes 208 and the content its own padding, which
        // used to leave the API client's section about 430px once its rail was in — narrow enough
        // that a project URL showed a dozen characters and a truncation, which is the wrong end of
        // a value anyone is trying to check. `max-w-[92vw]` still gives way on a small screen.
        // The modal shape every dialog in the app shares: 14px corners and the modal shadow.
        className="flex h-[640px] max-h-[85vh] w-[1040px] max-w-[92vw] flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--cf-border)] pl-4 pr-3">
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--cf-text)]">
            {t("statusbar.settings")}
          </h2>
          {/* The search box, in the header rather than atop the nav.
              Fifteen sections and two dozen panes behind them is more than a list you scan —
              somebody looking for "where do I change the font" has no reason to guess whether that
              is Appearance, Editor or Terminal. See `settingsCatalog` for what it searches.

              It used to head the nav, where a folded rail had to stand in for it with a magnifier:
              a full row the size of a section, then the empty line kept for the group heading, so
              the first section began 60px down a column of 40px steps (user report). Up here it is
              out of the list in both states, the nav is the same list folded or not, and the field
              is always one click away. `data-no-initial-focus`: the dialog's first focus still goes
              to the close button — a field focused on every opening would wear its ring every
              time, in a header meant to stay quiet. */}
          <div className="relative w-[240px] min-w-0 shrink">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]"
            />
            <input
              ref={searchRef}
              data-no-initial-focus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (!searching) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((current) => Math.min(current + 1, hits.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((current) => Math.max(current - 1, 0));
                } else if (e.key === "Enter" && hits[cursor]) {
                  e.preventDefault();
                  pick(hits[cursor]);
                }
              }}
              placeholder={t("settings.searchPlaceholder")}
              aria-label={t("settings.searchPlaceholder")}
              // The 26px strip field: a header control, not a form.
              className={fieldClass({ size: "sm", className: "w-full pl-7 pr-8" })}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                aria-label={t("settings.searchClear")}
                // Inside the field, whose `pr-8` keeps the text clear of it.
                className={iconButtonClass({
                  size: "xs",
                  className: "absolute right-1 top-1/2 -translate-y-1/2",
                })}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <Tooltip label={t("common.close")} trailing={<Kbd>esc</Kbd>} side="bottom">
            <button
              type="button"
              onClick={closeSettings}
              aria-label={t("common.close")}
              className={iconButtonClass({ size: "sm" })}
            >
              <X size={15} />
            </button>
          </Tooltip>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {/* No `border-r`: the handle after this nav is the seam, and a border here doubled it.
              `cf-fold-zone` only while folded — the whole icon rail is the fold button's hover
              target, same as the projects sidebar's. See `index.css`. */}
          <nav
            style={{ width: railWidth }}
            // `py-3` and no horizontal padding: the horizontal padding lives on the two children
            // instead, so the folded rail is 50px of pure content and a 16px icon centres on 25
            // rather than in the middle of whatever the padding left over.
            //
            // Tinted half a step into the sunken tone, like every explorer beside a sheet: the nav
            // is where you pick, the pane beside it is the page.
            //
            // Nothing about the scrollbar is decided here — this element is `overflow-hidden` and
            // never scrolls. That is the scroller below, which says why it is painted as it is.
            className={`flex shrink-0 flex-col overflow-hidden bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))] py-3 ${
              folded ? "cf-fold-zone" : ""
            }`}
          >
            {/* "There is more this way." Folded, the rail has no scrollbar to say it, and on a short
                screen the list just stopped at the window's edge with sections still under it (user
                report). So an edge the list continues past fades out — `scrollEdgeMask`, on the
                scroller itself so it works on any theme — and carries a small arrow that moves the
                list on. Both only while there is something that way; a rail that fits shows neither. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Two different quiet scrollbars, because the two states have different problems —
                  both spelled out in `index.css`. Folded: no gutter at all, or its 10px would be a
                  fifth of the rail and would shove the centred icon off centre. Expanded: the gutter
                  stays (so nothing reflows) but nothing is painted in it until you hover or scroll,
                  because this edge is already the `ResizeHandle` seam and a resting hairline two
                  pixels from it read as one doubled line.

                  `overflow-y-scroll`, not `auto`, for the reason the content pane below gives in
                  full: a styled scrollbar is real layout, so a gutter that comes and goes moves every
                  row sideways — here, each time a search narrows the list past the pane's height and
                  back again. Free in the folded branch, where `cf-no-scrollbar` takes it to zero. */}
              <div
                ref={navScrollRef}
                style={{ maskImage: scrollEdgeMask(navEdges), WebkitMaskImage: scrollEdgeMask(navEdges) }}
                className={`min-h-0 flex-1 overflow-y-scroll ${
                  folded ? "cf-no-scrollbar px-0" : "cf-quiet-scroll px-3"
                }`}
              >
                {/* One wrapper, so `useScrollEdges` has a single child whose height is the list's. */}
                <div>
                  {searching ? (
                    <SearchResults hits={hits} cursor={cursor} query={query.trim()} onPick={pick} onHover={setCursor} />
                  ) : (
                    <>
                      {folded ? (
                        // The group headings are the one thing with no icon to fall back on. A rule in
                        // their place keeps the two groups visibly separate without inventing a glyph.
                        // 15px, the heading's own fixed line (`leading-[15px]`), so unfolding does not
                        // move a single icon down the rail.
                        <div className="mb-1 h-[15px]" />
                      ) : (
                        <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase leading-[15px] tracking-[0.06em] text-[var(--cf-text-faint)]">
                          {t("settings.globalGroup")}
                        </p>
                      )}
                      {globalSections.map((item) => (
                        <SectionButton
                          key={item.id}
                          id={item.id}
                          labelKey={item.labelKey}
                          icon={item.icon}
                          active={section === item.id}
                          collapsed={folded}
                          alpha={ALPHA_SECTIONS.has(item.id)}
                          onSelect={setSection}
                        />
                      ))}

                      {folded ? (
                        // `mx-[15px]` leaves a 20px rule centred in the 50px rail, matching the
                        // projects sidebar's folded separator (`mx-auto … w-5`). Without it the
                        // border runs edge to edge — the scroller is `px-0` here and has no gutter —
                        // and butts into the seam hairline, which reads as a divider *inside* one
                        // list rather than as the break between two groups.
                        <div className="mx-[15px] mb-1 mt-4 h-[15px] border-t border-[var(--cf-border)]" />
                      ) : (
                        <p className="mb-1 mt-4 break-words px-2.5 text-[11px] font-semibold uppercase leading-[15px] tracking-[0.06em] text-[var(--cf-text-faint)]">
                          {activeWorkspaceName
                            ? t("settings.workspaceGroup", { name: activeWorkspaceName })
                            : t("settings.workspaceGroupGeneric")}
                        </p>
                      )}
                      {workspaceSections.map((item) => (
                        <SectionButton
                          key={item.id}
                          id={item.id}
                          labelKey={item.labelKey}
                          icon={item.icon}
                          active={section === item.id}
                          collapsed={folded}
                          alpha={ALPHA_SECTIONS.has(item.id)}
                          onSelect={setSection}
                        />
                      ))}
                    </>
                  )}
                </div>
              </div>
              {navEdges.start && (
                <NavScrollCue direction="up" label={t("settings.navMoreAbove")} folded={folded} onClick={() => pageNav(-1)} />
              )}
              {navEdges.end && (
                <NavScrollCue direction="down" label={t("settings.navMoreBelow")} folded={folded} onClick={() => pageNav(1)} />
              )}
            </div>
          </nav>
          {/* Collapsed, there is nothing to drag: the rail is exactly one icon wide by definition,
              and leaving a live handle there would let someone drag it to a width the labels are
              still hidden at. The stored width is untouched, so expanding returns to it. */}
          {folded ? (
            // Same rail-that-points-at-its-button as the projects sidebar's — see `index.css`.
            <div className="cf-fold-zone cf-seam-collapsed w-px shrink-0 bg-[var(--cf-border)]" />
          ) : (
            <ResizeHandle
              axis="x"
              value={navWidth}
              min={NAV_MIN}
              max={NAV_MAX}
              onChange={(w) => setSize("settingsNavWidth", w)}
              onCommit={(w) => commitSize("settingsNavWidth", w)}
            />
          )}

          {/* The toggle rides the seam rather than sitting inside the nav, because inside it would
              be clipped by the nav's own overflow and would scroll away with the list.
              `z-20` because the handle it rides is `z-[15]`: at `z-10` the seam — and the accent
              glow it lights up under the pointer — painted straight across the middle of the
              button, and the handle's grab area took the clicks aimed at it.

              `top-6` and no `translate`: the pane beside it has `py-6`, and its heading is a 20px
              `text-sm` line — so 24px puts this 20px button exactly on that line rather than near
              it. That is the alignment worth keeping, and it is why this did not move when the
              search box arrived: on *this* side the button now sits beside the field rather than on
              a group heading, which looks like a reason to nudge it down and is not one. The
              clearance it needs from the field is bought by the clear button's `right-[24px]`
              instead. */}
          <Tooltip side="right" label={folded ? t("settings.expandNav") : t("settings.collapseNav")}>
            <button
              onClick={() => {
                if (folded) {
                  setCollapsed(false);
                  return;
                }
                // Folding while a search is showing drops the search too: the results need the room
                // the fold takes away, and a rail that stayed open over them would ignore the click.
                setCollapsed(true);
                setQuery("");
              }}
              aria-label={folded ? t("settings.expandNav") : t("settings.collapseNav")}
              aria-expanded={!folded}
              style={{ left: railWidth - 10 }}
              // Unconditional, and for the reason the sidebar's twin gives in full: the seam half
              // of `cf-fold-toggle` self-gates on `cf-fold-zone` being in the DOM, so all this adds
              // when unfolded is the button's own hover colour — which it was missing.
              className="cf-fold-toggle absolute top-6 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)] shadow-sm transition-colors"
            >
              {folded ? <ChevronsRight size={12} /> : <ChevronsLeft size={12} />}
            </button>
          </Tooltip>
          {/* `overflow-y-scroll`, not `auto`: the app styles its scrollbars, which makes them a
              real 10px of layout rather than an overlay. Letting one come and go as a section
              grows past the pane moved the centred column sideways on every switch — most visibly
              inside the API section, whose own sub-tabs straddle the height at which it appears.
              Reserving the gutter costs 10px of ~780 and keeps everything still; the track is
              transparent and the thumb isn't drawn when there is nothing to scroll, so a short
              section looks exactly as it did. */}
          <div data-settings-scroll className="flex-1 overflow-x-auto overflow-y-scroll px-7 py-6">
            {/* `h-full` for the sections that scroll their own pane: they pin a header and a rail
                and let only the pane beside it move, which needs a definite height to divide up. */}
            <div className={`w-full ${SELF_SCROLLING_SECTIONS.has(section) ? "h-full" : ""}`}>
              {section === "appearance" && <ThemeSettings />}
              {section === "general" && <GeneralSettings />}
              {section === "keybindings" && <ShortcutsSettings />}
              {section === "editor" && <EditorSettings />}
              {section === "projects" && <ProjectsSettings />}
              {section === "git" && <GitSettings />}
              {section === "terminal" && <TerminalSettings />}
              {section === "azure" && <GitHostingSettings />}
              {section === "claude" && <ClaudeSettings />}
              {section === "api" && <ApiSettingsBody />}
              {section === "remote" && <RemoteSettings />}
              {section === "vault" && <VaultSettings />}
              {section === "pipelines" && <PipelinesSettings />}
              {section === "notifications" && <NotificationSettings />}
              {section === "backup" && <BackupSettings />}
              {section === "review" && <ReviewSettings />}
              {section === "skills" && <SkillsSettings />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
