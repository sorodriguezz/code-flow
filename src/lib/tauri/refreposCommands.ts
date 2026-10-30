import { invoke } from "./invoke";
import { listen } from "@tauri-apps/api/event";
import type { KnowledgeStatus } from "./knowledgeCommands";

/** Reference repositories. Mirrors `src-tauri/src/commands/refrepos_cmd.rs` and `refrepos.rs`. */

export interface RefRepo {
  id: string;
  name: string;
  url: string;
  /** Empty until the first clone says which one the remote's default is. */
  branch: string;
  purpose: string;
  allWorkspaces: boolean;
  workspaces: string[];
  /** Only the local model searches it; a cloud engine never sees it. */
  localOnly: boolean;
  enabled: boolean;
  /** Update it every this many hours; 0 = only when asked. */
  autoPullHours: number;
  /** `provider:account` of the connected account a private clone authenticates with. */
  auth: string;
  head: string;
  pulledAt: number | null;
  sizeBytes: number;
  /** Why the last clone or update failed, worded as `remote::failure_message`; empty after one that worked. */
  lastError: string;
  createdAt: number;
  updatedAt: number;
}

export type RefRepoBusy = "cloning" | "pulling" | "switching" | "indexing";

export interface RefRepoView extends RefRepo {
  busy: RefRepoBusy | null;
  cloned: boolean;
  index: KnowledgeStatus | null;
}

export interface RemoteBranches {
  defaultBranch: string | null;
  branches: string[];
}

export interface NewRefRepo {
  url: string;
  name?: string;
  branch?: string;
  purpose?: string;
  allWorkspaces: boolean;
  workspaces: string[];
  localOnly: boolean;
  autoPullHours: number;
}

export interface RefRepoPatch {
  name?: string;
  purpose?: string;
  allWorkspaces?: boolean;
  workspaces?: string[];
  localOnly?: boolean;
  enabled?: boolean;
  autoPullHours?: number;
}

/** Settings that apply to every reference repository (`refrepos::KEY_*`). On unless set to `false`. */
export const REFREPOS_KNOWLEDGE_KEY = "refrepos_knowledge";
export const REFREPOS_REVIEW_KEY = "refrepos_review";

export const referenceReposList = () => invoke<RefRepoView[]>("reference_repos_list");
export const referenceReposBranches = (url: string) => invoke<RemoteBranches>("reference_repos_branches", { url });
export const referenceRepoAdd = (input: NewRefRepo) => invoke<RefRepo>("reference_repo_add", { input });
export const referenceRepoUpdate = (id: string, patch: RefRepoPatch) => invoke<RefRepo>("reference_repo_update", { id, patch });
export const referenceRepoPull = (id: string) => invoke<void>("reference_repo_pull", { id });
export const referenceRepoSetBranch = (id: string, branch: string) => invoke<void>("reference_repo_set_branch", { id, branch });
export const referenceRepoReindex = (id: string) => invoke<void>("reference_repo_reindex", { id });
export const referenceRepoRemove = (id: string) => invoke<void>("reference_repo_remove", { id });
export const referenceReposForWorkspace = (workspaceId: string) => invoke<RefRepo[]>("reference_repos_for_workspace", { workspaceId });

/** A reference repository changed — added, cloned, updated, busy or idle — by id. */
export const onReferenceReposChanged = (handler: (id: string) => void) => listen<string>("refrepos:changed", (e) => handler(e.payload));

/** The repository's name from its URL — `refrepos::name_from_url`, for the form's placeholder. */
export function nameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  return last;
}
