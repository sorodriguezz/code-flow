import { invoke } from "./invoke";
import type { RunSpec } from "../../types/containers";
import type {
  EvidenceEntry,
  ExecResult,
  PolicyCheck,
  PublishedPort,
  Sandbox,
  SandboxRequest,
  SandboxSources,
  SandboxView,
  SecurityPolicy,
  StoredPolicy,
} from "../../types/containersSandbox";

/**
 * Agent sandboxes and workspace security policies (`commands::containers_sandbox_cmd`).
 */

// ------------------------------------------------------------------------------------ policies

/** The policy in force for a workspace (`""` = the global default) and where it comes from. */
export const containersPolicyGet = (workspaceId: string) => invoke<StoredPolicy>("containers_policy_get", { workspaceId });

/** Keeps a workspace's own policy (`""` = the global default). */
export const containersPolicySave = (workspaceId: string, policy: SecurityPolicy) => invoke<StoredPolicy>("containers_policy_save", { workspaceId, policy });

/** Drops a workspace's own policy so it follows the default again. */
export const containersPolicyReset = (workspaceId: string) => invoke<StoredPolicy>("containers_policy_reset", { workspaceId });

/** Where cosign is installed, or null. */
export const containersCosignDetect = () => invoke<string | null>("containers_cosign_detect");

/** What a run spec breaks of the workspace's policy — for the Run dialog to show as warnings. */
export const containersPolicyCheck = (workspaceId: string | null, runtime: string, context: string | null, spec: RunSpec) =>
  invoke<PolicyCheck>("containers_policy_check", { workspaceId, runtime, context, spec });

/** What an existing container breaks of the workspace's policy. */
export const containersPolicyCheckContainer = (workspaceId: string | null, runtime: string, context: string | null, id: string) =>
  invoke<PolicyCheck>("containers_policy_check_container", { workspaceId, runtime, context, id });

// ------------------------------------------------------------------------------------ sandboxes

export const containersSandboxList = (workspaceId: string | null) => invoke<SandboxView[]>("containers_sandbox_list", { workspaceId });
export const containersSandboxForStory = (storyId: string) => invoke<SandboxView[]>("containers_sandbox_for_story", { storyId });
export const containersSandboxGet = (id: string) => invoke<SandboxView>("containers_sandbox_get", { id });
export const containersSandboxSources = (workspaceId: string) => invoke<SandboxSources>("containers_sandbox_sources", { workspaceId });

/** Creates a sandbox; rejects with the policy's reason when the workspace's policy blocks it. */
export const containersSandboxCreate = (request: SandboxRequest) => invoke<Sandbox>("containers_sandbox_create", { request });
export const containersSandboxCancel = (id: string) => invoke<boolean>("containers_sandbox_cancel", { id });

/** Runs a command line (split like a shell would) in the sandbox's checkout. */
export const containersSandboxExec = (id: string, line: string, timeoutS?: number) => invoke<ExecResult>("containers_sandbox_exec", { id, argv: null, line, timeoutS: timeoutS ?? null });

export const containersSandboxLogs = (id: string, lines?: number) => invoke<string>("containers_sandbox_logs", { id, lines: lines ?? null });
export const containersSandboxPorts = (id: string) => invoke<PublishedPort[]>("containers_sandbox_ports", { id });
export const containersSandboxStop = (id: string) => invoke<Sandbox>("containers_sandbox_stop", { id });
export const containersSandboxStart = (id: string) => invoke<Sandbox>("containers_sandbox_start", { id });
export const containersSandboxDestroy = (id: string, removeWorktree: boolean) => invoke<Sandbox>("containers_sandbox_destroy", { id, removeWorktree });
export const containersSandboxForget = (id: string) => invoke<void>("containers_sandbox_forget", { id });
export const containersSandboxCaptureDiff = (id: string) => invoke<EvidenceEntry | null>("containers_sandbox_capture_diff", { id });
export const containersSandboxEvidence = (id: string) => invoke<EvidenceEntry[]>("containers_sandbox_evidence", { id });

/** The evidence as Markdown, written to `path` too when one is given. */
export const containersSandboxExport = (id: string, path?: string) => invoke<string>("containers_sandbox_export", { id, path: path ?? null });

/** Removes the engine's sandbox containers whose sandbox is gone; their names. */
export const containersSandboxCleanup = (runtime: string, context: string | null) => invoke<string[]>("containers_sandbox_cleanup", { runtime, context });
