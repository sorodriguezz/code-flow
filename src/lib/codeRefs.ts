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
