import { useWorkspaceStore } from "../state/workspaceStore";
import { DEFAULT_WORKSPACE_COLOR } from "./workspaceColors";

/**
 * "Open as project" for a submodule or a worktree: the folder joins the active workspace the way the
 * sidebar's "add a local repository" adds one, and becomes the open project.
 *
 * A folder the workspace already lists is switched to instead of added twice — two rows on one
 * working copy would mean two watchers and two sets of state over the same files. Paths are compared
 * without a trailing separator, which is the one way the same folder is routinely spelled twice.
 */

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  return norm(a) === norm(b);
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export async function openPathAsProject(path: string, remoteUrl: string | null, name?: string): Promise<void> {
  const workspace = useWorkspaceStore.getState();
  const workspaceId = workspace.activeWorkspaceId;
  if (!workspaceId) return;
  const existing = (workspace.projectsByWorkspace[workspaceId] ?? []).find((p) => samePath(p.local_path, path));
  if (existing) {
    workspace.setActiveProject(existing.id);
    return;
  }
  await workspace.addProject({
    workspace_id: workspaceId,
    name: name ?? basename(path),
    local_path: path,
    remote_url: remoteUrl,
    color: DEFAULT_WORKSPACE_COLOR,
    icon: "git-branch",
    ado_org: null,
    ado_project: null,
    ado_repo_id: null,
    github_owner: null,
    github_repo: null,
    github_host: null,
    gitlab_project: null,
    gitlab_host: null,
  });
}
