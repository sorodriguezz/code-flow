import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  CircleCheck,
  CircleHelp,
  Copy,
  GitCompare,
  Link2,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { AGENT_STATUS, STATUS_ORDER } from "./agentStatus";
import { chainStatusOf } from "./chainStatus";
import { ContinueWithModal } from "./ContinueWithModal";
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
import type { TranslationKey } from "../../lib/i18n/translations";
import type { AgentChain, AgentTask } from "../../types/domain";

const GROUPINGS: { id: TaskGrouping; labelKey: TranslationKey }[] = [
  { id: "date", labelKey: "agents.groupDate" },
  { id: "status", labelKey: "agents.groupStatus" },
  { id: "agent", labelKey: "agents.groupAgent" },
];

/** Where a row's menu was asked for. Only the id is kept, never the row itself: a turn landing
 * replaces the row object, and a menu built from the copy captured on right-click would go on
 * offering "Stop" for a run that has already finished. */
type RowMenu = { x: number; y: number; id: string };

/** Joins menu blocks, drawing the hairline at each seam. Blocks rather than a flat list with
 * `separated` flags because half these items are conditional — pinned to an item that drops out,
 * the separator drops out with it and the groups silently run together. */
function menuBlocks(...blocks: MenuItem[][]): MenuItem[] {
  return blocks
    .filter((block) => block.length > 0)
    .flatMap((block, i) => (i === 0 ? block : [{ ...block[0], separated: true }, ...block.slice(1)]));
}

/** Midnight-relative, not 24-hours-relative: "yesterday" means the day before today, which is what
 * a heading over a list of work is understood to mean. */
function dayBucket(iso: string): "today" | "yesterday" | "earlier" {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "earlier";
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (when.getTime() >= startOfToday.getTime()) return "today";
  return when.getTime() >= startOfToday.getTime() - 86_400_000 ? "yesterday" : "earlier";
}

interface Group {
  key: string;
  label: string;
  tasks: AgentTask[];
}

/**
 * The task list — the console's index of work in progress.
 *
 * Grouped rather than flat, and grouped three ways, because the question you bring to it changes:
 * by date to find what you were doing this morning, by status to find what is waiting on you, by
 * agent to find what the reviewer has been up to. The grouping is view state and deliberately not
 * persisted — it follows the question, not the workspace.
 *
 * Every row carries the same menu, on right-click and on the "…" that appears under the pointer.
 * The list is where a task is *found*, so it is also where it has to be actionable: reaching a
 * delete by first opening the task put the one row you wanted rid of in front of you.
 */
