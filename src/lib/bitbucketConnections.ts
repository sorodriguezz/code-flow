import { getSetting, setSetting } from "./tauri/commands";
import { useVcsConnectionsStore } from "../state/vcsConnectionsStore";
import type { BitbucketConnection } from "../types/domain";

// The Bitbucket connections, one per workspace, persisted as a single app-setting JSON blob — the
// credentials themselves stay in the OS keychain, keyed by workspace. There is no host allowlist to
// keep, unlike GitLab's: bitbucket.org is the only host, and a remote on it names its workspace, so
// this list is what tells the linker whether there is a credential for that workspace.
//
// The key is `bitbucket_connections` and the shape is `[{ workspace, … }]` — the two facts the
// backend's `bitbucket_connected_workspaces` and the encrypted backup's credential roster read.
const KEY = "bitbucket_connections";

/** The one host Bitbucket Cloud serves repositories from. */
export const BITBUCKET_ORG = "bitbucket.org";

export async function loadBitbucketConnections(): Promise<BitbucketConnection[]> {
  const raw = await getSetting(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is BitbucketConnection => c && typeof c.workspace === "string" && c.workspace.trim() !== "")
      .map((c) => ({
        workspace: c.workspace,
        kind: c.kind === "access_token" ? "access_token" : "api_token",
        email: typeof c.email === "string" ? c.email : null,
        user: typeof c.user === "string" ? c.user : "",
      }));
  } catch {
    return [];
  }
}

export async function saveBitbucketConnections(connections: BitbucketConnection[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(connections));
  // The Pipelines tab is drawn from this list, so a save nobody hears about is a tab that doesn't
  // appear until the next launch — the same reason `saveGitlabConnections` refreshes.
  await useVcsConnectionsStore.getState().refresh();
}

/**
 * Reduces what was typed or pasted to a workspace slug: `example-workspace`, or any Bitbucket URL
 * that starts with one — `https://bitbucket.org/example-workspace/example-repo/src/main` included,
 * since the address bar is where people copy it from. Lower-case, as Bitbucket issues them and as
 * the backend keys the credential.
 */
export function normalizeBitbucketWorkspace(input: string): string {
  let value = input.trim();
  const url = value.match(/^(?:https?:\/\/)?(?:[^@/]+@)?(?:www\.)?bitbucket\.org\/([^/?#]+)/i);
  if (url) value = url[1];
  return value.replace(/^\/+|\/+$/g, "").toLowerCase();
}

/**
 * The page where the credential for `kind` is made. An API token is the account's, made at
 * Atlassian; an access token belongs to the workspace, and its page is under the workspace's
 * settings once one is typed.
 */
export function bitbucketTokenPageUrl(kind: BitbucketConnection["kind"], workspace: string): string {
  if (kind === "api_token") return "https://id.atlassian.com/manage-profile/security/api-tokens";
  const clean = normalizeBitbucketWorkspace(workspace);
  return clean
    ? `https://${BITBUCKET_ORG}/${encodeURIComponent(clean)}/workspace/settings/access-tokens`
    : `https://${BITBUCKET_ORG}`;
}
