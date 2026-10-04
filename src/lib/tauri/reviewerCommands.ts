import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The Reviewer ("Revisor"), from the frontend's side. Mirrors `src-tauri/src/commands/reviewer_cmd.rs`
 * and the types of `src-tauri/src/reviewer/`. Its own file for the reason `localaiCommands.ts` gives.
 */

export interface ReviewerComponent {
  id: "jdk" | "sonarqube" | "scanner";
  installed: boolean;
  version: string;
  size: number;
}

export interface ReviewerInstallStatus {
  components: ReviewerComponent[];
  ready: boolean;
  pendingBytes: number;
  root: string;
}

/** Matches `reviewer::server::ServerStatus` (`#[serde(tag = "state")]`). */
export type ReviewerServerStatus =
  | { state: "stopped" }
  | { state: "starting"; port: number; detail: "signing-in" | "rules" | "migrating" | null }
  | { state: "running"; port: number; url: string; version: string }
  | { state: "stopping" }
  | { state: "failed"; message: string };

export type ReviewerRulesPreset =
  | { kind: "sonarWay" }
  | { kind: "strict" }
  | { kind: "max" }
  | { kind: "server"; serverId: string; profiles: string[] };

export type ReviewerGatePreset =
  | { kind: "sonarWay" }
  | { kind: "strict" }
  | { kind: "server"; serverId: string; gate: string };

export interface ReviewerConfig {
  port: number;
  memory: "standard" | "large";
  idleMinutes: number;
  rules: ReviewerRulesPreset;
  gate: ReviewerGatePreset;
  thresholds: { coverage: number; duplication: number };
  continueOnTestFailure: boolean;
}

export interface ReviewerRemoteServer {
  id: string;
  name: string;
  url: string;
  organization: string;
  verifyTls: boolean;
}

export interface ReviewerServerView extends ReviewerRemoteServer {
  hasToken: boolean;
}

export interface ReviewerRulesReport {
  languages: number;
  activated: number;
  missing: number;
  gate: string;
  warnings: string[];
  signature: string;
  appliedAt: number;
}

export interface ReviewerStatus {
  install: ReviewerInstallStatus;
  server: ReviewerServerStatus;
  config: ReviewerConfig;
  servers: ReviewerServerView[];
  rules: ReviewerRulesReport | null;
  sonarqubeVersion: string;
  scannerVersion: string;
  javaRelease: number;
}

export interface ReviewerProfile {
  key: string;
  name: string;
  language: string;
  languageName: string;
  isDefault: boolean;
  isBuiltIn: boolean;
  activeRules: number;
}

export interface ReviewerRemoteCatalog {
  version: string;
  profiles: ReviewerProfile[];
  gates: { name: string; isDefault: boolean }[];
}

export type ReviewerNote =
  | "gradle-no-jacoco"
  | "vitest-no-coverage"
  | "pytest-no-coverage"
  | "rust-no-coverage"
  | "dotnet-needs-msbuild"
  | "cpp-not-in-community";

export interface ReviewerSuggestion {
  stacks: string[];
  prepare: string;
  build: string;
  test: string;
  notes: ReviewerNote[];
  projectKey: string;
  hasProperties: boolean;
}

export type ReviewerStageId = "prepare" | "build" | "test" | "sonar" | "gate";
export type ReviewerStageStatus = "pending" | "running" | "ok" | "failed" | "skipped" | "cancelled";

export interface ReviewerStage {
  id: ReviewerStageId;
  status: ReviewerStageStatus;
  command: string;
  startedAt: number | null;
  durationMs: number | null;
  detail: string | null;
}

export interface ReviewerLogLine {
  seq: number;
  stage: ReviewerStageId;
  text: string;
}

export interface ReviewerGateCondition {
  metric: string;
  comparator: string;
  threshold: string;
  actual: string | null;
  status: string;
}

export interface ReviewerMeasures {
  reliabilityRating: string | null;
  securityRating: string | null;
  maintainabilityRating: string | null;
  reliabilityIssues: number | null;
  securityIssues: number | null;
  maintainabilityIssues: number | null;
  coverage: number | null;
  duplicatedLinesDensity: number | null;
  ncloc: number | null;
  debtMinutes: number | null;
  linesToCover: number | null;
  uncoveredLines: number | null;
}

export type ReviewerQuality = "reliability" | "security" | "maintainability";
export type ReviewerSeverity = "blocker" | "high" | "medium" | "low" | "info";

export interface ReviewerIssue {
  key: string;
  rule: string;
  message: string;
  path: string;
  line: number | null;
  quality: ReviewerQuality;
  severity: ReviewerSeverity;
  effortMinutes: number | null;
  tags: string[];
}

export interface ReviewerTestFailure {
  suite: string;
  name: string;
  message: string;
  detail: string;
  file: string | null;
  line: number | null;
}

export interface ReviewerTestReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: ReviewerTestFailure[];
  files: number;
}

export interface ReviewerCoverageEntry {
  path: string;
  isFile: boolean;
  coverage: number | null;
  uncoveredLines: number | null;
  linesToCover: number | null;
}

