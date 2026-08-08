import { useEffect } from "react";
import {
  Blocks,
  Bot,
  ChevronsLeft,
  ChevronsRight,
  DatabaseBackup,
  FolderGit2,
  GitBranch,
  Globe,
  Keyboard,
  PackagePlus,
  Palette,
  ShieldCheck,
  TerminalSquare,
  X,
  Zap,
} from "lucide-react";
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
import { ShortcutsSettings } from "./ShortcutsSettings";
import { ApiSettingsBody } from "../api/ApiSettingsPanel";
import { ActivePill } from "../common/ActivePill";
import { ResizeHandle } from "../common/ResizeHandle";
import { Tooltip } from "../common/Tooltip";
import { useLayoutStore } from "../../state/layoutStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore, type SettingsSectionId } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

const NAV_MIN = 160;
const NAV_COLLAPSED = 50;
const NAV_MAX = 320;

// Global settings apply across every workspace/project. Workspace settings — everything
// Claude reads when reviewing a PR (context, instructions, skills) — apply
// only to whichever workspace is currently active, per the user's explicit scoping model.
const GLOBAL_SECTIONS: { id: SettingsSectionId; labelKey: TranslationKey; icon: typeof Palette }[] = [
  { id: "general", labelKey: "settings.general", icon: Globe },
  { id: "appearance", labelKey: "settings.appearance", icon: Palette },
  { id: "keybindings", labelKey: "shortcuts.title", icon: Keyboard },
  { id: "projects", labelKey: "settings.projects", icon: FolderGit2 },
  { id: "git", labelKey: "settings.git", icon: GitBranch },
  { id: "terminal", labelKey: "settings.terminal", icon: TerminalSquare },
  { id: "azure", labelKey: "settings.integrationsSection", icon: Blocks },
  { id: "claude", labelKey: "settings.aiSection", icon: Bot },
  { id: "api", labelKey: "api.settings.title", icon: Zap },
  // Last of the global list on purpose: it is the section you visit twice — once to set it up, and
  // once on the day something went wrong — rather than one you pass through.
  { id: "backup", labelKey: "backup.title", icon: DatabaseBackup },
];

/** Sections that carry a sub-nav and scroll the pane beside it rather than the whole column, so
 * their heading and rail stay put while you read down a long list. They need a definite height to
 * do that, which is what the `h-full` below hands them. */
const SELF_SCROLLING_SECTIONS = new Set<SettingsSectionId>(["claude", "backup", "api"]);

const WORKSPACE_SECTIONS: { id: SettingsSectionId; labelKey: TranslationKey; icon: typeof Palette }[] = [
  { id: "review", labelKey: "settings.review", icon: ShieldCheck },
  { id: "skills", labelKey: "settings.skills", icon: PackagePlus },
];

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
  onSelect,
}: {
  id: SettingsSectionId;
  labelKey: TranslationKey;
  icon: typeof Palette;
  active: boolean;
  collapsed: boolean;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const t = useT();
  const label = t(labelKey);
  return (
    <button
      onClick={() => onSelect(id)}
      aria-current={active ? "page" : undefined}
      // Collapsed, the tooltip is the only place the name exists, so it stops being a courtesy.
      title={label}
      // Selection changes colour and nothing else — no weight change, exactly like the tabs.
      // Bolding on select re-measures the text (here: 140px → 143px against 141px of room), which
      // wrapped "Workspaces & projects" onto a second line and made the row jump every time it was
      // picked. Colour plus the pill is already the whole signal.
      className={`relative mb-0.5 flex w-full items-center rounded-md py-1.5 text-left text-[13px] transition-colors ${
        collapsed ? "justify-center px-0" : "px-2.5"
      } ${
        active
          ? "text-[var(--cf-accent)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
      }`}
    >
      {active && <ActivePill layoutId="cf-settings-pill" />}
      {/* Above the pill, which is absolutely positioned over the whole button. Truncating rather
          than wrapping keeps every row exactly one line tall at any nav width — the nav is
          resizable down to 160px, and a longer translation shouldn't be able to reflow it
          either. The full label is on the tooltip. */}
      <span className="relative flex min-w-0 items-center gap-1.5">
        <Icon size={14} className="shrink-0" />
        {!collapsed && <span className="truncate">{label}</span>}
      </span>
    </button>
  );
}

