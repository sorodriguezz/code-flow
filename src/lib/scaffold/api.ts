import { invoke } from "@tauri-apps/api/core";

/**
 * The project initializer's bindings to `src-tauri/src/scaffold/`. Kept beside the catalogue rather
 * than in `lib/tauri/commands.ts` for the reason `lib/npm.ts` is: they are one feature's transport,
 * and nothing outside it calls them.
 */

export type ScaffoldPlatform = "macos" | "windows" | "linux";

export interface ToolStatus {
  id: string;
  found: boolean;
  /** `major.minor.patch`, normalised by the backend. */
  version: string | null;
  path: string | null;
  /** The program's own first line, or why it could not run. */
  detail: string;
}

export interface Detection {
  tools: ToolStatus[];
  platform: ScaffoldPlatform;
}

export type VersionSource =
  | { kind: "npm"; package: string }
  | { kind: "pypi"; package: string }
  | { kind: "packagist"; package: string }
  /** An endoflife.date product: `nodejs`, `python`, `php`, `go`, `eclipse-temurin`, `dotnet`. */
  | { kind: "runtime"; product: string };

export interface VersionLine {
  /** The newest release of the line, exact. */
  version: string;
  /** `22`, `5.2`, `3.13` — what an installer is asked for. */
  line: string;
  channel: "latest" | "lts" | "next" | "";
  /** What it needs underneath, verbatim: npm `engines.node`, PyPI `requires-python`, Composer `php`. */
  requires: string | null;
  eol: boolean;
}

export interface SpringChoice {
  id: string;
  name: string;
}

export interface SpringDependency {
  id: string;
  name: string;
  description: string;
  versionRange: string;
}

export interface SpringMeta {
  bootVersions: SpringChoice[];
  bootDefault: string;
  javaVersions: SpringChoice[];
  javaDefault: string;
  languages: SpringChoice[];
  languageDefault: string;
  types: SpringChoice[];
  typeDefault: string;
  packagings: SpringChoice[];
  packagingDefault: string;
  groupDefault: string;
  dependencies: { name: string; values: SpringDependency[] }[];
}

export interface SpringRequest {
  type: string;
  language: string;
  bootVersion: string;
  javaVersion: string;
  packaging: string;
  groupId: string;
  artifactId: string;
  name: string;
  description: string;
  packageName: string;
  dependencies: string[];
}

export interface DestCheck {
  path: string;
  problem: string | null;
  parentExists: boolean;
}

export interface FileSpec {
  /** Relative to the project root, `/`-separated. */
  path: string;
  content: string;
}

export const detectTools = (ids: string[], refresh: boolean) =>
  invoke<Detection>("scaffold_detect_tools", { ids, refresh });

export const fetchVersions = (source: VersionSource) => invoke<VersionLine[]>("scaffold_versions", { source });

export const springMetadata = () => invoke<SpringMeta>("scaffold_spring_metadata");

export const springGenerate = (request: SpringRequest, parent: string, folder: string) =>
  invoke<string>("scaffold_spring_generate", { request, parent, folder });

export const checkDest = (parent: string, name: string) => invoke<DestCheck>("scaffold_check_dest", { parent, name });

export const writeFiles = (root: string, files: FileSpec[]) =>
  invoke<void>("scaffold_write_files", { root, files });

/** Starts `script` in a pty from `cwd`; resolves with the terminal session id. */
export const runScript = (cwd: string, script: string) => invoke<string>("scaffold_run", { cwd, script });
