import { useMemo } from "react";
import { ChevronRight, Code2, FolderGit2, GitBranch, History, Layers, Route, type LucideIcon } from "lucide-react";
import { useUiStore, type MainView } from "../../state/uiStore";
import { useRepoStore } from "../../state/repoStore";
import { pipelinesAvailable, useVcsConnectionsStore } from "../../state/vcsConnectionsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { ActivePill } from "../common/ActivePill";
import { Kbd } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import { useShortcutChord } from "../../lib/useShortcutHint";
import { monogram, monogramStyle } from "../../lib/monogram";
import type { ShortcutId } from "../../lib/shortcuts";
import type { TranslationKey } from "../../lib/i18n/translations";
import { APPS } from "./AppRail";
import { setChromeSlot } from "./ChromeSlot";

interface Tab {
  id: MainView;
  labelKey: TranslationKey;
  icon: LucideIcon;
  shortcut: ShortcutId;
}

const TABS: Tab[] = [
  { id: "graph", labelKey: "tabbar.graph", icon: History, shortcut: "view.graph" },
  { id: "changes", labelKey: "tabbar.changes", icon: GitBranch, shortcut: "view.changes" },
  { id: "editor", labelKey: "tabbar.editor", icon: Code2, shortcut: "view.editor" },
];

const PIPELINES_TAB: Tab = { id: "pipelines", labelKey: "tabbar.pipelines", icon: Route, shortcut: "view.pipelines" };

const REPO_VIEWS: MainView[] = ["graph", "changes", "editor", "pipelines"];

/**
 * Staged + unstaged + untracked + conflicted, counted by path so a file that is both staged and
 * modified again counts once — the number a person would give if asked "how many files changed".
 */
function useUncommittedCount(): number {
  const status = useRepoStore((s) => s.status);
  return useMemo(() => {
    if (!status) return 0;
    const paths = new Set<string>();
    for (const list of [status.staged, status.unstaged, status.untracked, status.conflicted]) {
      for (const entry of list) paths.add(entry.path);
    }
    return paths.size;
  }, [status]);
}

function TabButton({ tab, active, badge }: { tab: Tab; active: boolean; badge?: number }) {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const t = useT();
  const chord = useShortcutChord();
  const Icon = tab.icon;
  const key = chord(tab.shortcut);

  return (
    <Tooltip label={t(tab.labelKey)} trailing={key ? <Kbd>{key}</Kbd> : undefined}>
      <button
        onClick={() => setActiveView(tab.id)}
        data-tour={`tab-${tab.id}`}
        aria-current={active ? "page" : undefined}
        className={`relative flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${
          active
            ? "text-[var(--cf-text)]"
            : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        }`}
      >
        {/* The same lifted sheet the active project and the active app wear: one way to say
            "selected" across the frame. */}
        {active && <ActivePill layoutId="cf-tab-pill" variant="raised" />}
        <span className="relative flex items-center gap-1.5">
          <Icon size={14} />
          {t(tab.labelKey)}
          {badge !== undefined && badge > 0 && (
            <span
              title={t("tabbar.uncommittedCount", { n: badge })}
              className="flex h-[17px] min-w-[18px] items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_16%,transparent)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--cf-warning)]"
            >
              {badge}
            </span>
          )}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * What the title row says about where you are.
 *
 * On a repository view: the repository (its monogram and name) and the tabs that follow it. On a
 * workspace app: the workspace and the app's name — and the app's own top-level controls, through
 * `ChromeSlot`. Before this, the tab bar stayed on screen with nothing selected while an app was
 * open, and the only thing saying which of the two scopes a screen followed was an icon with a
 * tooltip. Written out, "code-flow ›" and "CodeFlow › Cliente API" answer it at a glance; the
 * workspace crumb is also the way back to the graph, the same door the rail's workspace tile is.
 */
export function ChromeScope() {
  const activeView = useUiStore((s) => s.activeView);
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const project = useWorkspaceStore((s) => s.activeProject());
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null);
  const connections = useVcsConnectionsStore();
  const uncommitted = useUncommittedCount();
  const t = useT();

  if (REPO_VIEWS.includes(activeView)) {
    const tabs = pipelinesAvailable(project, connections) ? [...TABS, PIPELINES_TAB] : TABS;
    return (
      <div className="flex min-w-0 items-center gap-1">
        <Tooltip
          label={project ? t("tabbar.scopeRepositoryHint", { name: project.name }) : t("tabbar.scopeRepositoryNone")}
        >
          <span
            aria-label={t("tabbar.scopeRepository")}
            className="flex h-7 min-w-0 shrink-0 cursor-default select-none items-center gap-2 pl-0.5 pr-1 text-[13px] font-semibold text-[var(--cf-text)]"
          >
            {project ? (
              <span
                aria-hidden
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-[10.5px] font-bold tracking-[0.02em]"
                style={monogramStyle(project.color)}
              >
                {monogram(project.name)}
              </span>
            ) : (
              <FolderGit2 size={15} className="shrink-0 text-[var(--cf-text-muted)]" />
            )}
            <span className="max-w-[220px] truncate">{project?.name ?? t("tabbar.scopeRepository")}</span>
          </span>
        </Tooltip>
        <ChevronRight size={14} className="shrink-0 text-[var(--cf-text-faint)]" />
        <div data-tour="repo-tabs" className="flex min-w-0 items-center gap-0.5">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeView}
              badge={tab.id === "changes" ? uncommitted : undefined}
            />
          ))}
        </div>
      </div>
    );
  }

  const app = APPS.find((a) => a.id === activeView && (a.workspace === undefined || a.workspace === apiWorkspace));
  const color = workspace?.color ?? "var(--cf-accent)";
  const AppIcon = app?.icon;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tooltip
        label={workspace ? t("tabbar.scopeWorkspaceHint", { name: workspace.name }) : t("tabbar.scopeWorkspaceNone")}
        description={t("tabbar.scopeWorkspaceReset")}
      >
        <button
          onClick={() => setActiveView("graph")}
          className="flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md pl-1 pr-2 text-[13px] font-semibold text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
        >
          <span
            aria-hidden
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]"
            style={monogramStyle(color)}
          >
            <Layers size={12} />
          </span>
          <span className="max-w-[200px] truncate">{workspace?.name ?? t("tabbar.scopeWorkspace")}</span>
        </button>
      </Tooltip>
      <ChevronRight size={14} className="shrink-0 text-[var(--cf-text-faint)]" />
      {app && AppIcon && (
        <span className="flex h-7 shrink-0 items-center gap-2 px-1 text-[13px] font-semibold text-[var(--cf-text)]">
          <AppIcon size={15} className="text-[var(--cf-accent)]" />
          {t(app.labelKey)}
        </span>
      )}
      <span ref={setChromeSlot} className="ml-2 flex min-w-0 items-center gap-2" />
    </div>
  );
}
