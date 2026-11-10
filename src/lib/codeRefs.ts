/**
 * `path/to/file.ts:42` written as inline code in an answer, marked so a click can open it.
 *
 * Only a path-shaped token qualifies — segments of word characters, dots and dashes, a short extension,
 * an optional `:line` (and `:col`) — so `foo.bar()` or `a/b` never become links. Code blocks
 * (`<pre>`) are left alone: a block that mentions a path is showing code, not pointing at it.
 */
const INLINE = /<code>([\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][A-Za-z0-9]{0,5})(?::(\d+)(?::\d+)?)?<\/code>/g;

/** `html` with each inline path reference carrying `data-ref` (the path) and `data-line`. */
export function markCodeRefs(html: string): string {
  // Split around <pre>…</pre> so nothing inside a block is touched.
  return html
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(INLINE, (_all, path: string, line?: string) => `<code class="cf-code-ref" data-ref="${path}"${line ? ` data-line="${line}"` : ""}>${path}${line ? `:${line}` : ""}</code>`),
    )
    .join("");
}

/**
 * The full path an inline reference points at, picked from the files the turn read or changed.
 *
 * Answers name files short (`trakcare.dto.ts`, `dto/trakcare.dto.ts`); the turn's trace holds the
 * paths the tools were actually given. A reference matches a path it is a whole-segment suffix of,
 * so `a.ts` never matches `data.ts`. No match gives `null` rather than a guess joined to the repo
 * root: a bare name could live in any folder, and a tooltip with a wrong path is worse than none.
 */
export function resolveCodeRef(ref: string, paths: readonly string[], repoRoot?: string | null): string | null {
  const want = ref.replace(/\\/g, "/");
  for (const path of paths) {
    const norm = path.replace(/\\/g, "/");
    if (norm === want || norm.endsWith(`/${want}`)) return path;
  }
  // A reference with a folder in it (`src/lib/a.ts`) is written relative to the repository — that is
  // how answers name its files — so it is the repository's file even if this turn never opened it.
  // A bare name (`a.ts`) still is not guessed: it could live in any folder.
  if (repoRoot && want.includes("/") && !want.startsWith("/")) {
    return `${repoRoot.replace(/[\\/]+$/, "")}/${want.replace(/^\.\//, "")}`;
  }
  return null;
}

/** A quoted string or a bare word of a command line, quotes dropped. */
const TOKEN = /"([^"]+)"|'([^']+)'|(\S+)/g;

/**
 * Every path a turn's tools were given — files read or edited, and the ones inside a command or a
 * search (`sqlite3 "$HOME/…/codeflow.db"`, `cat src/a.ts`) — so a file the answer names after
 * touching it through the shell still gets its full path on hover. `$HOME` is shown as `~`.
 */
export function pathsFromToolArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    for (const match of arg.matchAll(TOKEN)) {
      const token = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^\$HOME(?=\/)|^\$\{HOME\}(?=\/)/, "~").replace(/[;,)]+$/, "");
      if (token.endsWith("…") || !/[\\/]/.test(token) || /^[a-z]+:\/\//i.test(token)) continue;
      if (!out.includes(token)) out.push(token);
    }
  }
  return out;
}
