import { invoke } from "./invoke";
import type {
  EnvComposeLaunch,
  EnvCreateRequest,
  EnvDiscovery,
  EnvRepo,
  EnvSnapshot,
  EnvUpResult,
  EnvView,
  EnvWorktreeState,
} from "../../types/containersEnvs";

/** Contenedores › Entornos (`commands/containers_envs_cmd.rs`). */

export const containersEnvsRepos = () => invoke<EnvRepo[]>("containers_envs_repos");

export const containersEnvsDiscover = (projectId: string) => invoke<EnvDiscovery>("containers_envs_discover", { projectId });

export const containersEnvsList = () => invoke<EnvView[]>("containers_envs_list");

export const containersEnvsCreate = (request: EnvCreateRequest) => invoke<EnvView>("containers_envs_create", { request });

export const containersEnvsClone = (id: string, branch: string, base: string | null, offset: number | null) =>
  invoke<EnvView>("containers_envs_clone", { id, branch, base, offset });

export const containersEnvsPrepare = (id: string) => invoke<EnvComposeLaunch>("containers_envs_prepare", { id });

export const containersEnvsUp = (id: string, rebuild: boolean) => invoke<EnvUpResult>("containers_envs_up", { id, rebuild });

/** Only from the page's confirmation: the branch's new `initializeCommand`, approved word for word. */
export const containersEnvsApproveInit = (id: string, commands: string[]) => invoke<void>("containers_envs_approve_init", { id, commands });

export const containersEnvsStop = (id: string) => invoke<string>("containers_envs_stop", { id });

export const containersEnvsWorktreeState = (id: string) => invoke<EnvWorktreeState>("containers_envs_worktree_state", { id });

export const containersEnvsRemove = (id: string, volumes: boolean, removeWorktree: boolean, force: boolean) =>
  invoke<void>("containers_envs_remove", { id, volumes, removeWorktree, force });

export const containersEnvsSnapshot = (id: string, folder: string) => invoke<EnvSnapshot>("containers_envs_snapshot", { id, folder });

export const containersEnvsRestore = (id: string, folder: string) => invoke<string[]>("containers_envs_restore", { id, folder });
