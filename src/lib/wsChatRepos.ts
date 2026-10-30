/**
 * What the workspace chat's «n repos» chip says about each repository, from the structured list
 * `workspace_chat_snapshot` returns (`repos`). A project the snapshot does not list yet (it has not
 * loaded, or the project was added since) is `ok`: the chip must not cry wolf over what it has not
 * been told.
 */

import type { WorkspaceChatRepo } from "./tauri/chatCommands";

/** `missing`: the folder is gone. `notRepo`: a plain folder — usable, but with no restore point. */
export type RepoState = "ok" | "missing" | "notRepo";

export interface RepoRow {
  id: string;
  name: string;
  path: string;
  branch: string;
  state: RepoState;
}

export function repoRows(
  projects: readonly { id: string; name: string; local_path: string }[],
  snapshot: readonly WorkspaceChatRepo[] | null | undefined,
): RepoRow[] {
  const byId = new Map((snapshot ?? []).map((repo) => [repo.id, repo]));
  return projects.map((project) => {
    const found = byId.get(project.id);
    const state: RepoState = !found ? "ok" : !found.onDisk ? "missing" : !found.isRepo ? "notRepo" : "ok";
    return { id: project.id, name: project.name, path: project.local_path, branch: found?.branch ?? "", state };
  });
}

/** How many of the rows are healthy repositories. */
export function reposReady(rows: readonly RepoRow[]): number {
  return rows.filter((row) => row.state === "ok").length;
}
