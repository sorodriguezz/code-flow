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
import { GeneralSettings } from "./GeneralSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { ApiSettingsBody } from "../api/ApiSettingsModal";
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
  { id: "azure", labelKey: "settings.gitHostingSection", icon: Cloud },
  { id: "claude", labelKey: "settings.aiSection", icon: Bot },
  { id: "api", labelKey: "api.settings.title", icon: Zap },
];

const WORKSPACE_SECTIONS: { id: SettingsSectionId; labelKey: TranslationKey; icon: typeof Palette }[] = [
  { id: "review", labelKey: "settings.review", icon: ShieldCheck },
  { id: "sdd", labelKey: "settings.sdd", icon: Workflow },
  { id: "skills", labelKey: "settings.skills", icon: PackagePlus },
  { id: "mcps", labelKey: "settings.mcps", icon: Plug },
];

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
        className="flex h-[640px] max-h-[85vh] w-[880px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
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
          <nav style={{ width: navWidth }} className="shrink-0 overflow-y-auto border-r border-[var(--cf-border)] p-3">
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("settings.globalGroup")}
            </p>
            {GLOBAL_SECTIONS.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                  section === id
                    ? "bg-[var(--cf-accent-soft)] font-medium text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <Icon size={14} />
                {t(labelKey)}
              </button>
            ))}

            <p className="mb-1 mt-4 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {activeWorkspaceName
                ? t("settings.workspaceGroup", { name: activeWorkspaceName })
                : t("settings.workspaceGroupGeneric")}
            </p>
            {WORKSPACE_SECTIONS.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                  section === id
                    ? "bg-[var(--cf-accent-soft)] font-medium text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <Icon size={14} />
                {t(labelKey)}
              </button>
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
          <div className="flex-1 overflow-auto p-6">
            <div className="mx-auto max-w-xl">
              {section === "appearance" && <ThemeSettings />}
              {section === "general" && <GeneralSettings />}
              {section === "keybindings" && <ShortcutsSettings />}
              {section === "projects" && <ProjectsSettings />}
              {section === "git" && <GitSettings />}
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
