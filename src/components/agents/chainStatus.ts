import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Clock,
  PauseCircle,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { AgentChain, ChainStatus, ChainStepStatus } from "../../types/domain";

/**
 * A chain's own vocabulary, kept separate from `AGENT_STATUS`. They look alike and mean different
 * things — a task's "your turn" is an invitation, a chain's "waiting for you" is a gate it will
 * not pass without an answer — and collapsing them would make one of the two lie.
 */
export const CHAIN_STATUS: Record<ChainStatus, { icon: LucideIcon; color: string; labelKey: TranslationKey }> = {
  queued: { icon: Clock, color: "text-[var(--cf-text-muted)]", labelKey: "agents.chainStatusQueued" },
  running: { icon: CircleDot, color: "text-[var(--cf-accent)]", labelKey: "agents.chainStatusRunning" },
  gated: { icon: PauseCircle, color: "text-[var(--cf-accent)]", labelKey: "agents.chainStatusGated" },
  paused: { icon: PauseCircle, color: "text-[var(--cf-text-muted)]", labelKey: "agents.chainStatusPaused" },
  failed: { icon: CircleAlert, color: "text-[var(--cf-danger)]", labelKey: "agents.chainStatusFailed" },
  done: { icon: CircleCheck, color: "text-[var(--cf-success)]", labelKey: "agents.chainStatusDone" },
  aborted: { icon: CircleSlash, color: "text-[var(--cf-text-muted)]", labelKey: "agents.chainStatusAborted" },
};

/** Falls back rather than throwing: a row written by a newer build must not crash the pane. */
export function chainStatusOf(chain: AgentChain) {
  return CHAIN_STATUS[chain.status] ?? CHAIN_STATUS.paused;
}

/**
 * How a chain reads once you look at what actually happened inside it.
 *
 * `chain.status` answers "may the scheduler move?", which is not the question the list row is
 * asking. A plan can reach `done` having skipped one step and failed another, and an icon that
 * only mirrored the status would call that a clean run — the one reading a glance is least likely
 * to go back and check.
 *
 * The order below is the order the answers matter in: what is happening now beats what is waiting,
 * which beats what went wrong, which beats how it finished. `spinner` is separate from the icon
 * because a live chain wears the app's `ThinkingOrb`, which is a component and not a glyph.
 */
export function chainRollup(
  chain: AgentChain,
  steps: { status: ChainStepStatus }[],
): { icon: LucideIcon; color: string; labelKey: TranslationKey; done: number; total: number; spinner: boolean } {
  const done = steps.filter((step) => step.status === "done").length;
  // `step_count` is the plan as authored; `steps.length` is what has been loaded. The larger of the
  // two is the honest denominator — a chain whose briefs have not arrived yet must not read "0/0".
  const total = Math.max(steps.length, chain.step_count);
  const base = { done, total, spinner: false };

  if (chain.status === "running" || steps.some((step) => step.status === "running")) {
    return { ...base, ...CHAIN_STATUS.running, spinner: true };
  }
  if (chain.status === "gated") return { ...base, ...CHAIN_STATUS.gated };
  // Deliberately louder than the chain's own status: a failed step that a later retry stepped over
  // still cost someone a working tree, and it is the thing worth going back to.
  if (steps.some((step) => step.status === "error")) {
    return { ...base, icon: CircleAlert, color: "text-[var(--cf-danger)]", labelKey: "agents.chainStatusFailed" };
  }
  if (chain.status === "done") {
    const gaps = steps.some((step) => step.status === "skipped" || step.status === "interrupted");
    return gaps
      ? { ...base, icon: CircleCheck, color: "text-[var(--cf-warning)]", labelKey: "agents.chainRollupPartial" }
      : { ...base, ...CHAIN_STATUS.done };
  }
  return { ...base, ...chainStatusOf(chain) };
}

const STEP_COLOR: Record<ChainStepStatus, string> = {
  pending: "text-[var(--cf-text-muted)]",
  running: "text-[var(--cf-accent)]",
  done: "text-[var(--cf-success)]",
  error: "text-[var(--cf-danger)]",
  interrupted: "text-[var(--cf-warning)]",
  skipped: "text-[var(--cf-text-muted)]",
};

export function stepColor(status: ChainStepStatus): string {
  return STEP_COLOR[status] ?? STEP_COLOR.pending;
}

/** Every reason the backend writes as a key rather than as prose, so it can be read back in the
 * reader's language. Anything not in here is a raw engine error and is shown verbatim. */
const REASON_KEYS = new Set<string>([
  "chain.interrupted",
  "chain.repoBusy",
  "chain.projectGone",
  "chain.agentNotRoutable",
  "chain.attemptsExhausted",
  "chain.emptyOutput",
  "chain.stopped",
  "chain.timedOut",
  "chain.noSteps",
  "chain.tooManySteps",
]);

export function reasonText(reason: string, t: (key: TranslationKey) => string): string {
  const trimmed = reason.trim();
  if (!trimmed) return "";
  return REASON_KEYS.has(trimmed) ? t(trimmed as TranslationKey) : trimmed;
}
