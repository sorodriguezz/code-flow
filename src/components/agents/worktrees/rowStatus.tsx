import { useEffect, useRef } from "react";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitBranch,
  House,
  MessageCircleQuestion,
  type LucideIcon,
} from "lucide-react";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { useAgentsStore } from "../../../state/agentsStore";
import { useAgentCliStore } from "../../../state/agentCliStore";
import { reviewOf, useTaskReviewStore } from "../../../state/taskReviewStore";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { isWithin } from "../../../lib/agents/terminalTask";
import { tally, type RaceTally } from "../../../lib/agents/race";
import { isUnread, rowState, type RowState, type WorktreeRow } from "../../../lib/agents/worktreeRows";
import type { TranslationKey } from "../../../lib/i18n/translations";

/** How each state is drawn — one table, so the rail, the header and the grid never disagree. */
export const ROW_STATE: Record<RowState, { icon: LucideIcon | null; color: string; labelKey: TranslationKey }> = {
  asking: { icon: MessageCircleQuestion, color: "text-[var(--cf-warning)]", labelKey: "wt.state.asking" },
  // Drawn as the orb, the mark every live AI run in the app wears.
  working: { icon: null, color: "text-[var(--cf-accent)]", labelKey: "wt.state.working" },
  failed: { icon: CircleAlert, color: "text-[var(--cf-danger)]", labelKey: "wt.state.failed" },
  ready: { icon: CircleDot, color: "text-[var(--cf-accent)]", labelKey: "wt.state.ready" },
  done: { icon: CircleCheck, color: "text-[var(--cf-success)]", labelKey: "wt.state.done" },
  draft: { icon: Circle, color: "text-[var(--cf-text-muted)]", labelKey: "wt.state.draft" },
  stopped: { icon: CircleSlash, color: "text-[var(--cf-text-muted)]", labelKey: "wt.state.stopped" },
  empty: { icon: GitBranch, color: "text-[var(--cf-text-faint)]", labelKey: "wt.state.empty" },
};

export interface RowLive {
  state: RowState;
  sending: boolean;
  unread: boolean;
}

/**
 * A row's live state. Primitives out of each selector: `agentsStore` moves several times a second
 * while a turn streams, and an object out of a selector would redraw every row on each of them.
 */
export function useRowLive(row: WorktreeRow, selected: boolean): RowLive {
  const taskId = row.task?.id ?? "";
  const sending = useAgentsStore((s) => (taskId ? (s.live[taskId]?.sending ?? false) : false));
  // A `cf ask` from inside this folder is the agent waiting on the user — whatever else it is doing.
  const asking = useAgentCliStore((s) => s.asks.some((ask) => ask.cwd !== "" && row.path !== "" && isWithin(row.path, ask.cwd)));
  const unread = useWorktreeViewStore((s) => isUnread(row.task, s.seenTurns, selected));
  return { state: rowState(row, sending, asking), sending, unread };
}

/** The mark at the start of a row. */
export function RowMark({ row, state, size = 14 }: { row: WorktreeRow; state: RowState; size?: number }) {
  if (state === "working") {
    return (
      <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
        <ThinkingOrb size="sm" />
      </span>
    );
  }
  // A repository's own checkout with nobody in it reads as "home" rather than as one more branch.
  const Icon = state === "empty" && row.isMain ? House : (ROW_STATE[state].icon ?? Circle);
  return <Icon size={size} className={`shrink-0 ${ROW_STATE[state].color}`} />;
}

/** The key a row's diff is read under: its task's (shared with the task's own review tab), or one
 *  of its own for a worktree no task owns. */
export function reviewKeyOf(row: WorktreeRow): string {
  return row.task ? row.task.id : `wt:${row.path}`;
}

/**
 * What the row's working copy has changed, read when the row appears and again each time a turn
 * there finishes — never on a timer. `null` until the first read lands.
 */
export function useRowTally(row: WorktreeRow, sending: boolean, enabled = true): RaceTally | null {
  const key = reviewKeyOf(row);
  const files = useTaskReviewStore((s) => (s.byTask[key] ? reviewOf(s, key).files : null));
  const load = useTaskReviewStore((s) => s.load);
  const wasSending = useRef(sending);
  useEffect(() => {
    if (!enabled || row.path === "") return;
    // On mount, and on the edge from running to settled — that edge is when the files changed.
    if (wasSending.current && sending) return;
    wasSending.current = sending;
    if (!sending) void load(key, row.path);
  }, [enabled, key, row.path, sending, load]);
  return files ? tally(files) : null;
}

/** `+12 −3`, or nothing for a clean copy. */
export function TallyText({ value, className = "" }: { value: RaceTally | null; className?: string }) {
  if (!value || (value.added === 0 && value.removed === 0 && value.files === 0)) return null;
  return (
    <span className={`shrink-0 font-mono text-[11px] tabular-nums ${className}`}>
      <span className="text-[var(--cf-success)]">+{value.added}</span>{" "}
      <span className="text-[var(--cf-danger)]">−{value.removed}</span>
    </span>
  );
}
