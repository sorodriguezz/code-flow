import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, CalendarClock, Coins, Flag, Tag } from "lucide-react";
import { Select } from "../common/Select";
import { chipClass, fieldClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import type { MenuItem } from "../common/ContextMenu";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { useT, type Translate } from "../../state/languageStore";
import type { AgentTask, AgentTaskStatus } from "../../types/domain";
import type { TranslationKey } from "../../lib/i18n/translations";
import { agentName } from "./agentName";

/**
 * What the Agents view plans work with — priority, a due date, labels, archiving — and what work
 * cost. A task is a conversation first; these sit on it the way they sit on an issue, never in the
 * way of talking to it.
 */

const PRIORITY: { value: number; labelKey: TranslationKey; color: string }[] = [
  { value: 0, labelKey: "agents.priority.none", color: "var(--cf-text-faint)" },
  { value: 1, labelKey: "agents.priority.low", color: "var(--cf-blue)" },
  { value: 2, labelKey: "agents.priority.medium", color: "var(--cf-warning)" },
  { value: 3, labelKey: "agents.priority.high", color: "var(--cf-danger)" },
];

export function PriorityFlag({ priority }: { priority: number | undefined }) {
  const t = useT();
  const entry = PRIORITY.find((p) => p.value === (priority ?? 0));
  if (!entry || entry.value === 0) return null;
  return (
    <span title={t(entry.labelKey)} className="inline-flex shrink-0">
      <Flag size={11} style={{ color: entry.color }} fill="currentColor" />
    </span>
  );
}

/** Today as `YYYY-MM-DD`, in local time — what a due date is compared with. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** A due date as a row says it, and whether it has passed (for an unfinished task). */
export function dueInfo(task: Pick<AgentTask, "due_date" | "status">, t: Translate): { text: string; overdue: boolean } | null {
  const due = task.due_date?.trim();
  if (!due) return null;
  const [y, m, d] = due.split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  const text = t("agents.dueOn", { date: date.toLocaleDateString(undefined, { day: "numeric", month: "short" }) });
  return { text, overdue: task.status !== "done" && due < today() };
}

/** What a set of tasks spent, as the app shows it: dollars when an engine reported a price, tokens
 *  otherwise — `null` when nothing ran. */
export function costText(tasks: Pick<AgentTask, "cost_usd" | "costed_turns" | "input_tokens" | "output_tokens">[], t: Translate): string | null {
  const tokens = tasks.reduce((sum, task) => sum + (task.input_tokens ?? 0) + (task.output_tokens ?? 0), 0);
  const costed = tasks.reduce((sum, task) => sum + (task.costed_turns ?? 0), 0);
  const cost = tasks.reduce((sum, task) => sum + (task.cost_usd ?? 0), 0);
  if (tokens === 0 && costed === 0) return null;
  const tokenText = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)} M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)} k` : String(tokens);
  return costed > 0 ? t("agents.costWithPrice", { cost: cost < 0.01 ? "<0.01" : cost.toFixed(2), tokens: tokenText }) : t("agents.costTokens", { tokens: tokenText });
}

/** The line of context a task row adds: its due date and its labels. */
export function planningMeta(task: AgentTask, t: Translate): string[] {
  const due = dueInfo(task, t);
  return [due ? `${due.overdue ? "⚠ " : ""}${due.text}` : "", ...(task.labels ?? []).map((label) => `#${label}`)].filter(Boolean);
}

/** The menu entries every task menu carries: its priority, and archiving. `inChain` tasks are not
 *  archived on their own — the step belongs to its plan. */
export function planningMenuItems(task: AgentTask, t: Translate, inChain = false): MenuItem[] {
  const store = useAgentsStore.getState;
  const items: MenuItem[] = [
    {
      label: t("agents.priority.title"),
      icon: Flag,
      onClick: () => {},
      children: PRIORITY.map((entry) => ({
        label: t(entry.labelKey),
        checked: (task.priority ?? 0) === entry.value,
        onClick: () => void store().setPlanning(task.id, { priority: entry.value }),
      })),
    },
  ];
  if (!inChain) {
    items.push(
      task.archived
        ? { label: t("agents.unarchive"), icon: ArchiveRestore, onClick: () => void store().setArchived(task.id, false) }
        : { label: t("agents.archive"), icon: Archive, onClick: () => void store().setArchived(task.id, true) },
    );
  }
  return items;
}

/**
 * The strip under a task's toolbar: priority, due date, labels, and what its turns have cost so far.
 * One line of small controls, edited in place.
 */
