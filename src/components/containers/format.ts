/** Formatting for the Contenedores manager — pure, so it is tested without a DOM. */

/**
 * How long a container has been as it is, from the engine's own status line — "Up 3 hours", "Exited
 * (1) 2 hours ago" — briefly and in the app's language, with a failed exit's code. The creation date
 * would say how old the container is, which is not what "Detenido 26 h" should mean.
 */
export function statusSince(status: string, language: string): { since: string; failedCode: number | null } {
  const es = language === "es";
  const unit = (n: number, word: string): string => {
    const w = word.replace(/s$/, "");
    const map: Record<string, [string, string]> = { second: ["s", "s"], minute: ["min", "m"], hour: ["h", "h"], day: ["d", "d"], week: ["sem", "w"], month: ["mes", "mo"], year: ["año", "y"] };
    const [spanish, english] = map[w] ?? [w, w];
    return es ? `${n} ${spanish}` : `${n}${english}`;
  };
  const duration = (text: string): string => {
    const t = text.trim().toLowerCase();
    if (t.startsWith("less than a second")) return es ? "<1 s" : "<1s";
    const about = /^(?:about )?an? (second|minute|hour|day|week|month|year)/.exec(t);
    if (about) return unit(1, about[1]);
    const n = /^(\d+) (second|minute|hour|day|week|month|year)s?/.exec(t);
    return n ? unit(Number(n[1]), n[2]) : "";
  };
  const up = /^Up (.+?)(?: \(|$)/.exec(status);
  if (up) return { since: duration(up[1]), failedCode: null };
  const exited = /^Exited \((-?\d+)\) (.+?) ago/.exec(status);
  if (exited) {
    const code = Number(exited[1]);
    const ago = duration(exited[2]);
    return { since: ago ? (es ? `hace ${ago}` : `${ago} ago`) : "", failedCode: code !== 0 ? code : null };
  }
  return { since: "", failedCode: null };
}

/** Bytes the way Docker writes them — 8.3 MB, 1.2 GB. */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Bytes in powers of 1024, labelled KB/MB/GB as Docker Desktop's own graphs label them — what the
 * «Estadísticas» tab shows, so a container's 722 MB reads 722 MB here too and not 757 (user,
 * 2026-11-02, comparing the same container in another client).
 */
export function fmtBinaryBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}%`;
}


/**
 * Why a container stopped, from its exit code — what «Detenido» alone does not say. 137 is a
 * SIGKILL (`docker kill`, a stop that timed out, the kernel out of memory), 139 a segfault, 143 a
 * SIGTERM the process did not handle (a plain `docker stop`, so no fault).
 */
export type StopReason = "stopped" | "killed" | "crashed" | "failed";

export function stopReason(state: string, exitCode: number | null): StopReason | null {
  if (state === "dead") return "failed";
  if (state !== "exited") return null;
  if (exitCode === null || exitCode === 0 || exitCode === 143) return "stopped";
  if (exitCode === 137) return "killed";
  if (exitCode === 139) return "crashed";
  return "failed";
}

/** A container worth clearing away: it ended badly, died, or fails its health check. */
export function hasFailed(row: { state: string; health: string; exitCode: number | null }): boolean {
  if (row.health === "unhealthy") return true;
  const reason = stopReason(row.state, row.exitCode);
  return reason !== null && reason !== "stopped";
}

/** A build's or a step's length — 38s, 1m 12s, 0.4s. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}
