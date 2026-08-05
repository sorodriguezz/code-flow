import type { SharedCollectionRow } from "../tauri/apiCommands";
import type { SupabaseProject } from "../../types/api";

/**
 * The Supabase projects this machine talks to, as one list.
 *
 * ## Why the list is derived rather than stored
 *
 * Settings hold the projects that were *set up here*. They are not the whole truth: a share carries
 * the project it lives on ([`api_shared_collections.project_url`]), and the two drift apart the
 * moment anyone points the panel at a new project — the collections created before it keep syncing
 * against the old one, quite correctly, because nothing about them moved. Under the single
 * `supabaseUrl` this replaced, that project simply vanished from the screen: still syncing, still
 * holding half the shares, and named nowhere. The list below is the union, so a connection cannot
 * be responsible for collections and be invisible at the same time.
 *
 * A connection that only appears because shares point at it is `saved: false` — it was never set up
 * here, or it was and the setting has since moved on. It is not an error state and it is not
 * cleanup bait: it is the honest answer to "what is this machine still connected to".
 *
 * ## Only what you host
 *
 * Shares you were *invited* into are excluded, and deliberately. They live on the project of
 * whoever invited you: you have no key to test, no schema to install and nothing to revoke, so a
 * row offering all three would be four controls that do nothing. It is also the same rule the share
 * list already follows — a member is told how they are connected, never where.
 */

/** What one connection is worth showing: where it points, whether it works, and what depends on it. */
export interface Connection {
  url: string;
  /** The last check passed — the project answered and the schema is there. */
  ready: boolean;
  /** When that check last passed, for "connected 4 minutes ago". */
  checkedAt: string;
  /** In `settings.supabaseProjects`, as opposed to only inferred from a share. */
  saved: boolean;
  /** Collections hosted here that sync against it. */
  shares: number;
}

/**
 * `https://abcd.supabase.co` → `abcd`.
 *
 * The project ref is what the Supabase dashboard calls a project and what a URL is recognisable by,
 * so it is the title of a connection. Anything that is not a `supabase.co` subdomain — a self-hosted
 * instance, a custom domain — keeps its whole host: there is no ref to extract, and truncating at
 * the first dot would title two connections on the same domain identically.
 */
export function projectRef(url: string): string {
  const host = projectHost(url);
  const ref = host.replace(/\.supabase\.(co|in)$/i, "");
  return ref === host ? host : ref;
}

/** `https://abcd.supabase.co/` → `abcd.supabase.co`. The full host, for the tooltip and the tag. */
export function projectHost(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Two URLs naming the same project. Compared on the host, the same way the credential store files
 * an anon key — `https://x.supabase.co` and `https://x.supabase.co/` must not become two rows with
 * one key between them.
 */
export function sameProject(a: string, b: string): boolean {
  return projectHost(a) === projectHost(b) && projectHost(a) !== "";
}

/**
 * Every project this machine hosts on: the ones set up here, plus the ones its own shares point at,
 * in that order.
 *
 * Saved first, in the order they were added — that is the order the panel's own actions apply to.
 * The inferred ones follow, sorted by ref so the list does not reshuffle itself every time a share
 * syncs.
 */
export function listConnections(
  projects: SupabaseProject[],
  shares: SharedCollectionRow[],
): Connection[] {
  const byHost = new Map<string, Connection>();

  const touch = (url: string, saved: boolean): Connection | null => {
    const host = projectHost(url);
    if (host === "") return null;
    const existing = byHost.get(host);
    if (existing) {
      // A saved project wins the URL it is stored under: that is the spelling the user typed, and
      // the one the edit field has to hand back to them.
      if (saved && !existing.saved) {
        existing.url = url.trim();
        existing.saved = true;
      }
      return existing;
    }
    const created: Connection = { url: url.trim(), ready: false, checkedAt: "", saved, shares: 0 };
    byHost.set(host, created);
    return created;
  };

  for (const project of projects) {
    const row = touch(project.url, true);
    if (!row) continue;
    row.ready = project.ready;
    row.checkedAt = project.checkedAt;
  }

  for (const share of shares) {
    if (share.role !== "owner") continue;
    const row = touch(share.project_url, false);
    if (row) row.shares += 1;
  }

  const rows = [...byHost.values()];
  return [
    ...rows.filter((row) => row.saved),
    ...rows
      .filter((row) => !row.saved)
      .sort((a, b) => projectRef(a.url).localeCompare(projectRef(b.url))),
  ];
}
