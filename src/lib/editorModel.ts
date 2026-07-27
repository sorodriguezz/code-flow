import type { Project } from "../types/domain";

/** URI scheme for the editor's own file models, kept distinct from anything Monaco creates. */
export const MODEL_SCHEME = "cf-editor";

/**
 * One Monaco model per open file (instead of one shared model whose text gets swapped) so each
 * tab keeps its own undo history, cursor and scroll position. Namespaced by project so two repos
 * with a `src/main.ts` never collide on the same model.
 *
 * Two editor groups showing the same file resolve to the same URI on purpose — that is what makes
 * an edit on the left appear on the right.
 *
 * Lives here rather than beside the editor components because "go to definition" has to work in
 * the other direction, turning a model URI back into a repo path, and it is registered from the
 * Monaco bootstrap — long before any component is mounted.
 */
export function modelPathFor(project: Project, relPath: string): string {
  // Encoded **per segment**, keeping the separators as real path separators. Encoding the whole
  // relative path in one go turns its slashes into `%2F`, and `Uri.parse` decodes those straight
  // back — so the URI that came out the other side had more segments than went in, and reading
  // "the second segment" as the file path yielded the top-level folder instead. That's what
  // opened `lib` as a file.
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `${MODEL_SCHEME}:/${encodeURIComponent(project.id)}/${encoded}`;
}

/** The repo-relative path a model URI refers to, or `null` for anything that isn't one of ours
 * (a diff view's model, Monaco's own scratch buffers) or belongs to another project.
 *
 * Takes everything after the first segment rather than splitting into fixed parts, so a nested
 * path survives intact. No decoding here: `Uri.parse` has already done it. */
export function relPathFromModelUri(uri: { scheme: string; path: string }, projectId: string): string | null {
  if (uri.scheme !== MODEL_SCHEME) return null;
  const raw = uri.path.replace(/^\/+/, "");
  const slash = raw.indexOf("/");
  if (slash < 0) return null;
  if (raw.slice(0, slash) !== projectId) return null;
  return raw.slice(slash + 1) || null;
}
