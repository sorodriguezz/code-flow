/**
 * The subjects last asked of a repository, so the second diagram of the same thing is a click.
 *
 * Per repository *and* type — "POST /orders" is a sequence's answer, not a lifecycle's — and a handful
 * only: this is a shortcut, not a history. Kept in the webview's own storage, which is the right size
 * of promise: a convenience that may come back empty, never something a diagram depends on.
 */

const KEY = "cf-archify-recent";
const KEPT = 5;

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(storage: Store | null): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** The subjects asked of `projectId` for a diagram of `kind`, the latest first. */
export function recentTopics(projectId: string, kind: string, storage: Store | null = defaultStorage()): string[] {
  const list = read(storage)[`${projectId}:${kind}`];
  return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string").slice(0, KEPT) : [];
}

/** Remembers `topic`, moving it to the front if it was already there. An empty one is not a subject. */
export function rememberTopic(projectId: string, kind: string, topic: string, storage: Store | null = defaultStorage()): void {
  const clean = topic.trim();
  if (!clean || !storage) return;
  const all = read(storage);
  const key = `${projectId}:${kind}`;
  all[key] = [clean, ...(all[key] ?? []).filter((t) => t !== clean)].slice(0, KEPT);
  try {
    storage.setItem(KEY, JSON.stringify(all));
  } catch {
    // A full or refused store loses a shortcut, nothing else.
  }
}
