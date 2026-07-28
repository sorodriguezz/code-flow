import { useMemo, useState } from "react";
import {
  Briefcase,
  Cloud,
  Cog,
  Download,
  FolderGit2,
  FolderPlus,
  GitBranch,
  History,
  MessageCircle,
  Plus,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore, type MainView, type PaletteScope, type SettingsSectionId } from "../../state/uiStore";
import { useTerminalStore } from "../../state/terminalStore";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

type PaletteGroup = "workspaces" | "projects" | "branches" | "views" | "api" | "settings";

interface PaletteItem {
  key: string;
  icon: typeof GitBranch;
  label: string;
  group: PaletteGroup;
  onSelect: () => void;
}

/** A scoped opening (from the "switch repository" / "switch workspace" / "switch branch"
 * shortcuts) narrows the palette to one group, so it acts as a dedicated picker. */
const SCOPE_GROUPS: Record<PaletteScope, PaletteGroup[]> = {
  all: ["workspaces", "projects", "branches", "views", "api", "settings"],
  workspaces: ["workspaces"],
  projects: ["projects"],
};

const VIEW_ITEMS: { id: MainView; labelKey: TranslationKey; icon: typeof GitBranch }[] = [
  { id: "graph", labelKey: "tabbar.graph", icon: History },
  { id: "changes", labelKey: "tabbar.changes", icon: GitBranch },
  { id: "editor", labelKey: "tabbar.editor", icon: FolderGit2 },
  { id: "api", labelKey: "api.title", icon: Zap },
];

const SETTINGS_ITEMS: { id: SettingsSectionId; labelKey: TranslationKey }[] = [
  { id: "appearance", labelKey: "settings.appearance" },
  { id: "general", labelKey: "settings.general" },
  { id: "keybindings", labelKey: "shortcuts.title" },
  { id: "projects", labelKey: "settings.projects" },
  { id: "git", labelKey: "settings.git" },
  { id: "azure", labelKey: "settings.gitHostingSection" },
  { id: "claude", labelKey: "settings.aiSection" },
  { id: "review", labelKey: "settings.review" },
  { id: "sdd", labelKey: "settings.sdd" },
  { id: "skills", labelKey: "settings.skills" },
  { id: "mcps", labelKey: "settings.mcps" },
  { id: "api", labelKey: "api.settings.title" },
];

const GROUP_LABEL_KEY: Record<PaletteGroup, TranslationKey> = {
  workspaces: "sidebar.workspaces",
  projects: "sidebar.projects",
  branches: "sidebar.localBranches",
  views: "titlebar.goTo",
  api: "api.title",
  settings: "statusbar.settings",
};

export function CommandPalette({ scope = "all", onClose }: { scope?: PaletteScope; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
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
  const openApiModal = useApiModalStore((s) => s.openApiModal);
  const toggleAiPanel = useUiStore((s) => s.toggleAiPanel);
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);

  const items = useMemo<PaletteItem[]>(() => {
    const workspaceItems: PaletteItem[] = workspaces.map((w) => ({
      key: `workspace:${w.id}`,
      icon: Briefcase,
      label: w.name,
      group: "workspaces",
      onSelect: () => setActiveWorkspace(w.id),
    }));

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

    // The API client is app-global, so these work with no project open — but each one has to
    // switch to the view as well, because `ApiView` is what mounts the tab strip and the modals.
    const openApi = (then?: () => void) => {
      setActiveView("api");
      void ensureApiStoreLoaded().then(() => then?.());
    };

    const apiItems: PaletteItem[] = [
      {
        key: "api:new-request",
        icon: Plus,
        label: t("api.newRequest"),
        group: "api",
        onSelect: () => openApi(() => useApiStore.getState().openScratchTab()),
      },
      {
        key: "api:new-collection",
        icon: FolderPlus,
        label: t("api.newCollection"),
        group: "api",
        onSelect: () =>
          openApi(() => void useApiStore.getState().createCollection(t("api.untitledCollection"))),
      },
      {
        key: "api:import",
        icon: Download,
        label: t("api.import.title"),
        group: "api",
        onSelect: () => openApi(() => openApiModal({ kind: "import" })),
      },
    ];

    const settingsItems: PaletteItem[] = SETTINGS_ITEMS.map(({ id, labelKey }) => ({
      key: `settings:${id}`,
      icon: Cog,
      label: t(labelKey),
      group: "settings",
      onSelect: () => openSettings(id),
    }));

    return [
      ...workspaceItems,
      ...projectItems,
      ...branchItems,
      ...viewItems,
      ...apiItems,
      ...settingsItems,
    ];
  }, [
    workspaces,
    projects,
    branches,
    t,
    setActiveWorkspace,
    setActiveProject,
    checkoutBranch,
    checkoutRemoteBranch,
    setActiveView,
    openSettings,
    openApiModal,
    toggleAiPanel,
    toggleTerminalPanel,
  ]);

  const groups = SCOPE_GROUPS[scope];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inScope = items.filter((item) => groups.includes(item.group));
    if (!q) return inScope;
    return inScope.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, groups, query]);

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
            placeholder={scope === "all" ? t("titlebar.searchPlaceholder") : t(GROUP_LABEL_KEY[groups[0]])}
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
