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
