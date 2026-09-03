import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CircleCheck,
  CircleHelp,
  Copy,
  Folder,
  GitCompare,
  Link2,
  ListChecks,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Square,
  TerminalSquare,
  Trash2,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { AGENT_STATUS, STATUS_ORDER } from "./agentStatus";
import { ContinueWithModal } from "./ContinueWithModal";
import { TaskTree } from "./TaskTree";
import { RenameRow, Row, menuBlocks, type RowMenu } from "./TreeRow";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { CARD } from "../api/panelChrome";
import { relativeTime } from "../api/settingsChrome";
import { ToolbarButton } from "../db/dbChrome";
import { ActivePill } from "../common/ActivePill";
import { EmptyState } from "../common/EmptyState";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useAgentsStore, type TaskGrouping } from "../../state/agentsStore";
import { benchTabLabel, terminalsOfTab, useBenchStore } from "../../state/benchStore";
import { useChainStore } from "../../state/chainStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { AgentProject, AgentTask } from "../../types/domain";
import type { TranslationKey } from "../../lib/i18n/translations";

const GROUPINGS: { id: TaskGrouping; labelKey: TranslationKey }[] = [
  { id: "tree", labelKey: "agents.groupTree" },
  { id: "status", labelKey: "agents.groupStatus" },
  { id: "templates", labelKey: "agents.sectionTemplates" },
];

interface Group {
  key: string;
  label: string;
  tasks: AgentTask[];
}

/**
 * The task list — the console's index of work in progress.
 *
 * Grouped rather than flat, and grouped three ways, because the question you bring to it changes.
 * **Tasks** is the arrangement the user made themselves: folders, the rows they pinned, and every
 * chain drawn as the group of tasks it actually is. The other two cut straight across that — by
 * status to find what is waiting on you, by agent to find what the reviewer has been up to — and
 * they stay deliberately flat, because a cut across the filing is only useful if it ignores it.
 *
 * The grouping is view state and not persisted: it follows the question, not the workspace.
 */
