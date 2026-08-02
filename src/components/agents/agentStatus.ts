import { Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, type LucideIcon } from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { AgentTaskStatus } from "../../types/domain";

/**
 * How each task state is drawn, in one place so the list row, the task header and the group
 * headings can never disagree about what "idle" looks like.
 *
 * Deliberately not built on `settingsChrome`'s `Status`/`Tone`: that vocabulary has no danger tone
 * and reserves `warning` for "this can lose your work", which a failed run is not. A task that
 * failed needs to read as failed, so the colour is named here instead.
 *
 * `running` has no entry that draws a glyph — it gets the app's `ThinkingOrb`, the same mark every
 * other live AI run in the app wears — but it still needs a label, so it is in the map.
 */
export const AGENT_STATUS: Record<AgentTaskStatus, { icon: LucideIcon; color: string; labelKey: TranslationKey }> = {
  draft: { icon: Circle, color: "text-[var(--cf-text-muted)]", labelKey: "agents.statusDraft" },
  running: { icon: CircleDot, color: "text-[var(--cf-accent)]", labelKey: "agents.statusRunning" },
  // "Your turn" — the state a task spends most of its life in, and the one worth an accent.
  idle: { icon: CircleDot, color: "text-[var(--cf-accent)]", labelKey: "agents.statusIdle" },
  done: { icon: CircleCheck, color: "text-[var(--cf-success)]", labelKey: "agents.statusDone" },
  error: { icon: CircleAlert, color: "text-[var(--cf-danger)]", labelKey: "agents.statusError" },
  cancelled: { icon: CircleSlash, color: "text-[var(--cf-text-muted)]", labelKey: "agents.statusCancelled" },
};

/** The order status groups are listed in — live work first, finished work last. */
export const STATUS_ORDER: AgentTaskStatus[] = ["running", "idle", "draft", "error", "cancelled", "done"];
