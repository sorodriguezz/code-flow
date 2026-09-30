/**
 * `path` as a folder inside `root`: `""` for the root itself, `"apps/api"` for one below it, and
 * `null` when it is not inside at all.
 *
 * What a folder picker hands back is an absolute path in the platform's own spelling, and what a
 * form wants is the part below a repository — the service editor's "Subfolder", the terminal row's
 * "where". The two sides disagree about separators on Windows (the dialog says `C:\repo\api`, a
 * stored path may say `C:/repo`), so both are compared slash-normalised, and case-insensitively when
 * either is a drive path: `C:\Repo` and `c:\repo` are one folder there.
 *
 * A prefix is not enough — `/repo-old` starts with `/repo` — so the match must end at a separator.
 * The result always uses `/`, which is what the rest of the app stores for repo-relative paths.
 */
export function relativeInside(root: string, path: string): string | null {
  const tidy = (value: string) => value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const base = tidy(root);
  const target = tidy(path);
  if (!base || !target) return null;
  const drive = /^[A-Za-z]:(\/|$)/;
  const fold = drive.test(base) || drive.test(target) || base.startsWith("//");
  const same = (a: string, b: string) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(target, base)) return "";
  const head = target.slice(0, base.length);
  if (same(head, base) && target.charAt(base.length) === "/") return target.slice(base.length + 1);
  return null;
}

/** The last folder of `path`, whatever its separators — what a row can say about a folder that is
 *  not inside the repository it belongs to. */
export function folderName(path: string): string {
  const tidy = path.trim().replace(/[\\/]+$/, "");
  return tidy.split(/[\\/]/).pop() || tidy;
}
