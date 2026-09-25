import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  CircleCheck,
  CircleHelp,
  Copy,
  Folder,
  GitCompare,
  Link2,
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
import { relativeTime } from "../api/settingsChrome";
import { Kbd, buttonClass, iconButtonClass } from "../common/Button";
import {
  explorerClass,
  explorerHeadClass,
  fieldClass,
  rowClass,
  sectionLabelClass,
  tabCountClass,
} from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Tooltip } from "../common/Tooltip";
import { chordLabel } from "../../lib/keys";
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
    <div data-tour="agents-tree" style={{ width }} className={`${explorerClass} h-full overflow-hidden`}>
      {/* One primary action, and the three toggles. Creating is what this panel is for, so it gets
          the one filled button; the other three ways to create (a chain, a story run, a folder)
          fold into its caret rather than standing beside it as four look-alike glyphs. What stays
          out here are the things that open and close — the terminal bench and the roster, which
          wear the "on" tint while their panel is up — and the manual. */}
      <div data-tour="agents-tree-actions" className={explorerHeadClass}>
        <NewSplitButton
          onNewTask={() => onNewTask("")}
          onNewChain={() => onNewChain("")}
          onNewStory={() => onNewStory("")}
          onNewProject={onNewProject}
        />
        <span className="min-w-1 flex-1" />
        {/* The terminal bench, before the roster — which is where it belongs in the reading of this
            toolbar rather than merely where it fits. The button to its left creates work for an
            agent to do; the roster to its right is who does it. This is the one that hands the
            machine back to the user: whatever CLI they want, driven by hand, in the same
            workspace. */}
        <Tooltip label={t("bench.title")}>
          <button
            type="button"
            onClick={toggleBench}
            aria-pressed={benchOpen}
            aria-label={t("bench.title")}
            className={iconButtonClass({ active: benchOpen })}
          >
            <TerminalSquare size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t("agents.manageAgents")}>
          <button
            type="button"
            onClick={toggleRoster}
            aria-pressed={rosterOpen}
            aria-label={t("agents.manageAgents")}
            className={iconButtonClass({ active: rosterOpen })}
          >
            <Users size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t("agents.help")}>
          <button type="button" onClick={onHelp} aria-label={t("agents.help")} className={iconButtonClass()}>
            <CircleHelp size={15} />
          </button>
        </Tooltip>
      </div>

      <div className="shrink-0 px-2.5 pb-2">
        <Segmented
          options={GROUPINGS.map((entry) => ({ value: entry.id, label: t(entry.labelKey) }))}
          value={groupBy}
          onChange={setGroupBy}
          layoutId="cf-agents-grouping"
          full
        />
      </div>

      <div className="shrink-0 px-2.5 pb-1.5">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("agents.searchPlaceholder")}
            aria-label={t("agents.searchPlaceholder")}
            className={fieldClass({ size: "sm", className: "w-full pl-7 pr-7" })}
          />
          {query && (
            <Tooltip label={t("api.clearSearch")}>
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("api.clearSearch")}
                className={iconButtonClass({ size: "xs", className: "absolute right-0.5 top-1/2 -translate-y-1/2" })}
              >
                <X size={13} />
              </button>
            </Tooltip>
          )}
        </div>
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
        <div className="max-h-[9.5rem] shrink-0 overflow-y-auto border-b border-[var(--cf-border)] px-2 pb-1.5">
          <p className={sectionLabelClass}>{t("bench.section")}</p>
          {benchTabs.map((tab) => {
            const mine = terminalsOfTab(benchTerminals, tab.id);
            const live = mine.some((terminal) => terminal.session_id !== null);
            return (
              <button
                key={tab.id}
                type="button"
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
                className={rowClass(false, "h-7")}
              >
                {/* Green and filled when anything in the tab is still running, a hollow ring when
                    nothing is — the one thing about a backgrounded tab that is not in its name, and
                    told by shape as well as by colour. */}
                <span
                  aria-hidden
                  className={`h-[7px] w-[7px] shrink-0 rounded-full ${
                    live ? "bg-[var(--cf-success)]" : "border border-[var(--cf-text-faint)]"
                  }`}
                />
                <TerminalSquare size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="min-w-0 flex-1 truncate">
                  {benchTabLabel(tab, benchTerminals, t("bench.title"))}
                </span>
                <span className={tabCountClass}>{mine.length}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2.5">
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
            hint={t(roster.length === 0 ? "agents.rosterEmptyHint" : "agents.tasksEmptyHint")}
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
          <p className="px-2 py-6 text-center text-[12px] text-[var(--cf-text-faint)]">{t("agents.noMatches")}</p>
        ) : (
          groups.map((group) => (
            <section key={group.key}>
              <h4 className={sectionLabelClass}>
                <span className="truncate">{group.label}</span>
                <span className={`${tabCountClass} tracking-normal`}>{group.tasks.length}</span>
              </h4>
              <div>
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

/**
 * "Nueva tarea ▾": the panel's one primary action, split.
 *
 * The body does what the `+` always did — a new task, the same as ⌘N. The caret holds the three
 * other ways to start something, with the labels and icons they had as buttons of their own, so
 * nothing moved further than one click. Only the caret opens the menu: the main body stays a single
 * press for the thing done most.
 */
function NewSplitButton({
  onNewTask,
  onNewChain,
  onNewStory,
  onNewProject,
}: {
  onNewTask: () => void;
  onNewChain: () => void;
  onNewStory: () => void;
  onNewProject: () => void;
}) {
  const t = useT();
  const activeView = useUiStore((s) => s.activeView);
  const boxRef = useRef<HTMLDivElement>(null);
  /** The split button's rect while its menu is open — the menu hangs off the whole control, so it
   *  lines up with the button's left edge rather than with the caret. */
  const [at, setAt] = useState<DOMRect | null>(null);

  // The menu portals to `document.body` and this view is hidden rather than unmounted — left open,
  // it would float over whatever the user switched to.
  useEffect(() => {
    if (activeView !== "agents") setAt(null);
  }, [activeView]);

  // Both halves wear the primary fill themselves, so each lights on its own hover; the hairline
  // between them is the one thing that says there are two.
  const half =
    "flex items-center bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))]";

  return (
    <div ref={boxRef} className="flex h-[26px] min-w-0 shrink items-stretch">
      <Tooltip label={t("agents.newTask")} trailing={<Kbd>{chordLabel("Mod+N")}</Kbd>}>
        <button
          type="button"
          onClick={onNewTask}
          className={`${half} min-w-0 gap-1.5 rounded-l-md pl-2 pr-2.5 text-[12px] font-semibold`}
        >
          <Plus size={14} className="shrink-0" />
          <span className="truncate">{t("agents.newTask")}</span>
        </button>
      </Tooltip>
      <Tooltip label={t("api.moreActions")}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={at !== null}
          aria-label={t("api.moreActions")}
          onClick={() => {
            const rect = boxRef.current?.getBoundingClientRect();
            if (rect) setAt(rect);
          }}
          className={`${half} w-[22px] shrink-0 justify-center rounded-r-md shadow-[inset_1px_0_0_color-mix(in_oklab,var(--cf-on-accent)_28%,transparent)]`}
        >
          <ChevronDown size={13} />
        </button>
      </Tooltip>
      {at && (
        <ContextMenu
          x={at.left}
          y={at.bottom}
          anchor={{ top: at.top, bottom: at.bottom, left: at.left, right: at.right, align: "start" }}
          items={[
            { label: t("agents.newChain"), icon: Link2, onClick: onNewChain },
            { label: t("agents.newStory"), icon: Wand2, onClick: onNewStory },
            // A folder is not work for an agent, so it sits under a hairline of its own.
            { label: t("agents.newProject"), icon: Folder, onClick: onNewProject, separated: true },
          ]}
          onClose={() => setAt(null)}
        />
      )}
    </div>
  );
}

/**
 * The list with nothing in it: just the way out. What the thing *is* — an agent, a task — goes in the
 * tooltip rather than in a heading and a paragraph over the button.
 */
function ListEmpty({ hint, actionLabel, onAction }: { hint: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Tooltip label={hint}>
        <button type="button" onClick={onAction} className={buttonClass({ variant: "secondary" })}>
          <Plus size={14} />
          {actionLabel}
        </button>
      </Tooltip>
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
      glyph={status === "running" ? <ThinkingOrb size="sm" /> : <Icon size={14} className={color} />}
      label={task.title || t("agents.newTask")}
      meta={[task.agent_name, projectName, when].filter(Boolean).join(" · ")}
      menuLabel={t("api.moreActions")}
    />
  );
}
