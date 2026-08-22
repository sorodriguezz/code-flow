import { create } from "zustand";
import { loadAdoConnectionsFromSettings } from "../lib/adoConnections";
import { loadGithubConnections } from "../lib/githubConnections";
import { loadGitlabConnections } from "../lib/gitlabConnections";
import { linkedHost, linkedProvider } from "../lib/linkedProvider";
import type { Project } from "../types/domain";

/**
 * Which VCS hosts the user has actually connected — reactively, in one place.
 *
 * Before this store, "is GitHub connected?" was answered by every consumer separately: an
 * `await loadGithubConnections()` in its own `useEffect`, parked in that component's local state
 * (see `PullRequestsSection` in `Sidebar.tsx`). That was fine while the only consumer was a panel
 * you had to unfold. The Pipelines tab is not that: it appears and disappears based on this
 * answer, so it needs the answer *reactively* and it needs it without an IPC round trip on every
 * render.
 *
 * The three lists are app-settings, not the keychain, and that distinction is load-bearing:
 * Settings writes the connection entry and the credential in the same operation and removes them
 * together, so the list is a faithful stand-in for the credential existing — and reading the
 * keychain here would pop a password dialog on every repository switch on macOS with an ad-hoc
 * signature. The backend takes the same care for the same reason; see the comment above
 * `connected_hosts` in `ado_cmd.rs`.
 *
 * What this store deliberately does **not** know is whether a saved token still works or carries
 * the right scopes. Nothing cheap can know that. A token without `Actions: Read` shows the tab
 * and fails inside it, with a message that says which permission is missing.
 */
interface VcsConnectionsState {
  /** Connected Azure DevOps organizations. */
  ado: string[];
  /** Connected GitHub hosts — github.com and/or Enterprise. */
  github: string[];
  /** Connected GitLab hosts — gitlab.com and/or self-managed. */
  gitlab: string[];
  /** False until the first load resolves. Consumers that gate UI on it should treat it as
   *  "nothing is connected yet" rather than guessing, so a tab never appears and then vanishes. */
  loaded: boolean;
  /** Reads all three lists. Called once at startup and again whenever a connection is added or
   *  removed — the connect modals and the settings screens both call it. Safe to call
   *  repeatedly; it is three `get_setting` reads against the local database. */
  refresh: () => Promise<void>;
}

export const useVcsConnectionsStore = create<VcsConnectionsState>((set) => ({
  ado: [],
  github: [],
  gitlab: [],
  loaded: false,

  refresh: async () => {
    // Settled rather than sequential: one provider's list failing to parse must not cost the
    // other two, since each gates a different repository's tab.
    const [ado, github, gitlab] = await Promise.all([
      loadAdoConnectionsFromSettings().catch(() => []),
      loadGithubConnections().catch(() => []),
      loadGitlabConnections().catch(() => []),
    ]);
    set({
      ado: ado.map((c) => c.org),
      github: github.map((c) => c.host),
      gitlab: gitlab.map((c) => c.host),
      loaded: true,
    });
  },
}));

/** The connection lists as a plain value, for the pure helpers below. */
export interface VcsConnections {
  ado: string[];
  github: string[];
  gitlab: string[];
}

/**
 * Whether the project's linked host has a saved connection.
 *
 * Host comparison is case-insensitive on both sides: `github.com` and `GitHub.com` are the same
 * host to every one of these APIs, and a hand-typed Enterprise hostname routinely differs in case
 * from the one the remote URL carried.
 */
export function isLinkedHostConnected(
  project: Project | null | undefined,
  connections: VcsConnections,
): boolean {
  const provider = linkedProvider(project);
  const host = linkedHost(project);
  if (!provider || !host) return false;
  const list =
    provider === "github" ? connections.github : provider === "gitlab" ? connections.gitlab : connections.ado;
  const needle = host.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === needle);
}

/**
 * The whole gate for the Pipelines tab, in one expression: the repository is linked to a host and
 * that host is connected.
 *
 * Kept as a pure function of values the caller already holds so the tab can be decided during
 * render with no effect, no await and no flicker. The authoritative answer still lives in the
 * backend's `pipeline_availability` — this is the same question asked cheaply enough to ask on
 * every render, and the view asks the expensive one when it opens.
 */
export function pipelinesAvailable(
  project: Project | null | undefined,
  connections: VcsConnections & { loaded: boolean },
): boolean {
  if (!connections.loaded) return false;
  return isLinkedHostConnected(project, connections);
}
