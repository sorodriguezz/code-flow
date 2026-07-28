import { useMemo } from "react";
import { Code2, FolderGit2, GitBranch, History, type LucideIcon } from "lucide-react";
import { useUiStore, type MainView } from "../../state/uiStore";
import { useRepoStore } from "../../state/repoStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { ActivePill } from "../common/ActivePill";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * Everything in this strip follows the **selected repository** — click a different repo and all
 * three reload. That is the whole reason the API client isn't here: its collections belong to the
 * workspace and deliberately don't change with the repo, and a tab sitting alongside these would
 * imply it did. It lives in `WorkspaceMenu` at the other end of the bar instead, so the two
 * scopes never look like one list.
 */
interface Tab {
  id: MainView;
  labelKey: TranslationKey;
  icon: LucideIcon;
}

const TABS: Tab[] = [
  { id: "graph", labelKey: "tabbar.graph", icon: History },
  { id: "changes", labelKey: "tabbar.changes", icon: GitBranch },
  { id: "editor", labelKey: "tabbar.editor", icon: Code2 },
];

/** Uncommitted files, counted once per path: a partially staged file appears in both `staged`
 * and `unstaged` but is still a single pending change. */
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

/**
 * The end-cap marking what these tabs follow: an icon alone, with the explanation on hover.
 *
 * Icon-only because the words are only needed once — after the first hover the icon is reminder
 * enough, and a permanent "REPOSITORY" caption costs bar width on every render to say something
 * the user already knows. That does make the tooltip the only place the scope is spelled out, so
 * it carries the whole sentence rather than just the name; the label survives as the `aria-label`,
 * since an icon with no text is nothing to a screen reader.
 */
function ScopeMarker({ icon: Icon, label, hint }: { icon: LucideIcon; label: string; hint: string }) {
  return (
    <span
      title={hint}
      aria-label={label}
      className="flex shrink-0 cursor-default select-none items-center text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
    >
      <Icon size={13} />
    </span>
  );
}

function TabButton({ tab, active, badge }: { tab: Tab; active: boolean; badge?: number }) {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const t = useT();
  const Icon = tab.icon;

  return (
    <button
      onClick={() => setActiveView(tab.id)}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors ${
        active
          ? "text-[var(--cf-accent)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
      }`}
    >
      {/* Same radius, fill and accent-tinted hairline as the workspace trigger at the other end
          of the bar, so both read as one control family. */}
      {active && <ActivePill layoutId="cf-tab-pill" />}
      {/* Above the pill, which is absolutely positioned over the whole button. */}
      <span className="relative flex items-center gap-1.5">
        <Icon size={14} />
        {t(tab.labelKey)}
        {badge !== undefined && badge > 0 && (
          <span
            title={t("tabbar.uncommittedCount", { n: badge })}
            className={`text-[12px] tabular-nums ${active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"}`}
          >
            ({badge})
          </span>
        )}
      </span>
    </button>
  );
}

export function TabBar() {
  const activeView = useUiStore((s) => s.activeView);
  const uncommitted = useUncommittedCount();
  const project = useWorkspaceStore((s) => s.activeProject());
  const t = useT();

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3">
      <ScopeMarker
        icon={FolderGit2}
        label={t("tabbar.scopeRepository")}
        hint={
          project
            ? t("tabbar.scopeRepositoryHint", { name: project.name })
            : t("tabbar.scopeRepositoryNone")
        }
      />
      <div className="flex min-w-0 items-center gap-1">
        {TABS.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeView}
            badge={tab.id === "changes" ? uncommitted : undefined}
          />
        ))}
      </div>

      <div className="ml-auto flex shrink-0 items-center">
        <WorkspaceMenu />
      </div>
    </div>
  );
}
