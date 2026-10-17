/**
 * The file references a command prints, found in one line of terminal text — what turns
 * `src/foo.ts:42:7` in a `tsc` error, `--> src/main.rs:10:5` in a `cargo` one or `at f (/x/y.js:3:9)`
 * in a stack trace into a ⌘-click that opens the file at that line.
 *
 * A candidate is only a *candidate*: the pane asks the backend whether it exists before drawing it
 * as a link, so `1:2` in a timestamp or `a/b` in prose costs one look-up and never a false link.
 */
export interface FileRef {
  /** Where in the line the link starts and ends, in characters (end exclusive). */
  start: number;
  end: number;
  path: string;
  line?: number;
  column?: number;
}

/**
 * A path: absolute (`/x`, `~/x`, `C:\x`, `C:/x`), relative with a separator (`src/x.ts`, `./x`,
 * `..\x`), or a bare `name.ext`. Then `:line[:col]`, or the `(line,col)` MSBuild/tsc use, or
 * `", line N"` Python uses.
 */
const PATH = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+\-]+[\\/])*[\w@+\-][\w.@+\-]*\.[A-Za-z0-9]{1,10}`;
const DIR_PATH = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])(?:[\w.@+\-]+[\\/])*[\w.@+\-]+`;
const REF = new RegExp(
  String.raw`(${PATH}|${DIR_PATH})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|",\s*line\s+(\d+))?`,
  "g",
);

/** Every file reference in `text`, left to right. */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  // A URL is the web-links addon's, not ours — nothing inside one is a file.
  const urls = Array.from(text.matchAll(/\b[a-z][\w+.-]*:\/\/\S+/gi), (m) => [m.index, m.index + m[0].length]);
  REF.lastIndex = 0;
  for (let match = REF.exec(text); match; match = REF.exec(text)) {
    let path = match[1];
    const start = match.index;
    if (urls.some(([from, to]) => start < to && start + match![0].length > from)) continue;
    if (path.startsWith("//")) continue;
    const lineNo = Number(match[2] ?? match[4] ?? match[6]) || undefined;
    const column = Number(match[3] ?? match[5]) || undefined;
    // Trailing dots end sentences: `see src/x.ts.`
    while (path.endsWith(".")) path = path.slice(0, -1);
    if (!path || /^\d+(\.\d+)*$/.test(path)) continue;
    // A version or a decimal (`1.2.3`, `v0.9`) has no separator and starts with a digit or `v<digit>`.
    if (!/[\\/]/.test(path) && /^v?\d/.test(path)) continue;
    const end = lineNo ? match.index + match[0].length : start + path.length;
    out.push({ start, end, path, line: lineNo, column });
  }
  return out;
}

/**
 * `path` resolved against the folder the shell is in. `~` is `home`; Windows paths keep their
 * drive; separators are left as typed, the backend takes either.
 */
export function resolveRef(path: string, cwd: string, home: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\")) return path;
  if (path.startsWith("~/") || path.startsWith("~\\")) return joinPath(home, path.slice(2));
  return joinPath(cwd, path);
}

function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const parts = base.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const part of rel.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(part);
  }
  return parts.join(sep) || sep;
}

/**
 * A path typed into a shell as one word. Bare when nothing in it needs quoting; otherwise in
 * single quotes, which every shell the dock opens reads literally — POSIX shells and PowerShell
 * both. `cmd` has no single quotes, so on Windows a path with a space gets double ones, which both
 * `cmd` and PowerShell take and Git Bash does too.
 */
export function quotePath(path: string, windows: boolean): string {
  if (/^[\w@%+=:,./\\-]+$/.test(path)) return path;
  if (windows) return `"${path.replace(/"/g, '""')}"`;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
