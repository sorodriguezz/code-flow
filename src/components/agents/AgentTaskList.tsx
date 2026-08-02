import { useMemo } from "react";
import { Bot, CircleHelp, Link2, ListChecks, Plus, Search, Users, X } from "lucide-react";
import { AGENT_STATUS, STATUS_ORDER } from "./agentStatus";
import { chainStatusOf } from "./chainStatus";
import { CARD } from "../api/panelChrome";
import { relativeTime } from "../api/settingsChrome";
import { ToolbarButton } from "../db/dbChrome";
import { ActivePill } from "../common/ActivePill";
import { EmptyState } from "../common/EmptyState";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useAgentsStore, type TaskGrouping } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { AgentTask } from "../../types/domain";

const GROUPINGS: { id: TaskGrouping; labelKey: TranslationKey }[] = [
  { id: "date", labelKey: "agents.groupDate" },
  { id: "status", labelKey: "agents.groupStatus" },
  { id: "agent", labelKey: "agents.groupAgent" },
];

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
  const loading = useAgentsStore((s) => s.loading);
  const groupBy = useAgentsStore((s) => s.groupBy);
  const query = useAgentsStore((s) => s.query);
  const selectedId = useAgentsStore((s) => s.selectedId);
  const rosterOpen = useAgentsStore((s) => s.rosterOpen);
  const setGroupBy = useAgentsStore((s) => s.setGroupBy);
  const setQuery = useAgentsStore((s) => s.setQuery);
  const toggleRoster = useAgentsStore((s) => s.toggleRoster);

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
                {group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} selected={task.id === selectedId} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** The workspace's live chains. Terminal ones drop out of here and live on only in their steps'
 * tasks — a finished plan is history, and history is what the groupings below are for. */
function ChainSection() {
  const t = useT();
  const chains = useChainStore((s) => s.chains);
  const selectedId = useChainStore((s) => s.selectedId);
  const live = chains.filter((chain) => chain.status !== "done" && chain.status !== "aborted");
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
            <button
              key={chain.id}
              type="button"
              onClick={() => void useChainStore.getState().select(chain.id)}
              aria-current={selected ? "page" : undefined}
              title={chain.goal || chain.title}
              className={`relative flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${
                selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              }`}
            >
              <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {chain.status === "running" ? <ThinkingOrb size="sm" /> : <Icon size={13} className={color} />}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[13px] ${
                    selected ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
                  }`}
                >
                  {chain.title}
                </span>
                <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                  {t(labelKey)} · {t("agents.stepN", { n: chain.current_step + 1, total: chain.step_count })}
                </span>
              </span>
            </button>
          );
        })}
      </div>
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

function TaskRow({ task, selected }: { task: AgentTask; selected: boolean }) {
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
  const meta = [task.agent_name, projectName, when].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      onClick={() => {
        // The middle column holds one thing: opening a task puts away whatever chain was there.
        void useChainStore.getState().select(null);
        void select(task.id);
      }}
      aria-current={selected ? "page" : undefined}
      title={task.goal || task.title}
      className={`group relative flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${
        selected
          ? "bg-[var(--cf-accent-soft)]"
          : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {status === "running" ? <ThinkingOrb size="sm" /> : <Icon size={13} className={color} />}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[13px] ${selected ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"}`}
        >
          {task.title || t("agents.newTask")}
        </span>
        <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{meta}</span>
      </span>
    </button>
  );
}