export function AgentTaskList({
  width,
  onNewTask,
  onNewChain,
  onNewAgent,
  onHelp,
}: {
  width: number;
  onNewTask: () => void;
  onNewChain: () => void;
  onNewAgent: () => void;
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
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const focusProject = useWorkspaceStore((s) => s.focusProject);

  const [menu, setMenu] = useState<RowMenu | null>(null);
  /** The row being renamed in place, if any. */
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
    if (groupBy === "agent") {
      const names = [...new Set(filtered.map((task) => task.agent_name))].sort((a, b) => a.localeCompare(b));
      return names.map((name) => ({
        key: name,
        label: name || t("settings.sddNewAgent"),
        tasks: filtered.filter((task) => task.agent_name === name),
      }));
    }
    const buckets: { key: "today" | "yesterday" | "earlier"; labelKey: TranslationKey }[] = [
      { key: "today", labelKey: "agents.groupToday" },
      { key: "yesterday", labelKey: "agents.groupYesterday" },
      { key: "earlier", labelKey: "agents.groupEarlier" },
    ];
    return buckets
      .map(({ key, labelKey }) => ({
        key,
        label: t(labelKey),
        tasks: filtered.filter((task) => dayBucket(task.updated_at) === key),
      }))
      .filter((group) => group.tasks.length > 0);
  }, [filtered, groupBy, t]);

  // Looked up rather than remembered, so a row deleted from elsewhere takes its menu with it.
  const menuTask = menu ? (tasks.find((candidate) => candidate.id === menu.id) ?? null) : null;

  const taskMenuItems = (task: AgentTask): MenuItem[] => {
    const running = live[task.id]?.sending ?? false;
    const done = task.status === "done";
    const store = () => useAgentsStore.getState();

    return menuBlocks(
      [
        { label: t("agents.rename"), icon: Pencil, onClick: () => setRenamingId(task.id) },
        {
          label: t(done ? "agents.reopen" : "agents.markDone"),
          icon: done ? RotateCcw : CircleCheck,
          onClick: () => void store().setStatus(task.id, done ? "idle" : "done"),
        },
        // Only while there is something to stop — an engine is editing that working copy, and this
        // is the one action in the menu that cannot wait for the task to be opened first.
        ...(running
          ? [{ label: t("ai.stop"), icon: Square, onClick: () => void store().stop(task.id) }]
          : []),
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

  return (
    <div style={{ width }} className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden ${CARD}`}>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("agents.tasks")}
        </span>
        <ToolbarButton onClick={onNewTask} title={t("agents.newTask")}>
          <Plus size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={onNewChain} title={t("agents.newChain")}>
          <Link2 size={13} />
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
        {/* Chains are pinned above the groupings rather than folded into them: a chain is a plan,
            not a piece of work, and it is the thing you come back to. Its steps still appear below
            as ordinary tasks, which is correct — that is exactly what they are. */}
        <ChainSection />

        {loading ? null : tasks.length === 0 ? (
          // Two different nothings, and they need two different ways out: with no agents defined
          // there is nobody to hand a task to yet, so offering "new task" first would open a dialog
          // with an empty picker.
          <ListEmpty
            icon={roster.length === 0 ? Bot : ListChecks}
            title={t(roster.length === 0 ? "agents.rosterEmpty" : "agents.tasksEmpty")}
            subtitle={t(roster.length === 0 ? "agents.rosterEmptyHint" : "agents.tasksEmptyHint")}
            actionLabel={t(roster.length === 0 ? "agents.newAgent" : "agents.newTask")}
            onAction={roster.length === 0 ? onNewAgent : onNewTask}
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
                {group.tasks.map((task) =>
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
                    <TaskRow
                      key={task.id}
                      task={task}
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

/** The workspace's live chains. Terminal ones drop out of here and live on only in their steps'
 * tasks — a finished plan is history, and history is what the groupings below are for. */
function ChainSection() {
  const t = useT();
  const chains = useChainStore((s) => s.chains);
  const selectedId = useChainStore((s) => s.selectedId);
  const activeView = useUiStore((s) => s.activeView);
  const [menu, setMenu] = useState<RowMenu | null>(null);

  useEffect(() => {
    if (activeView !== "agents") setMenu(null);
  }, [activeView]);

  const live = chains.filter((chain) => chain.status !== "done" && chain.status !== "aborted");
  const menuChain = menu ? (live.find((chain) => chain.id === menu.id) ?? null) : null;

  const chainMenuItems = (chain: AgentChain): MenuItem[] => {
    const store = () => useChainStore.getState();
    return menuBlocks(
      [
        // What "carry on" means depends on why it stopped: a paused chain picks up where it was,
        // a failed one has a step to run again first.
        ...(chain.status === "paused"
          ? [{ label: t("agents.resumeChain"), icon: Play, onClick: () => void store().resume(chain.id) }]
          : []),
        ...(chain.status === "failed"
          ? [{ label: t("agents.retryStep"), icon: Play, onClick: () => void store().retry(chain.id) }]
          : []),
        // Always available here: this section only ever lists chains that have not finished.
        { label: t("agents.abortChain"), icon: Square, onClick: () => void store().abort(chain.id) },
      ],
      [
        {
          label: t("agents.deleteChain"),
          icon: Trash2,
          danger: true,
          onClick: () => {
            void confirmAction(t("agents.deleteChainConfirm", { name: chain.title })).then((ok) => {
              if (ok) void store().remove(chain.id);
            });
          },
        },
      ],
    );
  };

  if (live.length === 0) return null;

  return (
    <section>
      <h4 className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        <span className="truncate">{t("agents.chains")}</span>
        <span className="shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] font-semibold dark:bg-white/[0.1]">
          {live.length}
        </span>
      </h4>
      <div className="px-1.5">
        {live.map((chain) => {
          const { icon: Icon, color, labelKey } = chainStatusOf(chain);
          const selected = chain.id === selectedId;
          return (
            <Row
              key={chain.id}
              selected={selected}
              onMenu={(x, y) => setMenu({ x, y, id: chain.id })}
              onClick={() => void useChainStore.getState().select(chain.id)}
              title={chain.goal || chain.title}
              glyph={chain.status === "running" ? <ThinkingOrb size="sm" /> : <Icon size={13} className={color} />}
              label={chain.title}
              meta={`${t(labelKey)} · ${t("agents.stepN", { n: chain.current_step + 1, total: chain.step_count })}`}
              menuLabel={t("api.moreActions")}
            />
          );
        })}
      </div>

      {menu && menuChain && (
        <ContextMenu x={menu.x} y={menu.y} items={chainMenuItems(menuChain)} onClose={() => setMenu(null)} />
      )}
    </section>
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

/**
 * One row of the list — a chain or a task, both of which are "a thing with a glyph, a name, a line
 * of context and a menu".
 *
 * The row is a div wrapping a button rather than a button, because the "…" is a button too and one
 * cannot legally sit inside the other. It keeps its width whether or not the pointer is over the
 * row: revealing it by making space would shift every name to the left as the mouse moved down the
 * list.
 */
function Row({
  selected,
  onClick,
  onMenu,
  title,
  glyph,
  label,
  meta,
  menuLabel,
}: {
  selected: boolean;
  onClick: () => void;
  onMenu: (x: number, y: number) => void;
  title: string;
  glyph: ReactNode;
  label: string;
  meta: string;
  menuLabel: string;
}) {
  return (
    <div
      // Right-clicking deliberately does *not* select the row the way the file tree's does: the
      // menu acts on the row it was opened from, and selecting would swap the middle column —
      // taking with it any follow-up half-typed into the open task's composer.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
      className={`group relative flex w-full items-start rounded-md ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
        title={title}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md py-1.5 pl-2 text-left"
      >
        <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">{glyph}</span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] ${selected ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"}`}
          >
            {label}
          </span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{meta}</span>
        </span>
      </button>
      {/* The same menu the right-click opens. Right-click is not discoverable on its own, and this
          list is where someone goes looking for how to get rid of a row. */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={menuLabel}
        title={menuLabel}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu(rect.right - 4, rect.bottom + 2);
        }}
        className="mr-1 mt-[5px] flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:bg-black/[0.06] hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-white/[0.1]"
      >
        <MoreHorizontal size={13} />
      </button>
    </div>
  );
}

/** A row turned into a text field. Its own component so it mounts with the current name as its
 * initial value — and unmounts when the rename ends, which is what stops a half-typed draft from
 * turning up the next time any row is renamed. */
function RenameRow({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-1">
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <Pencil size={12} className="text-[var(--cf-text-muted)]" />
      </span>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(draft);
          if (e.key === "Escape") onCancel();
        }}
        className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-transparent px-1 py-0.5 text-[12px] text-[var(--cf-text)] outline-none"
      />
    </div>
  );
}

function TaskRow({
  task,
  selected,
  onMenu,
}: {
  task: AgentTask;
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
      onMenu={onMenu}
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
