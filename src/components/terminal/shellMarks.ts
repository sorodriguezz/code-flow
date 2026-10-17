/**
 * The marks a shell with CodeFlow's integration prints around each command (see
 * `src-tauri/src/shell_integration.rs`), read back:
 *
 * - `OSC 133 ; A` — a prompt is about to be drawn.
 * - `OSC 633 ; E ; <base64>` — the command line about to run.
 * - `OSC 133 ; C` — its output starts.
 * - `OSC 133 ; D ; <code>` — it finished, with that exit code.
 * - `OSC 7 ; file://host/path` — the folder the shell is in now.
 *
 * Pure, so the parsing is tested without a terminal; the pane owns what is done with each.
 */
export type ShellMark =
  | { kind: "prompt" }
  | { kind: "start" }
  | { kind: "end"; exit: number | null };

/** The payload of an `OSC 133` sequence, or `null` for one this app does not use. */
export function parseOsc133(data: string): ShellMark | null {
  const [mark, code] = data.split(";");
  if (mark === "A") return { kind: "prompt" };
  if (mark === "C") return { kind: "start" };
  if (mark === "D") {
    const exit = code === undefined || code === "" ? null : Number(code);
    return { kind: "end", exit: Number.isFinite(exit) ? exit : null };
  }
  return null;
}

/** The command line in an `OSC 633 ; E` payload, or `null`. */
export function parseOsc633(data: string): string | null {
  if (!data.startsWith("E;")) return null;
  try {
    const bytes = Uint8Array.from(atob(data.slice(2).trim()), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The folder in an `OSC 7` payload: `file://host/path`, percent-decoded. Windows paths arrive as
 * `file:///C:/x` and come back as `C:\x`, the way the rest of the app spells them there.
 */
export function parseOsc7(data: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    path = match[1];
  }
  if (/^\/[A-Za-z]:\//.test(path)) return path.slice(1).replace(/\//g, "\\");
  return path;
}

/** What a command took, for a notification: `8 s`, `2 min 5 s`, `1 h 3 min`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
