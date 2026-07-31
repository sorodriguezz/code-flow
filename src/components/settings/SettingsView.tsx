import { useEffect } from "react";
import {
  Bot,
  Cloud,
  FolderGit2,
  GitBranch,
  Globe,
  Keyboard,
  PackagePlus,
  Palette,
  Plug,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { ThemeSettings } from "./ThemeSettings";
import { ProjectsSettings } from "./ProjectsSettings";
import { GitHostingSettings } from "./GitHostingSettings";
import { ClaudeSettings } from "./ClaudeSettings";
import { ReviewSettings } from "./ReviewSettings";
import { SddSettings } from "./SddSettings";
import { SkillsSettings } from "./SkillsSettings";
import { McpSettings } from "./McpSettings";
import { GitSettings } from "./GitSettings";
import { TerminalSettings } from "./TerminalSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { ApiSettingsBody } from "../api/ApiSettingsPanel";
import { ActivePill } from "../common/ActivePill";
import { ResizeHandle } from "../common/ResizeHandle";
import { useLayoutStore } from "../../state/layoutStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore, type SettingsSectionId } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

const NAV_MIN = 160;
const NAV_MAX = 320;

// Global settings apply across every workspace/project. Workspace settings — everything
// Claude reads when reviewing a PR (context, instructions, skills, MCP servers) — apply
// only to whichever workspace is currently active, per the user's explicit scoping model.
const GLOBAL_SECTIONS: { id: SettingsSectionId; labelKey: TranslationKey; icon: typeof Palette }[] = [
  { id: "general", labelKey: "settings.general", icon: Globe },
  { id: "appearance", labelKey: "settings.appearance", icon: Palette },
  { id: "keybindings", labelKey: "shortcuts.title", icon: Keyboard },
  { id: "projects", labelKey: "settings.projects", icon: FolderGit2 },
  { id: "git", labelKey: "settings.git", icon: GitBranch },
  { id: "terminal", labelKey: "settings.terminal", icon: TerminalSquare },
  { id: "azure", labelKey: "settings.gitHostingSection", icon: Cloud },
  { id: "claude", labelKey: "settings.aiSection", icon: Bot },
  { id: "api", labelKey: "api.settings.title", icon: Zap },
];

// Sections whose body carries a side rail of its own, and so needs the wider content column.
const WIDE_SECTIONS = new Set<SettingsSectionId>(["azure", "claude", "api"]);

/** Sections that carry a sub-nav and scroll the pane beside it rather than the whole column, so
 * their heading and rail stay put while you read down a long list. They need a definite height to
 * do that, which is what the `h-full` below hands them. */
const SELF_SCROLLING_SECTIONS = new Set<SettingsSectionId>(["claude"]);

const WORKSPACE_SECTIONS: { id: SettingsSectionId; labelKey: TranslationKey; icon: typeof Palette }[] = [
  { id: "review", labelKey: "settings.review", icon: ShieldCheck },
  { id: "sdd", labelKey: "settings.sdd", icon: Workflow },
  { id: "skills", labelKey: "settings.skills", icon: PackagePlus },
  { id: "mcps", labelKey: "settings.mcps", icon: Plug },
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
  onSelect,
}: {
  id: SettingsSectionId;
  labelKey: TranslationKey;
  icon: typeof Palette;
  active: boolean;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const t = useT();
  const label = t(labelKey);
  return (
    <button
      onClick={() => onSelect(id)}
      aria-current={active ? "page" : undefined}
      title={label}
      // Selection changes colour and nothing else — no weight change, exactly like the tabs.
      // Bolding on select re-measures the text (here: 140px → 143px against 141px of room), which
      // wrapped "Workspaces & projects" onto a second line and made the row jump every time it was
      // picked. Colour plus the pill is already the whole signal.
      className={`relative mb-0.5 flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
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
        <span className="truncate">{label}</span>
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
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
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

        <div className="flex min-h-0 flex-1">
          {/* No `border-r`: the handle after this nav is the seam, and a border here doubled it. */}
          <nav style={{ width: navWidth }} className="shrink-0 overflow-y-auto p-3">
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("settings.globalGroup")}
            </p>
            {GLOBAL_SECTIONS.map((item) => (
              <SectionButton key={item.id} {...item} active={section === item.id} onSelect={setSection} />
            ))}

            <p className="mb-1 mt-4 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {activeWorkspaceName
                ? t("settings.workspaceGroup", { name: activeWorkspaceName })
                : t("settings.workspaceGroupGeneric")}
            </p>
            {WORKSPACE_SECTIONS.map((item) => (
              <SectionButton key={item.id} {...item} active={section === item.id} onSelect={setSection} />
            ))}
          </nav>
          <ResizeHandle
            axis="x"
            value={navWidth}
            min={NAV_MIN}
            max={NAV_MAX}
            onChange={(w) => setSize("settingsNavWidth", w)}
            onCommit={(w) => commitSize("settingsNavWidth", w)}
          />
          {/* `overflow-y-scroll`, not `auto`: the app styles its scrollbars, which makes them a
              real 10px of layout rather than an overlay. Letting one come and go as a section
              grows past the pane moved the centred column sideways on every switch — most visibly
              inside the API section, whose own sub-tabs straddle the height at which it appears.
              Reserving the gutter costs 10px of ~780 and keeps everything still; the track is
              transparent and the thumb isn't drawn when there is nothing to scroll, so a short
              section looks exactly as it did. */}
          <div data-settings-scroll className="flex-1 overflow-x-auto overflow-y-scroll p-6">
            {/* Wider for the two sections that carry a nav of their own: 168px of rail out of 576
                would leave their forms in a column narrower than the labels they carry. */}
            {/* `h-full` for the sections that scroll their own pane: they pin a header and a rail
                and let only the pane beside it move, which needs a definite height to divide up.
                The outer container deliberately keeps `overflow-y-scroll` even for them — the
                reserved gutter above is what stops the centred column shifting sideways between
                sections, and a pane that fits exactly never draws a thumb here anyway. */}
            <div
              className={`mx-auto ${WIDE_SECTIONS.has(section) ? "max-w-3xl" : "max-w-xl"} ${
                SELF_SCROLLING_SECTIONS.has(section) ? "h-full" : ""
              }`}
            >
              {section === "appearance" && <ThemeSettings />}
              {section === "general" && <GeneralSettings />}
              {section === "keybindings" && <ShortcutsSettings />}
              {section === "projects" && <ProjectsSettings />}
              {section === "git" && <GitSettings />}
              {section === "terminal" && <TerminalSettings />}
              {section === "azure" && <GitHostingSettings />}
              {section === "claude" && <ClaudeSettings />}
              {section === "api" && <ApiSettingsBody />}
              {section === "review" && <ReviewSettings />}
              {section === "sdd" && <SddSettings />}
              {section === "skills" && <SkillsSettings />}
              {section === "mcps" && <McpSettings />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
