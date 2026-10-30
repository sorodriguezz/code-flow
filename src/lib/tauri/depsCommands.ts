import { invoke } from "./invoke";
import { listen } from "@tauri-apps/api/event";

/**
 * «Salud de dependencias», from the frontend's side. Mirrors `src-tauri/src/commands/deps_cmd.rs`
 * and the types of `src-tauri/src/deps/`. Its own file for the reason `localaiCommands.ts` gives.
 */

export type DepsEcosystem = "npm" | "cargo" | "nuget" | "pypi" | "go" | "maven";
export type DepsUpdateKind = "none" | "patch" | "minor" | "major";
export type DepsLicenseStatus = "ok" | "warn" | "flag" | "unavailable";
export type DepsSeverity = "unknown" | "low" | "medium" | "high" | "critical";

export interface DepsConfig {
  minReleaseAgeDays: number;
  cacheTtlHours: number;
  alerts: boolean;
  licenseAllowed: string[];
  licenseFlagged: string[];
  licenseWarn: string[];
  flagUnknownLicense: boolean;
}

/** The settings row the Settings pane writes (through `setSetting`, so every window hears it). */
export const DEPS_CONFIG_KEY = "deps_config";

export interface DepsAdvisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: DepsSeverity;
  score: number | null;
  url: string;
  fixed: string | null;
  published: number | null;
}

export interface DepsRow {
  ecosystem: DepsEcosystem;
  name: string;
  key: string;
  manifest: string;
  section: string;
  requirement: string;
  property?: string | null;
  current: string | null;
  locked: boolean;
  latest: string | null;
  compatible: string | null;
  tooRecent: string | null;
  update: DepsUpdateKind;
  compatibleUpdate: DepsUpdateKind;
  bumpLatest: string | null;
  bumpCompatible: string | null;
  license: string | null;
  licenseStatus: DepsLicenseStatus;
  advisories: DepsAdvisory[];
  url: string | null;
  error: string | null;
  stale: boolean;
}

export interface DepsTransitiveVuln {
  ecosystem: DepsEcosystem;
  name: string;
  version: string;
  lockfile: string;
  advisories: DepsAdvisory[];
}

export interface DepsLockfile {
  path: string;
  kind: string;
}

export interface DepsReport {
  projectId: string;
  analyzedAt: number;
  manifests: string[];
  lockfiles: DepsLockfile[];
  rows: DepsRow[];
  transitive: DepsTransitiveVuln[];
  lockedCount: number;
  warnings: string[];
  osvError: string | null;
  minReleaseAgeDays: number;
}

export interface DepsProgress {
  projectId: string;
  phase: "scan" | "registry" | "osv" | "done";
  done: number;
  total: number;
}

export interface DepsBump {
  ecosystem: DepsEcosystem;
  name: string;
  key: string;
  section: string;
  from: string;
  to: string;
  property?: string | null;
}

export interface DepsUpdateItem {
  manifest: string;
  bump: DepsBump;
  resolved: string | null;
  toVersion: string;
  fixes: string[];
}

export interface DepsLockStep {
  dir: string;
  lockfile: string;
  program: string;
  args: string[];
  available: boolean;
}

export interface DepsPlan {
  branch: string;
  target: string;
  currentBranch: string;
  dirty: string[];
  files: Record<string, DepsBump[]>;
  lockSteps: DepsLockStep[];
  manualLocks: string[];
}

export interface DepsLockRun {
  command: string;
  dir: string;
  ok: boolean;
  output: string;
}

export interface DepsOutcome {
  branch: string;
  target: string;
  commit: string;
  applied: string[];
  skipped: string[];
  lockRuns: DepsLockRun[];
  manualLocks: string[];
  prTitle: string;
  prBody: string;
}

export interface DepsNewAdvisory {
  projectId: string;
  projectName: string;
  ecosystem: DepsEcosystem;
  name: string;
  version: string;
  advisory: DepsAdvisory;
}

export const depsConfigGet = () => invoke<DepsConfig>("deps_config_get");
export const depsAnalyze = (projectId: string) => invoke<DepsReport>("deps_analyze", { projectId });
export const depsReports = (projectIds: string[]) => invoke<DepsReport[]>("deps_reports", { projectIds });
export const depsUpdatePlan = (projectId: string, items: DepsUpdateItem[]) => invoke<DepsPlan>("deps_update_plan", { projectId, items });
export const depsUpdateApply = (projectId: string, items: DepsUpdateItem[], branch: string) =>
  invoke<DepsOutcome>("deps_update_apply", { projectId, items, branch });
export const depsCheckAlerts = (projectIds: string[], force = false) =>
  invoke<DepsNewAdvisory[] | null>("deps_check_alerts", { projectIds, force });

export const onDepsProgress = (handler: (p: DepsProgress) => void) => listen<DepsProgress>("deps:progress", (e) => handler(e.payload));
export const onDepsUpdateLine = (handler: (p: { projectId: string; line: string }) => void) =>
  listen<{ projectId: string; line: string }>("deps:update", (e) => handler(e.payload));
