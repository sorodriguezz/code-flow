import { useMemo, useState } from "react";
import {
  Bot,
  KeyRound,
  Briefcase,
  ClipboardList,
  NotebookPen,
  Cloud,
  Database,
  ArrowDownToLine,
  ArrowUpFromLine,
  Download,
  RefreshCw,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Glasses,
  History,
  MessageCircle,
  MonitorSmartphone,
  Plus,
  Route,
  TerminalSquare,
  Workflow,
  Zap,
} from "lucide-react";
import { fetchNow, pullNow, pushNow } from "../../lib/gitActions";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useMissingProjectsStore } from "../../state/missingProjectsStore";
import { useWindowStore } from "../../state/windowStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore, type ApiWorkspace, type MainView, type PaletteScope } from "../../state/uiStore";
import { SETTINGS_SECTIONS } from "../../lib/settingsCatalog";
import { useTerminalStore } from "../../state/terminalStore";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

type PaletteGroup = "workspaces" | "projects" | "branches" | "views" | "actions" | "api" | "settings";

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
  all: ["workspaces", "projects", "branches", "views", "actions", "api", "settings"],
  workspaces: ["workspaces"],
  projects: ["projects"],
};

/**
 * Everywhere "go to…" can take you.
 *
 * Kept in step with the app rail on purpose: this list was missing Remote and Pipelines outright,
 * and folded the API tab's two workspaces into one row, so three of the eleven destinations could
 * only be reached with the mouse. `workspace` is how the two halves of the API tab get a row each —
 * the same field the rail uses, for the same reason.
 */
const VIEW_ITEMS: {
  id: MainView;
  labelKey: TranslationKey;
  icon: typeof GitBranch;
  workspace?: ApiWorkspace;
}[] = [
  { id: "graph", labelKey: "tabbar.graph", icon: History },
  { id: "changes", labelKey: "tabbar.changes", icon: GitBranch },
  { id: "editor", labelKey: "tabbar.editor", icon: FolderGit2 },
  // Conditional in the tab bar — it exists only on a repository linked to a host with CI — but
  // unconditional here: the palette is how you find out a screen exists, and a row that vanishes
  // depending on which repository is selected is one nobody learns.
  { id: "pipelines", labelKey: "tabbar.pipelines", icon: Route },
  { id: "api", workspace: "requests", labelKey: "tabbar.api", icon: Zap },
  { id: "api", workspace: "database", labelKey: "tabbar.databases", icon: Database },
  { id: "agents", labelKey: "tabbar.agents", icon: Bot },
  { id: "stories", labelKey: "tabbar.stories", icon: ClipboardList },
  { id: "remote", labelKey: "tabbar.remote", icon: MonitorSmartphone },
  { id: "notes", labelKey: "tabbar.notes", icon: NotebookPen },
  { id: "diagrams", labelKey: "tabbar.diagrams", icon: Workflow },
  { id: "vault", labelKey: "tabbar.vault", icon: KeyRound },
];

