import { invoke } from "./invoke";

/**
 * «Entorno» — a repository's env files (`repo_env` in Rust). A scan carries keys and whether each
 * is empty or a Llavero reference, **never a value**; `repoEnvReveal` returns one value, and is only
 * called from a click on that one cell.
 */

export type EnvFormat = "dotenv" | "appsettings" | "launchSettings" | "compose" | "properties" | "yaml" | "json";
export type EnvFamily = "dotenv" | "dotnet" | "launch" | "compose" | "spring" | "yaml" | "json";

export interface EnvEntry {
  key: string;
  line: number;
  empty: boolean;
  /** The Llavero item id when the file holds a reference rather than a value. */
  reference: string | null;
  /** Why it cannot be moved into the Llavero (an i18n key), or `null` when it can. */
  refused: string | null;
}

export interface EnvSource {
  /** `path`, or `path#sub`. */
  id: string;
  path: string;
  /** The launch profile or Compose service. */
  sub: string | null;
  format: EnvFormat;
  group: string;
  dir: string;
  family: EnvFamily;
  environment: string;
  environmentAuto: string;
  example: boolean;
  entries: EnvEntry[];
}

export interface EnvFile {
  path: string;
  format: EnvFormat;
  manual: boolean;
  variables: number;
  error: string | null;
}

export interface EnvEffectiveConfig {
  patterns: string[];
  exclude: string[];
  files: string[];
  ignore: string[];
  environments: Record<string, string>;
}

export interface EnvScan {
  files: EnvFile[];
  sources: EnvSource[];
  config: EnvEffectiveConfig;
  invalidPatterns: string[];
  truncated: boolean;
}

export type EnvReadKind = "env" | "dotnet" | "dotnetSection" | "spring";

export interface EnvRead {
  key: string;
  kind: EnvReadKind;
  hasDefault: boolean;
  places: { path: string; line: number }[];
  count: number;
}

export interface EnvUsage {
  reads: EnvRead[];
  filesScanned: number;
  truncated: boolean;
}

/** `repo_env_patterns` — the app's defaults. A field left out is the shipped list. */
export interface EnvGlobalConfig {
  patterns?: string[] | null;
  exclude?: string[] | null;
}

/** `repo_env_patterns:<projectId>` — one repository's changes on top of the defaults. */
export interface EnvRepoConfig {
  add: string[];
  remove: string[];
  files: string[];
  ignore: string[];
  environments: Record<string, string>;
}

export interface EnvServiceFile {
  path: string;
  format: EnvFormat;
  loads: boolean;
  variables: number;
  references: string[];
}

export interface EnvServiceFiles {
  projectId: string | null;
  folder: string;
  files: EnvServiceFile[];
}

/** What a move reports when the Llavero is locked — `keyvault::crypto::CODE_LOCKED`. */
export const VAULT_LOCKED = "cf-keyvault/locked";

export const repoEnvDefaults = () => invoke<{ patterns: string[]; exclude: string[] }>("repo_env_defaults");
export const repoEnvScan = (projectId: string | null, repoPath: string) => invoke<EnvScan>("repo_env_scan", { projectId, repoPath });
export const repoEnvUsage = (projectId: string | null, repoPath: string) => invoke<EnvUsage>("repo_env_usage", { projectId, repoPath });
export const repoEnvReveal = (repoPath: string, sourceId: string, key: string) =>
  invoke<string>("repo_env_reveal", { repoPath, sourceId, key });
export const repoEnvMoveToVault = (args: { projectId: string; repoPath: string; sourceId: string; key: string; note: string }) =>
  invoke<{ itemId: string; title: string }>("repo_env_move_to_vault", args);
export const repoEnvAddKey = (repoPath: string, path: string, key: string) => invoke<void>("repo_env_add_key", { repoPath, path, key });
export const repoEnvServiceFiles = (serviceId: string) => invoke<EnvServiceFiles>("repo_env_service_files", { serviceId });
