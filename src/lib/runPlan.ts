/** One item of the plan an agent keeps for itself (Claude Code's `TodoWrite`). */
export interface PlanItem {
  text: string;
  status: "pending" | "active" | "done";
}

/** Marks the log line that carries the whole plan. Not a step: `parseRunSteps` skips it. */
export const PLAN_MARK = "≡ ";

const MAX_ITEMS = 40;
const MAX_TEXT = 140;

function statusOf(raw: unknown): PlanItem["status"] {
  if (raw === "completed" || raw === "done") return "done";
  if (raw === "in_progress" || raw === "active") return "active";
  return "pending";
}

/**
 * The plan from a `TodoWrite` call's `todos` input, or `null` when there is none worth showing. The
 * agent rewrites the whole list each time, so the newest line is the plan.
 */
export function planFromTodos(todos: unknown): PlanItem[] | null {
  if (!Array.isArray(todos)) return null;
  const items: PlanItem[] = [];
  for (const todo of todos.slice(0, MAX_ITEMS)) {
    if (typeof todo !== "object" || todo === null) continue;
    const record = todo as Record<string, unknown>;
    const text = typeof record.content === "string" ? record.content : typeof record.activeForm === "string" ? record.activeForm : "";
    if (!text.trim()) continue;
    items.push({ text: text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT), status: statusOf(record.status) });
  }
  return items.length > 0 ? items : null;
}

/** The log line for a plan: the mark and the items as JSON. */
export function planLine(items: PlanItem[]): string {
  return `${PLAN_MARK}${JSON.stringify(items)}`;
}

/** The newest plan in a run's log lines, or `null`. */
export function latestPlan(lines: readonly { text: string }[] | undefined): PlanItem[] | null {
  if (!lines) return null;
  for (let at = lines.length - 1; at >= 0; at--) {
    for (const raw of lines[at].text.split("\n").reverse()) {
      if (!raw.startsWith(PLAN_MARK)) continue;
      try {
        const parsed: unknown = JSON.parse(raw.slice(PLAN_MARK.length));
        if (Array.isArray(parsed)) {
          const items = parsed.filter(
            (item): item is PlanItem => typeof item?.text === "string" && ["pending", "active", "done"].includes(item?.status),
          );
          if (items.length > 0) return items;
        }
      } catch {
        // A partial line: the one before it is still a plan.
      }
    }
  }
  return null;
}

/** "3/7", for the header. */
export function planProgress(items: readonly PlanItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.status === "done").length, total: items.length };
}
