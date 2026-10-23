import type { TranslationKey } from "../i18n/translations";
import type { ContainerRow, ContainerSummary } from "../../types/containers";
import type { PipelineRun } from "../../types/domain";
import { say } from "./say";

/**
 * What Codi says about a container or a pipeline it was asked about without being asked to open
 * anything — «¿por qué cayó el contenedor api?», «¿cómo va el último pipeline de api-pagos?» (user,
 * 2026-10-22). Read from what the engine and the host already report; no model, so it is said at
 * once. A log the reading cannot explain is offered to the AI (`container.explain`), asked first.
 */

/** «hace 12 minutos», «just now» — how long ago `iso` was, said. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at) || at <= 0) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return say("codi.say.agoNow");
  if (minutes < 90) return say("codi.say.agoMinutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 36) return say("codi.say.agoHours", { n: hours });
  return say("codi.say.agoDays", { n: Math.round(hours / 24) });
}

/** What an exit code says about how a container ended. */
export function exitMeaning(code: number | null, oomKilled: boolean | null): TranslationKey {
  if (oomKilled) return "codi.say.exit.oom";
  switch (code) {
    case 0:
      return "codi.say.exit.clean";
    case 137:
      return "codi.say.exit.killed";
    case 143:
      return "codi.say.exit.term";
    case 139:
      return "codi.say.exit.segfault";
    case 126:
    case 127:
      return "codi.say.exit.command";
    case 1:
    case 2:
      return "codi.say.exit.error";
    default:
      return "codi.say.exit.other";
  }
}

/** The last line of a log that reads like a failure — trimmed to be said, or `null`. */
export function lastErrorLine(log: string): string | null {
  const lines = log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/\b(error|exception|fatal|panic|failed|failure|refused|denied|traceback|cannot|could not|unable to|killed)\b/i.test(lines[index])) {
      // Timestamps and levels in front of the message say nothing aloud.
      const text = lines[index].replace(/^\S*\d{4}-\d{2}-\d{2}[T ]\S+\s*/, "").replace(/^\[?(error|err|fatal|warn|info)\]?:?\s*/i, "");
      return text.length > 140 ? `${text.slice(0, 137)}…` : text;
    }
  }
  return null;
}

export interface ContainerReading {
  /** What Codi says. */
  sentence: string;
  /** Worth the AI's reading of the log: it stopped badly, restarts, or fails its health check. */
  troubled: boolean;
}

/** A container's state said in a sentence or two: how and when it ended, and its last error. */
export function readContainer(row: ContainerRow, detail: ContainerSummary | null, log: string, now = Date.now()): ContainerReading {
  const name = row.name;
  const parts: string[] = [];
  let troubled = false;
  const restarts = detail?.restartCount ?? 0;
  if (row.state === "running") {
    parts.push(restarts > 0 ? say("codi.say.containerRestarts", { name, n: restarts }) : say("codi.say.containerRunning", { name }));
    troubled = restarts > 0;
  } else if (row.state === "restarting") {
    parts.push(say("codi.say.containerRestarting", { name }));
    troubled = true;
  } else {
    const code = detail?.exitCode ?? row.exitCode;
    const meaning = say(exitMeaning(code, detail?.oomKilled ?? null));
    const when = ago(detail?.finishedAt, now);
    parts.push(
      code === null
        ? say("codi.say.containerStopped", { name, ago: when })
        : say("codi.say.containerExited", { name, ago: when, code, meaning }),
    );
    troubled = code !== 0;
  }
  const health = detail?.health ?? row.health;
  if (health === "unhealthy") {
    parts.push(say("codi.say.containerUnhealthy"));
    troubled = true;
  }
  const line = troubled ? lastErrorLine(log) : null;
  if (line) parts.push(say("codi.say.containerLastError", { line }));
  return { sentence: parts.join(" ").replace(/\s+/g, " ").replace(/ ([,.:])/g, "$1").trim(), troubled };
}

const RUN_SAID: Record<PipelineRun["status"], TranslationKey> = {
  queued: "codi.say.pipelineQueued",
  running: "codi.say.pipelineRunning",
  success: "codi.say.pipelinePassed",
  warning: "codi.say.pipelineWarning",
  failed: "codi.say.pipelineFailed",
  cancelled: "codi.say.pipelineCancelled",
  skipped: "codi.say.pipelineSkipped",
};

/** The newest run of a repository's pipelines, said: which, on which branch, how it went, when. */
export function readRun(run: PipelineRun, repo: string, now = Date.now()): string {
  const when = run.status === "running" ? ago(run.started_at ?? run.created_at, now) : ago(run.finished_at ?? run.created_at, now);
  return say(RUN_SAID[run.status], { repo, name: run.name, branch: run.branch, ago: when }).replace(/\s+/g, " ").replace(/ ([,.])/g, "$1").trim();
}