export function TaskPlanningBar({ task }: { task: AgentTask }) {
  const t = useT();
  const setPlanning = useAgentsStore((s) => s.setPlanning);
  const [labels, setLabels] = useState((task.labels ?? []).join(", "));
  useEffect(() => setLabels((task.labels ?? []).join(", ")), [task.labels]);
  const commitLabels = () => {
    const next = labels.split(",").map((label) => label.trim().replace(/^#/, "")).filter(Boolean);
    if (next.join(",") !== (task.labels ?? []).join(",")) void setPlanning(task.id, { labels: [...new Set(next)] });
  };
  const due = dueInfo(task, t);
  const cost = costText([task], t);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 text-[12px] text-[var(--cf-text-muted)]">
      <span className="w-[130px] shrink-0">
        <Select
          size="sm"
          value={String(task.priority ?? 0)}
          ariaLabel={t("agents.priority.title")}
          onChange={(value) => void setPlanning(task.id, { priority: Number(value) })}
          options={PRIORITY.map((entry) => ({ value: String(entry.value), label: t(entry.labelKey) }))}
        />
      </span>
      <Tooltip label={t("agents.dueHint")}>
        <label className="flex shrink-0 items-center gap-1">
          <CalendarClock size={13} className={due?.overdue ? "text-[var(--cf-danger)]" : undefined} />
          <input
            type="date"
            value={task.due_date ?? ""}
            onChange={(e) => void setPlanning(task.id, { dueDate: e.target.value })}
            className={fieldClass({ size: "sm", className: `w-[132px] ${due?.overdue ? "text-[var(--cf-danger)]" : ""}` })}
          />
        </label>
      </Tooltip>
      <label className="flex min-w-0 flex-1 items-center gap-1">
        <Tag size={13} className="shrink-0" />
        <input
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          onBlur={commitLabels}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitLabels();
          }}
          placeholder={t("agents.labelsPlaceholder")}
          spellCheck={false}
          className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}
        />
      </label>
      {cost && (
        <Tooltip label={t("agents.costHint")}>
          <span className="flex shrink-0 items-center gap-1 tabular-nums">
            <Coins size={13} />
            {cost}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- board

type Column = { id: "todo" | "doing" | "trouble" | "done"; labelKey: TranslationKey; statuses: AgentTaskStatus[]; dropTo?: AgentTaskStatus };

const COLUMNS: Column[] = [
  { id: "todo", labelKey: "agents.board.todo", statuses: ["draft", "idle"], dropTo: "idle" },
  { id: "doing", labelKey: "agents.board.doing", statuses: ["running"] },
  { id: "trouble", labelKey: "agents.board.trouble", statuses: ["error", "cancelled"] },
  { id: "done", labelKey: "agents.board.done", statuses: ["done"], dropTo: "done" },
];

/** Highest priority first, then the soonest due, then the most recently touched. */
function boardOrder(a: AgentTask, b: AgentTask): number {
  const priority = (b.priority ?? 0) - (a.priority ?? 0);
  if (priority) return priority;
  const ad = a.due_date || "9999";
  const bd = b.due_date || "9999";
  if (ad !== bd) return ad.localeCompare(bd);
  return b.updated_at.localeCompare(a.updated_at);
}

/**
 * The workspace's tasks as a board: what is waiting, running, in trouble and done, a column each.
 * Dragging a card to "done" closes it and back to "to do" reopens it; running and failing are
 * things a turn does, not something a card can be dropped into. A card opens its task.
 */
export function TaskBoard() {
  const t = useT();
  const tasks = useAgentsStore((s) => s.tasks);
  const live = useAgentsStore((s) => s.live);
  const query = useAgentsStore((s) => s.query);
  const [over, setOver] = useState<Column["id"] | null>(null);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter(
      (task) =>
        !task.archived &&
        (!needle || task.title.toLowerCase().includes(needle) || task.goal.toLowerCase().includes(needle) || (task.labels ?? []).some((l) => l.toLowerCase().includes(needle))),
    );
  }, [tasks, query]);
  const statusOf = (task: AgentTask): AgentTaskStatus => (live[task.id]?.sending ? "running" : task.status);

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
      {COLUMNS.map((column) => {
        const cards = shown.filter((task) => column.statuses.includes(statusOf(task))).sort(boardOrder);
        const droppable = !!column.dropTo;
        return (
          <section
            key={column.id}
            onDragOver={(e) => {
              if (!droppable) return;
              e.preventDefault();
              setOver(column.id);
            }}
            onDragLeave={() => setOver((current) => (current === column.id ? null : current))}
            onDrop={(e) => {
              setOver(null);
              const id = e.dataTransfer.getData("text/cf-agent-task");
              const task = tasks.find((candidate) => candidate.id === id);
              if (!task || !column.dropTo || statusOf(task) === "running") return;
              if (!column.statuses.includes(task.status)) void useAgentsStore.getState().setStatus(task.id, column.dropTo);
            }}
            className={`flex min-h-0 w-[260px] shrink-0 flex-col rounded-lg border bg-[var(--cf-sunken)] ${
              over === column.id ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"
            }`}
          >
            <h4 className="flex items-center gap-2 px-3 pb-1.5 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              <span className="flex-1">{t(column.labelKey)}</span>
              <span className="tabular-nums">{cards.length}</span>
            </h4>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
              {cards.map((task) => (
                <BoardCard key={task.id} task={task} running={statusOf(task) === "running"} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function BoardCard({ task, running }: { task: AgentTask; running: boolean }) {
  const t = useT();
  const due = dueInfo(task, t);
  const cost = costText([task], t);
  return (
    <button
      type="button"
      draggable={!running}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/cf-agent-task", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => {
        void useChainStore.getState().select(null);
        void useAgentsStore.getState().select(task.id);
      }}
      title={task.goal || task.title}
      className="block w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 text-left transition-colors hover:border-[var(--cf-border-strong)]"
    >
      <span className="flex items-start gap-1.5">
        {running && <ThinkingOrb size="sm" />}
        <PriorityFlag priority={task.priority} />
        <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] font-medium text-[var(--cf-text)]">{task.title || t("agents.newTask")}</span>
      </span>
      <span className="mt-1 block truncate text-[11px] text-[var(--cf-text-faint)]">{agentName(task.agent_name, task.provider, t)}</span>
      {(due || (task.labels ?? []).length > 0 || cost) && (
        <span className="mt-1.5 flex flex-wrap items-center gap-1">
          {due && <span className={chipClass(due.overdue ? "bad" : "neutral")}>{due.text}</span>}
          {(task.labels ?? []).map((label) => (
            <span key={label} className={chipClass("info")}>
              #{label}
            </span>
          ))}
          {cost && <span className="text-[10.5px] tabular-nums text-[var(--cf-text-faint)]">{cost}</span>}
        </span>
      )}
    </button>
  );
}