const GROUP_LABEL_KEY: Record<PaletteGroup, TranslationKey> = {
  workspaces: "sidebar.workspaces",
  projects: "sidebar.projects",
  branches: "sidebar.localBranches",
  views: "titlebar.goTo",
  actions: "titlebar.aiActions",
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
  const missing = useMissingProjectsStore((s) => s.missing);
  const notARepo = useMissingProjectsStore((s) => s.notARepo);
  // Repositories that are open in windows of their own. Left out for the same reason the
  // broken ones are: pressing Return here would select a repository this window has moved out,
  // and the row that *is* the way to that window is in the sidebar.
  const satellites = useWindowStore((s) => s.satellites);
  const branches = useRepoStore((s) => s.branches);
  const checkoutBranch = useRepoStore((s) => s.checkoutBranch);
  const checkoutRemoteBranch = useRepoStore((s) => s.checkoutRemoteBranch);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openSettings = useUiStore((s) => s.openSettings);
  const openSettingsAt = useUiStore((s) => s.openSettingsAt);
  const openApiWorkspace = useUiStore((s) => s.openApiWorkspace);
  const openApiModal = useApiModalStore((s) => s.openApiModal);
  const openPrLinkModal = useUiStore((s) => s.openPrLinkModal);
  const openCloneModal = useUiStore((s) => s.openCloneModal);
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

    // Repositories that cannot be opened — the folder gone, or the folder no longer a repository —
    // are left out rather than listed and refused: every entry in this palette is something that
    // happens when you press Return on it, and the sidebar has already taken "open" off these —
    // see `missingProjectsStore`. They are still in the sidebar and in Settings, which is where the
    // row that says why, and the buttons that repair or remove it, live.
    const projectItems: PaletteItem[] = projects
      .filter(
        (p) =>
          !missing.has(p.local_path) &&
          !notARepo.has(p.local_path) &&
          !satellites.some((s) => s.kind === "repo" && s.ref_id === p.id),
      )
      .map((p) => ({
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
      ...VIEW_ITEMS.map(({ id, labelKey, icon, workspace }) => ({
        key: `view:${id}:${workspace ?? ""}`,
        icon,
        label: t(labelKey),
        group: "views" as const,
        onSelect: () => (workspace ? openApiWorkspace(workspace) : setActiveView(id)),
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

    /**
     * Things to *do*, as opposed to places to go.
     *
     * This group held exactly one entry for a long time — review a PR from its link — which made a
     * "command palette" a navigator with one command in it. These are the actions that are worth
     * reaching without knowing where their button is: the three git verbs everyone runs all day,
     * and the two ways a repository gets into the app in the first place.
     *
     * Deliberately no destructive verbs. Discard, delete and force-push are one fuzzy match and a
     * Return away from each other in a list like this, and none of them should ever be reachable
     * that fast.
     */
    const actionItems: PaletteItem[] = [
      // Needs nothing but the link — no project open, no repository picked.
      {
        key: "action:pr-from-link",
        icon: Glasses,
        label: t("prLink.menuItem"),
        group: "actions",
        onSelect: () => openPrLinkModal(),
      },
      {
        key: "action:fetch",
        icon: RefreshCw,
        label: t("statusbar.fetch"),
        group: "actions",
        onSelect: () => fetchNow(),
      },
      {
        key: "action:pull",
        icon: ArrowDownToLine,
        label: t("statusbar.pull"),
        group: "actions",
        onSelect: () => pullNow(),
      },
      {
        key: "action:push",
        icon: ArrowUpFromLine,
        label: t("statusbar.push"),
        group: "actions",
        onSelect: () => pushNow(),
      },
      {
        key: "action:clone",
        icon: Download,
        label: t("sidebar.cloneRepo"),
        group: "actions",
        onSelect: () => openCloneModal(),
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

    /**
     * Every settings destination, panes included, straight from the catalog.
     *
     * It used to be a hand-written list of eleven ids that had drifted three behind the real nav —
     * Terminal, Remote and Backup were unreachable from here — and it had never known about the
     * sub-tabs at all, so "proxy" or "snippets" matched nothing. Reading the catalog means adding a
     * pane makes it findable here without anybody remembering to.
     */
    const settingsItems: PaletteItem[] = SETTINGS_SECTIONS.flatMap((section) => [
      {
        key: `settings:${section.id}`,
        icon: section.icon,
        label: t(section.labelKey),
        group: "settings" as const,
        onSelect: () => openSettings(section.id),
      },
      ...(section.tabs ?? []).map((tab) => ({
        key: `settings:${section.id}:${tab.id}`,
        icon: tab.icon,
        // Named with its section, because half these panes share a word with another one —
        // there is a "General" in the API client's settings and a "General" at the top level.
        label: `${t(section.labelKey)} › ${t(tab.labelKey)}`,
        group: "settings" as const,
        onSelect: () => openSettingsAt(section.id, tab.id),
      })),
    ]);

    return [
      ...workspaceItems,
      ...projectItems,
      ...branchItems,
      ...viewItems,
      ...actionItems,
      ...apiItems,
      ...settingsItems,
    ];
  }, [
    workspaces,
    projects,
    missing,
    notARepo,
    satellites,
    branches,
    t,
    setActiveWorkspace,
    setActiveProject,
    checkoutBranch,
    checkoutRemoteBranch,
    setActiveView,
    openSettings,
    openSettingsAt,
    openApiWorkspace,
    openApiModal,
    openPrLinkModal,
    openCloneModal,
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