export type ReviewerRunStatus = "passed" | "failed" | "error" | "cancelled";

export interface ReviewerRunSummary {
  runId: string;
  projectId: string;
  projectKey: string;
  startedAt: number;
  finishedAt: number;
  status: ReviewerRunStatus;
  error: string | null;
  stages: ReviewerStage[];
  gate: { status: "OK" | "ERROR" | "NONE" | string; conditions: ReviewerGateCondition[] } | null;
  measures: ReviewerMeasures;
  issues: ReviewerIssue[];
  issuesTotal: number;
  tests: ReviewerTestReport | null;
  coverage: ReviewerCoverageEntry[];
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  sonarqubeVersion: string;
}

export interface ReviewerHistoryEntry {
  runId: string;
  finishedAt: number;
  status: ReviewerRunStatus;
  gate: string | null;
  coverage: number | null;
  reliabilityIssues: number | null;
  securityIssues: number | null;
  maintainabilityIssues: number | null;
  testsFailed: number | null;
  commit: string | null;
}

export interface ReviewerActiveRun {
  runId: string;
  projectId: string;
  projectKey: string;
  startedAt: number;
  stages: ReviewerStage[];
  log: ReviewerLogLine[];
}

export interface ReviewerLastRun {
  projectKey: string;
  summary: ReviewerRunSummary | null;
  history: ReviewerHistoryEntry[];
}

export interface ReviewerRunRequest {
  projectId: string;
  repoPath: string;
  projectName: string;
  projectKey: string;
  prepare: string;
  build: string;
  test: string;
  exclusions: string;
}

export type ReviewerRunEvent =
  | { kind: "started"; runId: string; projectId: string; projectKey: string; stages: ReviewerStage[]; startedAt: number }
  | { kind: "stage"; runId: string; projectId: string; stage: ReviewerStage }
  | { kind: "log"; runId: string; projectId: string; lines: ReviewerLogLine[] }
  | { kind: "finished"; runId: string; projectId: string; summary: ReviewerRunSummary };

export interface ReviewerInstallProgress {
  item: "jdk" | "sonarqube" | "scanner";
  phase: "downloading" | "extracting" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  error?: string;
}

export const reviewerStatus = () => invoke<ReviewerStatus>("reviewer_status");
export const reviewerDiskUsed = () => invoke<number>("reviewer_disk_used");
export const reviewerInstall = () => invoke<ReviewerInstallStatus>("reviewer_install");
export const reviewerCancelInstall = () => invoke<void>("reviewer_cancel_install");
export const reviewerUninstall = (withData: boolean) => invoke<ReviewerInstallStatus>("reviewer_uninstall", { withData });
export const reviewerServerStart = () => invoke<ReviewerServerStatus>("reviewer_server_start");
export const reviewerServerStop = () => invoke<void>("reviewer_server_stop");
export const reviewerServerLog = (lines?: number) => invoke<string[]>("reviewer_server_log", { lines });
export const reviewerSaveConfig = (config: ReviewerConfig) => invoke<void>("reviewer_save_config", { config });
export const reviewerApplyRules = () => invoke<ReviewerRulesReport>("reviewer_apply_rules");
/** `token`: `undefined` keeps the stored one, `""` removes it. */
export const reviewerSaveServer = (server: ReviewerRemoteServer, token?: string) =>
  invoke<ReviewerServerView[]>("reviewer_save_server", { server, token: token ?? null });
export const reviewerDeleteServer = (id: string) => invoke<ReviewerServerView[]>("reviewer_delete_server", { id });
export const reviewerServerCatalog = (id: string) => invoke<ReviewerRemoteCatalog>("reviewer_server_catalog", { id });
export const reviewerDetect = (repoPath: string, projectName: string, projectKey?: string) =>
  invoke<ReviewerSuggestion>("reviewer_detect", { repoPath, projectName, projectKey: projectKey ?? null });
export const reviewerRun = (request: ReviewerRunRequest) => invoke<string>("reviewer_run", { request });
export const reviewerCancelRun = (runId: string) => invoke<boolean>("reviewer_cancel_run", { runId });
export const reviewerActiveRun = () => invoke<ReviewerActiveRun | null>("reviewer_active_run");
export const reviewerLastRun = (repoPath: string, projectName: string, projectKey?: string) =>
  invoke<ReviewerLastRun>("reviewer_last_run", { repoPath, projectName, projectKey: projectKey ?? null });

export const onReviewerRun = (handler: (event: ReviewerRunEvent) => void) =>
  listen<ReviewerRunEvent>("reviewer:run", (e) => handler(e.payload));
export const onReviewerServer = (handler: (status: ReviewerServerStatus) => void) =>
  listen<ReviewerServerStatus>("reviewer:server", (e) => handler(e.payload));
export const onReviewerInstall = (handler: (progress: ReviewerInstallProgress) => void) =>
  listen<ReviewerInstallProgress>("reviewer:install", (e) => handler(e.payload));
