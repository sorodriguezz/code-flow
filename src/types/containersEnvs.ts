/**
 * Contenedores › Entornos — one environment per branch: its own worktree, Compose project and host
 * ports. Mirrors `src-tauri/src/containers/envs` and `commands/containers_envs_cmd.rs`.
 */

export type EnvConfig =
  | { kind: "compose"; dir: string; files: string[] }
  | {
      kind: "devcontainer";
      config: string;
      mode: "cli" | "direct";
      /** Run directly although the file asks for `features` — the user's explicit choice. */
      withoutFeatures?: boolean;
      /** The `initializeCommand` the user saw and agreed to run on this computer, word for word. */
      approvedInit?: string[];
    };

export interface EnvPortBinding {
  service: string;
  target: number;
  protocol: string;
  hostIp: string;
  /** What the repository's files publish, before the offset. */
  base: number | null;
  /** What this environment publishes (the first of a range). */
  host: number | null;
  hostEnd: number | null;
}

export interface EnvWarning {
  /** `sharedVolume`, `sharedNetwork`, `hostNetwork`, `unsupported`, `noPorts`, `cliNoOffset` (older
   *  environments), `hardening` (allowed by the policy but weakens isolation), `dropped` (a runArgs
   *  flag the environment sets itself), `withoutFeatures`. */
  code: string;
  subject: string;
}

export interface EnvService {
  id: string;
  name: string;
  state: string;
  health: string;
}

export type EnvStatus = "running" | "partial" | "stopped" | "absent" | "unknown";

export interface EnvView {
  id: string;
  projectId: string;
  repoName: string;
  repoPath: string;
  branch: string;
  base: string;
  worktreePath: string;
  worktreeCreated: boolean;
  worktreeExists: boolean;
  composeProject: string;
  portOffset: number;
  runtime: string;
  context: string | null;
  config: EnvConfig;
  ports: EnvPortBinding[];
  warnings: EnvWarning[];
  copiedFiles: string[];
  createdAt: string;
  updatedAt: string;
  status: EnvStatus;
  services: EnvService[];
  problem: string | null;
}

export interface EnvRepo {
  id: string;
  name: string;
  path: string;
  workspace: string;
}

export interface EnvProposal {
  id: string;
  kind: "compose" | "devcontainer" | "devcontainerCli";
  label: string;
  config: EnvConfig;
  detail: string;
  ports: number[];
  recommended: boolean;
  available: boolean;
  /** `noCli`, `unknownSource`, `invalid`. */
  reason: string | null;
  problem: string | null;
  /** Keys of devcontainer.json present that this way of running leaves out. */
  unsupported: string[];
  /** Keys of devcontainer.json present that this way of running applies. */
  honoured: string[];
  /** `features` ids — installed only by the Dev Containers CLI. */
  features: string[];
  /** `initializeCommand`, as it will run on this computer. */
  initialize: string[];
  offsetApplies: boolean;
  suggestedOffset: number;
}

export interface EnvDiscovery {
  repoName: string;
  repoPath: string;
  proposals: EnvProposal[];
  devcontainerCli: boolean;
}

export interface EnvCreateRequest {
  projectId: string;
  branch: string;
  base?: string | null;
  config: EnvConfig;
  offset?: number | null;
  runtime: string;
  context?: string | null;
}

export interface EnvComposeLaunch {
  project: string;
  projectDir: string;
  configFiles: string;
  ports: EnvPortBinding[];
  warnings: EnvWarning[];
}

export interface EnvUpResult {
  log: string;
  ports: EnvPortBinding[];
  warnings: EnvWarning[];
}

export interface EnvWorktreeState {
  exists: boolean;
  dirty: boolean;
  created: boolean;
}

export interface EnvSnapshot {
  folder: string;
  volumes: string[];
  bytes: number;
}