export function AgentTaskList({
  width,
  onNewTask,
  onNewChain,
  onNewStory,
  onNewAgent,
  onNewProject,
  onEditProject,
  onUseTemplate,
  onHelp,
}: {
  width: number;
  /** The folder to file the new row under — `""` for none. */
  onNewTask: (agentProjectId: string) => void;
  onNewChain: (agentProjectId: string) => void;
  onNewStory: (agentProjectId: string) => void;
  onNewAgent: () => void;
  onNewProject: () => void;
  onEditProject: (project: AgentProject) => void;
  onUseTemplate: (templateId: string) => void;
  onHelp: () => void;
}) {
  const t = useT();
  const tasks = useAgentsStore((s) => s.tasks);
  const roster = useAgentsStore((s) => s.roster);
  const live = useAgentsStore((s) => s.live);
  const loading = useAgentsStore((s) => s.loading);
  const groupBy = useAgentsStore((s) => s.groupBy);
  const query = useAgentsStore((s) => s.query);
  const selectedId = useAgentsStore((s) => s.selectedId);
  const rosterOpen = useAgentsStore((s) => s.rosterOpen);
  const setGroupBy = useAgentsStore((s) => s.setGroupBy);
  const setQuery = useAgentsStore((s) => s.setQuery);
  const toggleRoster = useAgentsStore((s) => s.toggleRoster);
  const benchOpen = useBenchStore((s) => s.open);
  const benchTabs = useBenchStore((s) => s.tabs);
  const benchTerminals = useBenchStore((s) => s.terminals);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Toggling *reloads* on the way open rather than just flipping a flag, and that is the point of
  // the bench: shells that were running behind a closed panel — or that died when the app last
  // quit — have to be found again, not assumed. See `benchStore`.
  const toggleBench = () => {
    const bench = useBenchStore.getState();
    if (bench.open) bench.hide();
    else if (workspaceId) void bench.show(workspaceId).catch((e: unknown) => pushErrorToast(String(e)));
  };
  const chains = useChainStore((s) => s.chains);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const focusProject = useWorkspaceStore((s) => s.focusProject);

  const [menu, setMenu] = useState<RowMenu | null>(null);
  /** The row being renamed in place, if any. Only the flat groupings use this — the tree keeps its
   * own, because it renames three kinds of row and this one only ever renames a task. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [continuing, setContinuing] = useState<string | null>(null);
  /** The right-clicked bench tab and where its menu goes. The same two actions its tab in the panel
   *  offers — these rows *are* those tabs, and a row that answers differently from the thing it
   *  stands for is a row you stop trusting. */
  const [benchMenu, setBenchMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  // The menu portals to `document.body`, and this view is hidden rather than unmounted — left
  // open, it would float over whatever the user switched to.
  useEffect(() => {
    if (activeView !== "agents") setMenu(null);
  }, [activeView]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter(
      (task) =>
        task.title.toLowerCase().includes(needle) ||
        task.goal.toLowerCase().includes(needle) ||
        task.agent_name.toLowerCase().includes(needle),
    );
  }, [tasks, query]);

  const groups = useMemo<Group[]>(() => {
    if (groupBy === "status") {
      return STATUS_ORDER.map((status) => ({
        key: status,
        label: t(AGENT_STATUS[status].labelKey),
        tasks: filtered.filter((task) => task.status === status),
      })).filter((group) => group.tasks.length > 0);
    }
    return [];
  }, [filtered, groupBy, t]);

  // Looked up rather than remembered, so a row deleted from elsewhere takes its menu with it.
  const menuTask = menu ? (tasks.find((candidate) => candidate.id === menu.id) ?? null) : null;

  const taskMenuItems = (task: AgentTask): MenuItem[] => {
    const running = live[task.id]?.sending ?? false;
    const done = task.status === "done";
    const store = () => useAgentsStore.getState();

    return menuBlocks(
      [
        {
          label: t(task.pinned ? "agents.unpin" : "agents.pin"),
          icon: task.pinned ? PinOff : Pin,
          onClick: () => void store().setTaskPinned(task.id, !task.pinned),
        },
      ],
      [
        { label: t("agents.rename"), icon: Pencil, onClick: () => setRenamingId(task.id) },
        {
          label: t(done ? "agents.reopen" : "agents.markDone"),
          icon: done ? RotateCcw : CircleCheck,
          onClick: () => void store().setStatus(task.id, done ? "idle" : "done"),
        },
        // Only while there is something to stop — an engine is editing that working copy, and this
        // is the one action in the menu that cannot wait for the task to be opened first.
        ...(running ? [{ label: t("ai.stop"), icon: Square, onClick: () => void store().stop(task.id) }] : []),
      ],
      [
        // Nothing to hand on until it has answered once, and a chain seeded with an empty handoff
        // is the one shape that feature refuses to produce.
        ...(task.turns > 0
          ? [{ label: t("agents.continueWith"), icon: Link2, onClick: () => setContinuing(task.id) }]
          : []),
        {
          label: t("agents.openChanges"),
          icon: GitCompare,
          onClick: () => {
            void focusProject(task.workspace_id, task.project_id).then(() => setActiveView("changes"));
          },
        },
        {
          label: t("agents.copyGoal"),
          icon: Copy,
          onClick: () => void navigator.clipboard.writeText(task.goal).catch((e) => pushErrorToast(String(e))),
        },
      ],
      [
        {
          label: t("agents.deleteTask"),
          icon: Trash2,
          danger: true,
          onClick: () => {
            void confirmAction(t("agents.deleteConfirm", { name: task.title })).then((ok) => {
              if (ok) void store().remove(task.id);
            });
          },
        },
      ],
    );
  };

  // A workspace with a chain and no standalone task is not empty: the chain's own steps are tasks,
  // and the tree has plenty to draw. Asking `tasks` alone put the "nothing here yet" call to action
  // over a list that was about to fill in.
  const nothingYet = tasks.length === 0 && chains.length === 0;

  return (
    <div
      data-tour="agents-tree"
      style={{ width }}
      className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden ${CARD}`}
    >
      <div
        data-tour="agents-tree-actions"
        className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1"
      >
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("agents.tasks")}
        </span>
        <ToolbarButton onClick={() => onNewTask("")} title={t("agents.newTask")}>
          <Plus size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={() => onNewChain("")} title={t("agents.newChain")}>
          <Link2 size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={() => onNewStory("")} title={t("agents.newStory")}>
          <Wand2 size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={onNewProject} title={t("agents.newProject")}>
          <Folder size={13} />
        </ToolbarButton>
        {/* The terminal bench, between the folders and the roster — which is where it belongs in
            the reading of this toolbar rather than merely where it fits. Everything to the left
            creates work for an agent to do; the roster to the right is who does it. This is the
            one that hands the machine back to the user: whatever CLI they want, driven by hand,
            in the same workspace. Active while the panel is up, like the roster's own button. */}
        <ToolbarButton onClick={toggleBench} active={benchOpen} title={t("bench.title")}>
          <TerminalSquare size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={toggleRoster} active={rosterOpen} title={t("agents.manageAgents")}>
          <Users size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={onHelp} title={t("agents.help")}>
          <CircleHelp size={13} />
        </ToolbarButton>
      </div>

      <div className="flex shrink-0 gap-0.5 px-1.5 pt-1.5">
        {GROUPINGS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setGroupBy(entry.id)}
            title={t(entry.labelKey)}
            className={`relative min-w-0 flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium ${
              groupBy === entry.id
                ? "text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            }`}
          >
            {groupBy === entry.id && <ActivePill layoutId="cf-agents-section-pill" />}
            <span className="relative block truncate">{t(entry.labelKey)}</span>
          </button>
        ))}
      </div>

      <div className="relative shrink-0 px-1.5 py-1.5">
        <Search
          size={12}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("agents.searchPlaceholder")}
          className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] py-1 pl-6 pr-6 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            title={t("api.clearSearch")}
            aria-label={t("api.clearSearch")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* The bench, from the outside — above the body and outside every branch of it.
          It started inside `TaskTree` and that was wrong twice over. `nothingYet` counts tasks and
          chains, so a workspace whose only work was two running shells replaced the whole tree with
          "no tasks yet" and the bench vanished from the one place that was supposed to prove it was
          still there. And the tree is only one of three groupings, so switching to "Estado" lost it
          again. Neither is a fact about terminals: they belong to the workspace, not to a way of
          grouping its tasks.

          **Tabs, not terminals.** This listed every shell individually and that was a second list
          of the same things the panel's own tab strip already lists, disagreeing with it as soon as
          a tab held more than one — three rows here for what is two tabs there. One row per tab
          with a count says the same thing in the same shape as the panel, and the count is the part
          that was actually missing: how many shells are behind a tab is exactly what a strip of
          tabs cannot show you.

          Drawn only when there is something on it, on the same rule the pinned section follows: a
          permanent empty heading advertises a feature rather than listing anything. */}
      {benchTabs.length > 0 && (
        // Capped and scrolled rather than left to grow: this sits above the task list in the fixed
        // part of the panel, so eight tabs would push the work itself off the bottom.
        <div className="max-h-[8.5rem] shrink-0 overflow-y-auto border-b border-[var(--cf-border)] px-1.5 pb-1.5 pt-1">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("bench.section")}
          </p>
          {benchTabs.map((tab) => {
            const mine = terminalsOfTab(benchTerminals, tab.id);
            const live = mine.some((terminal) => terminal.session_id !== null);
            return (
              <button
                key={tab.id}
                onClick={() => {
                  if (!workspaceId) return;
                  // Focused on one of this tab's own shells, which is how `show` is told which tab
                  // to land on — it resolves the tab from the terminal. A tab always has at least
                  // one: closing the last pane closes the tab with it.
                  void useBenchStore
                    .getState()
                    .show(workspaceId, mine[0]?.id)
                    .catch((e: unknown) => pushErrorToast(String(e)));
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setBenchMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                }}
                title={benchTabLabel(tab, benchTerminals, t("bench.title"))}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                {/* Green when anything in the tab is still running — the one thing about a
                    backgrounded tab that is not in its name. */}
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    live ? "bg-[var(--cf-success)]" : "bg-[var(--cf-text-muted)]/40"
                  }`}
                />
                <TerminalSquare size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="min-w-0 flex-1 truncate">
                  {benchTabLabel(tab, benchTerminals, t("bench.title"))}
                </span>
                <span className="shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] font-semibold text-[var(--cf-text-muted)] dark:bg-white/[0.1]">
                  {mine.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {loading ? null : groupBy === "templates" ? (
          // Ahead of the "nothing yet" branch on purpose: that one counts tasks and chains, and a
          // workspace with saved plans but no work started yet would otherwise show an empty state
          // on top of a tab that has something in it.
          <TaskTree
            view="templates"
            tasks={filtered}
            query={query}
            onNewTask={onNewTask}
            onNewChain={onNewChain}
            onNewStory={onNewStory}
            onNewProject={onNewProject}
            onEditProject={onEditProject}
            onContinueWith={setContinuing}
            onUseTemplate={onUseTemplate}
          />
        ) : nothingYet ? (
          // Two different nothings, and they need two different ways out: with no agents defined
          // there is nobody to hand a task to yet, so offering "new task" first would open a dialog
          // with an empty picker.
          <ListEmpty
            icon={roster.length === 0 ? Bot : ListChecks}
            title={t(roster.length === 0 ? "agents.rosterEmpty" : "agents.tasksEmpty")}
            subtitle={t(roster.length === 0 ? "agents.rosterEmptyHint" : "agents.tasksEmptyHint")}
            actionLabel={t(roster.length === 0 ? "agents.newAgent" : "agents.newTask")}
            onAction={roster.length === 0 ? onNewAgent : () => onNewTask("")}
          />
        ) : groupBy === "tree" ? (
          <TaskTree
            tasks={filtered}
            query={query}
            onNewTask={onNewTask}
            onNewChain={onNewChain}
            onNewStory={onNewStory}
            onNewProject={onNewProject}
            onEditProject={onEditProject}
            onContinueWith={setContinuing}
            onUseTemplate={onUseTemplate}
          />
        ) : filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">{t("agents.noMatches")}</p>
        ) : (
          groups.map((group) => (
            <section key={group.key}>
              <h4 className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                <span className="truncate">{group.label}</span>
                <span className="shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] font-semibold dark:bg-white/[0.1]">
                  {group.tasks.length}
                </span>
              </h4>
              <div className="px-1.5">
                {group.tasks.map((task, at) =>
                  renamingId === task.id ? (
                    <RenameRow
                      key={task.id}
                      value={task.title}
                      onCancel={() => setRenamingId(null)}
                      onCommit={(name) => {
                        void useAgentsStore.getState().rename(task.id, name);
                        setRenamingId(null);
                      }}
                    />
                  ) : (
                    <FlatTaskRow
                      key={task.id}
                      task={task}
                      at={at}
                      selected={task.id === selectedId}
                      onMenu={(x, y) => setMenu({ x, y, id: task.id })}
                    />
                  ),
                )}
              </div>
            </section>
          ))
        )}
      </div>

      {/* The same two actions the tab in the panel offers, on the row that stands for it. Rename
          opens the panel on that tab first and *then* starts the editor: the input lives in the tab
          strip, and editing a label on a screen the tab is not on is editing something nobody can
          see. */}
      {benchMenu && (
        <ContextMenu
          x={benchMenu.x}
          y={benchMenu.y}
          items={[
            {
              label: t("bench.renameTab"),
              icon: Pencil,
              onClick: () => {
                if (!workspaceId) return;
                const first = terminalsOfTab(benchTerminals, benchMenu.tabId)[0]?.id;
                void useBenchStore
                  .getState()
                  .show(workspaceId, first)
                  .then(() => useBenchStore.getState().startRenameTab(benchMenu.tabId))
                  .catch((e: unknown) => pushErrorToast(String(e)));
              },
            },
            {
              label: t("bench.closeTab"),
              icon: Trash2,
              danger: true,
              separated: true,
              onClick: () =>
                void useBenchStore
                  .getState()
                  .closeTab(benchMenu.tabId)
                  .catch((e: unknown) => pushErrorToast(String(e))),
            },
          ]}
          onClose={() => setBenchMenu(null)}
        />
      )}

      {menu && menuTask && (
        <ContextMenu x={menu.x} y={menu.y} items={taskMenuItems(menuTask)} onClose={() => setMenu(null)} />
      )}
      {continuing && <ContinueWithModal taskId={continuing} onClose={() => setContinuing(null)} />}
    </div>
  );
}

function ListEmpty({
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  icon: typeof Bot;
  title: string;
  subtitle: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
      <div className="w-full">
        <EmptyState icon={icon} title={title} subtitle={subtitle} />
      </div>
      <button
        type="button"
        onClick={onAction}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      >
        <Plus size={13} />
        {actionLabel}
      </button>
    </div>
  );
}

/** A task as the status and agent groupings draw it: no nesting, no folder chip — those two cuts
 * are deliberately blind to the filing, so carrying its marks here would be noise. */
function FlatTaskRow({
  task,
  at,
  selected,
  onMenu,
}: {
  task: AgentTask;
  at: number;
  selected: boolean;
  onMenu: (x: number, y: number) => void;
}) {
  const t = useT();
  const select = useAgentsStore((s) => s.select);
  const sending = useAgentsStore((s) => s.live[task.id]?.sending ?? false);
  const projectName = useWorkspaceStore((s) => {
    const projects = s.activeWorkspaceId ? (s.projectsByWorkspace[s.activeWorkspaceId] ?? []) : [];
    return projects.find((p) => p.id === task.project_id)?.name ?? "";
  });

  // The live flag wins over the stored status: the row is the truth about a run in this session,
  // and the persisted `running` is only ever a leftover.
  const status = sending ? "running" : task.status;
  const { icon: Icon, color } = AGENT_STATUS[status];

  const when = relativeTime(task.updated_at, {
    now: t("ai.justNow"),
    minutes: t("ai.minutesAgo"),
    hours: t("ai.hoursAgo"),
    days: t("ai.daysAgo"),
  });

  return (
    <Row
      selected={selected}
      at={at}
      onMenu={onMenu}
      pinned={task.pinned}
      onClick={() => {
        // The middle column holds one thing: opening a task puts away whatever chain was there.
        void useChainStore.getState().select(null);
        void select(task.id);
      }}
      title={task.goal || task.title}
      glyph={status === "running" ? <ThinkingOrb size="sm" /> : <Icon size={13} className={color} />}
      label={task.title || t("agents.newTask")}
      meta={[task.agent_name, projectName, when].filter(Boolean).join(" · ")}
      menuLabel={t("api.moreActions")}
    />
  );
}
