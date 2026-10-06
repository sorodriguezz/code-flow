import type { FlowNodeRunStatus, FlowRunStatus } from "../../lib/tauri/flowsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

/** "1 item", "3 items" — the translator substitutes, it does not pluralise. */
export function itemsLabel(t: (key: TranslationKey, params?: Record<string, string | number>) => string, n: number): string {
  // Grouped the way the reader writes numbers: «10.000 items», "10,000 items".
  return n === 1 ? t("flows.oneItem") : t("flows.items", { n: n.toLocaleString() });
}

/** How long something took, the way a person reads it. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** A clock that is still running: whole seconds, so it ticks without flickering. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A node's time on the canvas: its clock while it runs, what it took once it ran — nothing for a
 *  node that did not run (skipped, pinned, reused). */
export function nodeTime(record: { status: FlowNodeRunStatus; startedAt: string | null; durationMs: number | null }, now: number): string {
  if (record.status === "running") {
    const started = record.startedAt ? Date.parse(record.startedAt) : Number.NaN;
    return Number.isNaN(started) ? "" : formatElapsed(now - started);
  }
  if (record.durationMs === null || !(record.status === "success" || record.status === "error" || record.status === "canceled")) return "";
  return formatDuration(record.durationMs);
}

/** A moment, relative while it is recent and a date after. */
export function formatWhen(iso: string, language: string): string {
  const date = new Date(iso);
  const diff = (Date.now() - date.getTime()) / 1000;
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (diff < 45) return relative.format(-Math.round(diff), "second");
  if (diff < 3600) return relative.format(-Math.round(diff / 60), "minute");
  if (diff < 86_400) return relative.format(-Math.round(diff / 3600), "hour");
  return date.toLocaleString(language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const RUN_STATUS_KEY: Record<FlowRunStatus, TranslationKey> = {
  running: "flows.status.running",
  waiting: "flows.status.waiting",
  success: "flows.status.success",
  error: "flows.status.error",
  canceled: "flows.status.canceled",
  interrupted: "flows.status.interrupted",
};

export const NODE_STATUS_KEY: Record<FlowNodeRunStatus, TranslationKey> = {
  running: "flows.status.running",
  success: "flows.status.success",
  error: "flows.status.error",
  skipped: "flows.status.skipped",
  canceled: "flows.status.canceled",
  pinned: "flows.status.pinned",
  reused: "flows.status.reused",
  disabled: "flows.status.disabled",
};

/** The colour a status is drawn in. */
export function statusColor(status: FlowRunStatus | FlowNodeRunStatus): string {
  switch (status) {
    case "success":
      return "var(--cf-success)";
    case "error":
    case "interrupted":
      return "var(--cf-danger)";
    case "running":
      return "var(--cf-accent)";
    case "waiting":
      return "var(--cf-warning)";
    case "pinned":
    case "reused":
      return "var(--cf-blue)";
    default:
      return "var(--cf-text-faint)";
  }
}

export const MODE_KEY: Record<string, TranslationKey> = {
  manual: "flows.mode.manual",
  partial: "flows.mode.partial",
  step: "flows.mode.step",
};