export function SettingsView() {
  const open = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.openSettings);
  const navWidth = useLayoutStore((s) => s.sizes.settingsNavWidth);
  const collapsed = useLayoutStore((s) => s.flags.settingsNavCollapsed);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const toggleFlag = useLayoutStore((s) => s.toggleFlag);
  // Collapsed the rail is exactly wide enough for a centred 14px icon inside the nav's own `p-3`.
  const railWidth = collapsed ? NAV_COLLAPSED : navWidth;
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWorkspaceName = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === activeWorkspaceId)?.name,
  );
  const t = useT();

  // Closable via Escape, but deliberately NOT by clicking the backdrop — settings can hold
  // unsaved in-progress input, and an accidental outside click shouldn't discard it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeSettings]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <div
        onClick={(e) => e.stopPropagation()}
        data-tour="settings-panel"
        // 1040 rather than the 880 it was: the nav takes 208 and the content its own padding, which
        // used to leave the API client's section about 430px once its rail was in — narrow enough
        // that a project URL showed a dozen characters and a truncation, which is the wrong end of
        // a value anyone is trying to check. `max-w-[92vw]` still gives way on a small screen.
        className="flex h-[640px] max-h-[85vh] w-[1040px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--cf-border)] px-4 py-2.5">
          <p className="text-[13px] font-semibold">{t("statusbar.settings")}</p>
          <button
            onClick={closeSettings}
            title={t("common.close")}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {/* No `border-r`: the handle after this nav is the seam, and a border here doubled it.
              `cf-fold-zone` only while folded — the whole icon rail is the fold button's hover
              target, same as the projects sidebar's. See `index.css`. */}
          <nav
            style={{ width: railWidth }}
            className={`shrink-0 overflow-y-auto p-3 ${collapsed ? "cf-fold-zone" : ""}`}
          >
            {collapsed ? (
              // The group headings are the one thing with no icon to fall back on. A rule in their
              // place keeps the two groups visibly separate without inventing a glyph for "Global".
              <div className="mb-1 h-[15px]" />
            ) : (
              <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {t("settings.globalGroup")}
              </p>
            )}
            {GLOBAL_SECTIONS.map((item) => (
              <SectionButton
                key={item.id}
                {...item}
                active={section === item.id}
                collapsed={collapsed}
                onSelect={setSection}
              />
            ))}

            {collapsed ? (
              <div className="mb-1 mt-4 h-[15px] border-t border-[var(--cf-border)]" />
            ) : (
              <p className="mb-1 mt-4 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {activeWorkspaceName
                  ? t("settings.workspaceGroup", { name: activeWorkspaceName })
                  : t("settings.workspaceGroupGeneric")}
              </p>
            )}
            {WORKSPACE_SECTIONS.map((item) => (
              <SectionButton
                key={item.id}
                {...item}
                active={section === item.id}
                collapsed={collapsed}
                onSelect={setSection}
              />
            ))}
          </nav>
          {/* Collapsed, there is nothing to drag: the rail is exactly one icon wide by definition,
              and leaving a live handle there would let someone drag it to a width the labels are
              still hidden at. The stored width is untouched, so expanding returns to it. */}
          {collapsed ? (
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
              be clipped by the nav's own `overflow-y-auto` and would scroll away with the list.
              `z-20` because the handle it rides is `z-[15]`: at `z-10` the seam — and the accent
              glow it lights up under the pointer — painted straight across the middle of the
              button, and the handle's grab area took the clicks aimed at it.

              At the top, level with the section heading — and here the projects sidebar's reasoning
              does *not* carry over, which is worth writing down because this button used to be
              centred precisely in order to match it.

              That argument was about the seam being where the hand already is: down the side of a
              long panel you grab the divider in the middle, so the fold control belongs there too.
              It holds for the sidebar, whose seam runs the full height of the window against a list
              that scrolls and is dragged. It does not hold here. This nav is a dozen fixed rows in a
              640px dialog — nothing scrolls, nothing is resized to reach anything — so the middle of
              its seam is not where anything happens, it is merely the middle. Level with the first
              heading it sits at the top of both columns at once, on the line the eye starts at.

              `top-6` and no `translate`: the pane beside it has `py-6`, and its heading is a 20px
              `text-sm` line — so 24px puts this 20px button exactly on that line rather than near
              it. */}
          <Tooltip side="right" label={collapsed ? t("settings.expandNav") : t("settings.collapseNav")}>
            <button
              onClick={() => toggleFlag("settingsNavCollapsed")}
              aria-label={collapsed ? t("settings.expandNav") : t("settings.collapseNav")}
              aria-expanded={!collapsed}
              style={{ left: railWidth - 10 }}
              className={`absolute top-6 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)] shadow-sm transition-colors hover:text-[var(--cf-text)] ${
                collapsed ? "cf-fold-toggle" : ""
              }`}
            >
              {collapsed ? <ChevronsRight size={12} /> : <ChevronsLeft size={12} />}
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
            {/* Full width, with no `max-w` and nothing centred.
                Sections used to be capped at 576px (or 768px for the four that carry a rail) and
                centred in a ~780px pane, which left a section like Git or Terminal as a narrow
                column floating in the middle with a hand's width of nothing either side, and made
                switching between a narrow section and a wide one shift every control sideways. The
                pane is already capped — the dialog is 1040px wide — so the only thing the cap was
                still doing was wasting the room. The `px-7` above is what keeps the content off the
                edges instead. */}
            {/* `h-full` for the sections that scroll their own pane: they pin a header and a rail
                and let only the pane beside it move, which needs a definite height to divide up.
                The outer container deliberately keeps `overflow-y-scroll` even for them — the
                reserved gutter is what stops content shifting sideways between sections, and a pane
                that fits exactly never draws a thumb here anyway. */}
            <div className={`w-full ${SELF_SCROLLING_SECTIONS.has(section) ? "h-full" : ""}`}>
              {section === "appearance" && <ThemeSettings />}
              {section === "general" && <GeneralSettings />}
              {section === "keybindings" && <ShortcutsSettings />}
              {section === "projects" && <ProjectsSettings />}
              {section === "git" && <GitSettings />}
              {section === "terminal" && <TerminalSettings />}
              {section === "azure" && <GitHostingSettings />}
              {section === "claude" && <ClaudeSettings />}
              {section === "api" && <ApiSettingsBody />}
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
