/**
 * Editor tabs that are not files: a buffer the app wrote for the user to read, copy or save
 * somewhere — today, the explorer's "Generate Tree" — which exists nowhere on disk unless they save it.
 *
 * The editor keys its tabs by repo-relative path, and everything around a tab addresses the file by
 * it: the model URI, the watcher's re-read, the drafts journal, save. So a scratch tab is simply a
 * tab whose path **cannot** be a repo-relative one — it starts with `/`, which nothing listed from a
 * repository ever does. That one rule is also the backstop: every file command resolves its path
 * inside the repository and refuses one that starts at the filesystem root ("path escapes the
 * repository root"), so a code path that forgets to ask `isScratchPath` fails loudly instead of
 * writing a stray file into the project.
 *
 * Chosen over a real file in the OS temp directory because the editor has no way to open a file
 * outside the repository at all — every read and write is `(repoPath, relPath)` — and teaching it
 * one would have been a far larger change than teaching a handful of places to leave these alone:
 * it is never read from disk or re-read by the watcher, never journalled as a draft, its Save is a
 * Save As, and its tab offers no path to copy or reveal. Closing it is what makes it temporary.
 */

/** Whether a tab path names a scratch buffer rather than a file of the repository. */
export function isScratchPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith("/");
}

/** The tab path for a scratch buffer shown as `name`. */
export function scratchPath(name: string): string {
  return `/${name}`;
}

/** The name a scratch buffer is shown under — and offered under when it is saved. */
export function scratchName(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * A tab path for a new scratch buffer called `name` that no open tab holds yet: `tree-src.txt`,
 * then `tree-src 2.txt`, `tree-src 3.txt` — the counter before the extension, where the explorer's
 * own copies put it.
 */
export function freeScratchPath(name: string, taken: (path: string) => boolean): string {
  if (!taken(scratchPath(name))) return scratchPath(name);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = scratchPath(`${stem} ${n}${ext}`);
    if (!taken(candidate)) return candidate;
  }
}
