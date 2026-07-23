import { useMemo, useState } from "react";
import { Cloud, Cog, FolderGit2, GitBranch, History, MessageCircle, TerminalSquare } from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore, type MainView, type SettingsSectionId } from "../../state/uiStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

interface PaletteItem {
  key: string;
  icon: typeof GitBranch;
  label: string;
  group: "projects" | "branches" | "views" | "settings";
  onSelect: () => void;
}

const VIEW_ITEMS: { id: MainView; labelKey: TranslationKey; icon: typeof GitBranch }[] = [
  { id: "graph", labelKey: "tabbar.graph", icon: History },
  { id: "changes", labelKey: "tabbar.changes", icon: GitBranch },
  { id: "editor", labelKey: "tabbar.editor", icon: FolderGit2 },
];

const SETTINGS_ITEMS: { id: SettingsSectionId; labelKey: TranslationKey }[] = [
  { id: "appearance", labelKey: "settings.appearance" },
  { id: "general", labelKey: "settings.general" },
  { id: "projects", labelKey: "settings.projects" },
  { id: "git", labelKey: "settings.git" },
  { id: "azure", labelKey: "settings.gitHostingSection" },
  { id: "claude", labelKey: "settings.aiSection" },
  { id: "context", labelKey: "settings.context" },
  { id: "mdFiles", labelKey: "settings.mdFiles" },
  { id: "skills", labelKey: "settings.skills" },
  { id: "mcps", labelKey: "settings.mcps" },
];

const GROUP_LABEL_KEY: Record<PaletteItem["group"], TranslationKey> = {
  projects: "sidebar.projects",
  branches: "sidebar.localBranches",
  views: "titlebar.goTo",
  settings: "statusbar.settings",
};

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Selecting the raw (stably-referenced) map and only applying the `?? []` fallback in the
  // render body — not inside the selector — avoids handing useSyncExternalStore a brand-new
  // array on every store update, which previously caused a real infinite-render loop elsewhere
  // in this app (see prStore's EMPTY_PRS fix).
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const projects = activeWorkspaceId ? projectsByWorkspace[activeWorkspaceId] ?? [] : [];
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const branches = useRepoStore((s) => s.branches);
  const checkoutBranch = useRepoStore((s) => s.checkoutBranch);
  const checkoutRemoteBranch = useRepoStore((s) => s.checkoutRemoteBranch);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openSettings = useUiStore((s) => s.openSettings);
  const toggleAiPanel = useUiStore((s) => s.toggleAiPanel);
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);

  const items = useMemo<PaletteItem[]>(() => {
    const projectItems: PaletteItem[] = projects.map((p) => ({
      key: `project:${p.id}`,
      icon: FolderGit2,
      label: p.name,
      group: "projects",
      onSelect: () => setActiveProject(p.id),
    }));

    const branchItems: PaletteItem[] = branches.map((b) => ({
      key: `branch:${b.name}`,
      icon: b.is_remote ? Cloud : GitBranch,
      label: b.name,
      group: "branches",
      onSelect: () => (b.is_remote ? checkoutRemoteBranch(b.name) : checkoutBranch(b.name)),
    }));

    const viewItems: PaletteItem[] = [
      ...VIEW_ITEMS.map(({ id, labelKey, icon }) => ({
        key: `view:${id}`,
        icon,
        label: t(labelKey),
        group: "views" as const,
        onSelect: () => setActiveView(id),
      })),
      {
        key: "view:ai-panel",
        icon: MessageCircle,
        label: t("chat.title"),
        group: "views" as const,
        onSelect: () => toggleAiPanel(),
      },
      {
        key: "view:terminal",
        icon: TerminalSquare,
        label: t("tabbar.terminal"),
        group: "views" as const,
        onSelect: () => toggleTerminalPanel(),
      },
    ];

    const settingsItems: PaletteItem[] = SETTINGS_ITEMS.map(({ id, labelKey }) => ({
      key: `settings:${id}`,
      icon: Cog,
      label: t(labelKey),
      group: "settings",
      onSelect: () => openSettings(id),
    }));

    return [...projectItems, ...branchItems, ...viewItems, ...settingsItems];
  }, [
    projects,
    branches,
    t,
    setActiveProject,
    checkoutBranch,
    checkoutRemoteBranch,
    setActiveView,
    openSettings,
    toggleAiPanel,
    toggleTerminalPanel,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  const groups: PaletteItem["group"][] = ["projects", "branches", "views", "settings"];

  const choose = (item: PaletteItem) => {
    item.onSelect();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[60vh] w-[420px] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && filtered[0]) choose(filtered[0]);
            }}
            placeholder={t("titlebar.searchPlaceholder")}
            className="flex-1 bg-transparent text-[13px] outline-none"
          />
        </div>

        <div className="flex-1 overflow-auto p-1.5">
          {groups.map((group) => {
            const groupItems = filtered.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            return (
              <div key={group} className="mb-1">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">
                  {t(GROUP_LABEL_KEY[group])}
                </p>
                {groupItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      onClick={() => choose(item)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    >
                      <Icon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="px-2 py-3 text-center text-[12px] text-[var(--cf-text-muted)]">{t("titlebar.noResults")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
