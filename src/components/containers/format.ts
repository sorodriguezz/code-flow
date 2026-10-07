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

export function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}%`;
}

