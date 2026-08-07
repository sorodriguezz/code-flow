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
  Trash2,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { AGENT_STATUS, STATUS_ORDER } from "./agentStatus";
import { ContinueWithModal } from "./ContinueWithModal";
import { TaskTree } from "./TaskTree";
import { RenameRow, Row, menuBlocks, type RowMenu } from "./TreeRow";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { CARD } from "../api/panelChrome";
import { relativeTime } from "../api/settingsChrome";
import { ToolbarButton } from "../db/dbChrome";
import { ActivePill } from "../common/ActivePill";
import { EmptyState } from "../common/EmptyState";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useAgentsStore, type TaskGrouping } from "../../state/agentsStore";
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
  const chains = useChainStore((s) => s.chains);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const focusProject = useWorkspaceStore((s) => s.focusProject);

  const [menu, setMenu] = useState<RowMenu | null>(null);
  /** The row being renamed in place, if any. Only the flat groupings use this — the tree keeps its
   * own, because it renames three kinds of row and this one only ever renames a task. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [continuing, setContinuing] = useState<string | null>(null);

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
    <div style={{ width }} className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden ${CARD}`}>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1">
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
