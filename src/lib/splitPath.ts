/**
 * A repo-relative path split into the folders leading to it and its own name, so a row can draw the
 * two differently: the name is what the row is read for, the folders are what tell two files called
 * `index.ts` apart.
 *
 * `dir` carries no trailing separator — the caller decides whether the folders read as a prefix
 * (`src/lib/` before the name) or as a trailing location (the name, then `src/lib` beside it), and
 * a slash baked in here would be wrong for one of them.
 *
 * Repo-relative, forward-slash paths only, which is what both sources produce: git reports its
 * status that way on every platform, and `fsops::FileEntry::path` normalises the tree's. A path
 * with a leading slash would lose it here, and there is no such path to lose.
 */
export function splitPath(path: string): { dir: string; name: string } {
  // A trailing slash belongs to the name, not to the folders. Git reports an unregistered nested
  // repository as a single entry ending in one — `vendor/thing/` — and splitting on that last slash
  // would leave the name empty and the row with nothing to read. The slash stays on `thing/`, where
  // it is the thing that says this entry is a directory.
  const end = path.endsWith("/") ? path.length - 1 : path.length;
  const i = path.lastIndexOf("/", end - 1);
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}
