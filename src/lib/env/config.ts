/**
 * The «Archivos detectados» settings — pure edits over the two rows `repo_env::config` reads:
 * `repo_env_patterns` (the app's defaults) and `repo_env_patterns:<projectId>` (one repository's
 * changes). A repository stores *changes*, not a copy of the list, so a pattern added to the
 * defaults later still reaches it.
 */

import type { EnvGlobalConfig, EnvRepoConfig } from "../tauri/envCommands";

export const GLOBAL_KEY = "repo_env_patterns";
export const repoKey = (projectId: string) => `${GLOBAL_KEY}:${projectId}`;

export const emptyRepoConfig = (): EnvRepoConfig => ({ add: [], remove: [], files: [], ignore: [], environments: {} });

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** A malformed row is no changes — the same rule as the Rust side. */
export function parseRepoConfig(raw: string | null | undefined): EnvRepoConfig {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<EnvRepoConfig>) : {};
    const environments: Record<string, string> = {};
    if (parsed.environments && typeof parsed.environments === "object")
      for (const [k, v] of Object.entries(parsed.environments)) if (typeof v === "string") environments[k] = v;
    return { add: strings(parsed.add), remove: strings(parsed.remove), files: strings(parsed.files), ignore: strings(parsed.ignore), environments };
  } catch {
    return emptyRepoConfig();
  }
}

export function parseGlobalConfig(raw: string | null | undefined): EnvGlobalConfig {
  try {
    const parsed = raw ? (JSON.parse(raw) as EnvGlobalConfig) : {};
    return {
      patterns: Array.isArray(parsed.patterns) ? strings(parsed.patterns) : null,
      exclude: Array.isArray(parsed.exclude) ? strings(parsed.exclude) : null,
    };
  } catch {
    return { patterns: null, exclude: null };
  }
}

/** A relative path as Rust compares it: forward slashes, no leading `./` or `/`. */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

const without = (list: string[], value: string) => list.filter((v) => v !== value);
const withValue = (list: string[], value: string) => (list.includes(value) ? list : [...list, value]);

/** Adds a pattern to a repository: un-removes a default, or adds a new one. */
export function addPattern(config: EnvRepoConfig, pattern: string, defaults: string[]): EnvRepoConfig {
  const p = pattern.trim();
  if (!p) return config;
  if (config.remove.includes(p)) return { ...config, remove: without(config.remove, p) };
  if (defaults.includes(p)) return config;
  return { ...config, add: withValue(config.add, p) };
}

/** Removes a pattern from a repository: drops its own, or marks a default as not read here. */
export function removePattern(config: EnvRepoConfig, pattern: string): EnvRepoConfig {
  if (config.add.includes(pattern)) return { ...config, add: without(config.add, pattern) };
  return { ...config, remove: withValue(config.remove, pattern) };
}

export function addFile(config: EnvRepoConfig, path: string): EnvRepoConfig {
  const p = normalizePath(path);
  if (!p) return config;
  return { ...config, files: withValue(config.files, p), ignore: without(config.ignore, p) };
}

export function ignoreFile(config: EnvRepoConfig, path: string): EnvRepoConfig {
  const p = normalizePath(path);
  return { ...config, ignore: withValue(config.ignore, p), files: without(config.files, p) };
}

export function unignoreFile(config: EnvRepoConfig, path: string): EnvRepoConfig {
  return { ...config, ignore: without(config.ignore, normalizePath(path)) };
}

/** Files a source under another environment; `null` (or the name-based guess) clears it. */
export function setEnvironment(config: EnvRepoConfig, sourceId: string, label: string | null, auto: string): EnvRepoConfig {
  const environments = { ...config.environments };
  const value = label?.trim().toLowerCase() ?? "";
  if (!value || value === auto) delete environments[sourceId];
  else environments[sourceId] = value;
  return { ...config, environments };
}

/** Adds to an editable list (the global patterns or exclusions) without duplicates or blanks. */
export function addToList(list: string[], value: string): string[] {
  const v = value.trim();
  return v && !list.includes(v) ? [...list, v] : list;
}
