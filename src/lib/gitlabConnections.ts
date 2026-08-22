import { getSetting, setSetting } from "./tauri/commands";
import { useVcsConnectionsStore } from "../state/vcsConnectionsStore";
import type { GitlabConnection } from "../types/domain";

// One list of GitLab connections (gitlab.com and/or self-managed instances) persisted as a single
// app-setting JSON blob — the tokens themselves stay in the OS keychain, keyed per host. This is
// the allowlist the backend reads to know which hosts are safe to auto-detect as GitLab, and it
// matters more here than it does for GitHub: a GitLab project path has no fixed number of
// segments, so without the allowlist any self-hosted git server would look like a GitLab remote.
//
// The key is `gitlab_connections` and the shape is `[{ host }]` — the same two facts the backend's
// `gitlab_connected_hosts` and the encrypted backup's credential roster are written against.
const KEY = "gitlab_connections";

/** The canonical public host — the default a new connection is offered under. */
export const GITLAB_COM = "gitlab.com";

export async function loadGitlabConnections(): Promise<GitlabConnection[]> {
  const raw = await getSetting(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is GitlabConnection => c && typeof c.host === "string");
  } catch {
    return [];
  }
}

export async function saveGitlabConnections(connections: GitlabConnection[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(connections));
  // The Pipelines tab is drawn from this list, so a save that nobody hears about is a tab that
  // does not appear until the next launch. Notified here rather than at the six call sites
  // (three settings forms, add and remove in each) because this is the one place they share.
  await useVcsConnectionsStore.getState().refresh();
}

/**
 * Reduces a pasted host or URL to a bare lowercase hostname.
 *
 * Self-managed GitLab is reached by URL far more often than GitHub Enterprise is — it is what the
 * instance's own pages, its clone box and every link in its e-mails show — so this is the field
 * most likely to arrive as `https://git.acme.com/` rather than as a hostname.
 */
export function normalizeGitlabHost(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return GITLAB_COM;
  const match = trimmed.match(/^https?:\/\/([^/]+)/i);
  return (match ? match[1] : trimmed).toLowerCase();
}

/** A friendly label for a host — "GitLab.com" for the public host, the bare hostname otherwise. */
export function gitlabHostLabel(host: string): string {
  return host.toLowerCase() === GITLAB_COM ? "GitLab.com" : host;
}
