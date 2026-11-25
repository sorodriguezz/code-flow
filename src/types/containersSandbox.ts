import type { HardeningFinding, ScanSummary } from "./containers";

/**
 * Agent sandboxes and workspace security policies — the shapes `containers::agent_sandbox` and
 * `containers::policy` answer with (camelCase, as serde writes them).
 */

/** What a workspace allows a container to be (`containers::policy::SecurityPolicy`). */
export interface SecurityPolicy {
  noPrivileged: boolean;
  noHostMounts: boolean;
  requireNonRoot: boolean;
  blockCriticalVulns: boolean;
  requireSigned: boolean;
  /** A cosign public key; empty accepts any keyless (Sigstore) signature. */
  signingKey: string;
  restrictNetwork: boolean;
  noEngineSocket: boolean;
  requireLimits: boolean;
  enforceInFlows: boolean;
  sandboxImage: string;
}

export type PolicySource = "own" | "default" | "builtIn";

export interface StoredPolicy {
  workspaceId: string;
  policy: SecurityPolicy;
  source: PolicySource;
  updatedAt: string;
}

export type ViolationRule =
  | "privileged"
  | "hostMount"
  | "engineSocket"
  | "rootUser"
  | "noMemoryLimit"
  | "noCpuLimit"
  | "criticalVulns"
  | "notScanned"
  | "unsigned"
  | "network";

export interface PolicyViolation {
  rule: ViolationRule;
  detail: string;
  /** False only for an advisory (`notScanned`). */
  blocking: boolean;
}

export type SignatureState =
  | { state: "notChecked" }
  | { state: "verified" }
  | { state: "failed"; reason: string }
  | { state: "unavailable"; reason: string };

/** `containers_policy_check` / `containers_policy_check_container`. */
export interface PolicyCheck {
  policy: StoredPolicy;
  violations: PolicyViolation[];
  blocked: boolean;
  signature: SignatureState;
}

export type SandboxNetwork = "none" | "internal" | "internet";
export type SandboxStatus = "creating" | "running" | "stopped" | "failed" | "blocked" | "destroyed";

export interface Sandbox {
  id: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  storyId: string;
  title: string;
  runtime: string;
  context: string;
  image: string;
  containerId: string;
  containerName: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  worktreeOwned: boolean;
  network: SandboxNetwork;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  ports: string[];
  status: SandboxStatus;
  /** `ok`, `warnings` (advisories only) or `blocked`. */
  policyStatus: "ok" | "warnings" | "blocked" | "";
  error: string;
  createdAt: string;
  updatedAt: string;
}

/** A sandbox with the names of what it hangs off (`containers_sandbox_list`). */
export interface SandboxView extends Sandbox {
  projectName: string;
  storyTitle: string;
  storyBatchId: string;
  taskTitle: string;
}

export interface SandboxRequest {
  /** Chosen by the caller so a creation can be cancelled before it answers; empty: the broker picks. */
  id?: string;
  runtime: string;
  context: string | null;
  workspaceId: string;
  projectId: string;
  taskId?: string;
  storyId?: string;
  title?: string;
  /** Empty: the policy's sandbox image. */
  image?: string;
  network: SandboxNetwork;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  ports?: string[];
  branch?: string;
}

export type EvidenceKind =
  | "created"
  | "policy"
  | "hardening"
  | "scan"
  | "exec"
  | "test"
  | "write"
  | "diff"
  | "stopped"
  | "started"
  | "destroyed"
  | "cancelled"
  | "error";

export interface EvidenceEntry {
  id: number;
  sandboxId: string;
  kind: EvidenceKind;
  at: string;
  summary: string;
  /** Per kind: `exec`/`test` {argv, exitCode, durationMs, stdout, stderr, timedOut…}, `diff` {stat, diff,
   *  untracked}, `policy` {policy, violations, signature}, `hardening` {findings, violations}, `scan` {scan}. */
  data: EvidenceData;
}

export interface EvidenceData {
  argv?: string[];
  exitCode?: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  stat?: string;
  diff?: string;
  diffTruncated?: boolean;
  untracked?: string[];
  violations?: PolicyViolation[];
  findings?: HardeningFinding[];
  scan?: ScanSummary | null;
  signature?: SignatureState;
  detail?: string;
  path?: string;
  bytes?: number;
}

export interface ExecResult {
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  test: boolean;
}

export interface PublishedPort {
  containerPort: string;
  host: string;
}

export interface SandboxSources {
  projects: { id: string; name: string; path: string }[];
  tasks: { id: string; title: string; projectId: string; worktreePath: string; branch: string }[];
}
