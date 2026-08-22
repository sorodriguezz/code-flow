import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Clock,
  SkipForward,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { PipelineStatus } from "../../types/domain";

/**
 * One glyph and one colour per status bucket.
 *
 * Deliberately the same vocabulary the agent console uses (`agentStatus.ts`): `CircleCheck` for
 * done, `CircleAlert` for failed, `CircleSlash` for cancelled, `CircleDot` for something live. A
 * finished pipeline and a finished agent task are the same *kind* of fact, and two different
 * glyphs for it would be two things to learn instead of one.
 *
 * The colours are the semantic tokens rather than `settingsChrome`'s `Tone`, for the reason
 * `agentStatus.ts` writes down: that vocabulary has no `danger`, and a build that broke has to
 * read as broken.
 */
export const PIPELINE_STATUS: Record<
  PipelineStatus,
  { icon: LucideIcon; color: string; labelKey: TranslationKey }
> = {
  queued: { icon: Clock, color: "text-[var(--cf-text-muted)]", labelKey: "pipelines.statusQueued" },
  // The icon is here for the label and the screen reader; on screen a running job is drawn with
  // `<ThinkingOrb size="sm" />` instead, exactly as a running agent task is.
  running: { icon: CircleDot, color: "text-[var(--cf-accent)]", labelKey: "pipelines.statusRunning" },
  success: { icon: CircleCheck, color: "text-[var(--cf-success)]", labelKey: "pipelines.statusSuccess" },
  warning: { icon: TriangleAlert, color: "text-[var(--cf-warning)]", labelKey: "pipelines.statusWarning" },
  failed: { icon: CircleAlert, color: "text-[var(--cf-danger)]", labelKey: "pipelines.statusFailed" },
  cancelled: { icon: CircleSlash, color: "text-[var(--cf-text-muted)]", labelKey: "pipelines.statusCancelled" },
  skipped: { icon: SkipForward, color: "text-[var(--cf-text-muted)]", labelKey: "pipelines.statusSkipped" },
};

/** The order the status filter offers them in: live first, then bad news, then the rest. */
export const STATUS_ORDER: PipelineStatus[] = [
  "running",
  "queued",
  "failed",
  "warning",
  "success",
  "cancelled",
  "skipped",
];

/**
 * The bucket, defensively.
 *
 * The backend's set is closed and the type says so, but the value crosses an IPC boundary as a
 * plain string — and a bucket added on the Rust side and not here would otherwise index to
 * `undefined` and take the row's render down with it. `chainStatusOf` guards the same way.
 */
export function statusOf(status: string): PipelineStatus {
  return status in PIPELINE_STATUS ? (status as PipelineStatus) : "queued";
}

/** Bar colour for the waterfall and the list's parallelism strip — a raw token, not a class. */
export const STATUS_TOKEN: Record<PipelineStatus, string> = {
  queued: "var(--cf-border)",
  running: "var(--cf-accent)",
  success: "var(--cf-success)",
  warning: "var(--cf-warning)",
  failed: "var(--cf-danger)",
  cancelled: "var(--cf-text-muted)",
  skipped: "var(--cf-border)",
};

/** Epoch milliseconds for an RFC3339 stamp, or `null` — the hosts all emit RFC3339. */
export function at(stamp: string | null): number | null {
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A duration, at the precision a build is read at.
 *
 * Not `dbChrome.formatDuration`: that one answers in milliseconds and two decimals because it
 * times SQL queries. Nobody cares that a job took 3 minutes and 31.44 seconds.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * How long something took, or how long it has been going.
 *
 * A run with no finish time is not a run of unknown length — it is one that is still going, and
 * measuring it to *now* is the only honest answer while it does.
 */
export function elapsed(startedAt: string | null, finishedAt: string | null, now: number): number | null {
  const start = at(startedAt);
  if (start === null) return null;
  return (at(finishedAt) ?? now) - start;
}
