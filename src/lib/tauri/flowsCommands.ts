import { invoke } from "@tauri-apps/api/core";
import type { DocVersion } from "../../types/notes";

/**
 * Flujos ("Flows"), from the frontend's side. Mirrors `src-tauri/src/commands/flows_cmd.rs`, the
 * rows of `src-tauri/src/db/flow_queries.rs` and the descriptors of `src-tauri/src/flows/catalog.rs`.
 * Its own file for the reason `localaiCommands.ts` gives: one feature, one module of wire types.
 */

/** The palette's sections — `catalog::Family`, serialised lowercase. */
export type FlowFamily = "trigger" | "ai" | "code" | "net" | "data" | "logic" | "transform" | "files" | "app";

/** `catalog::NodeDescriptor`. The node's name and description are translations keyed by `typeId`. */
export interface FlowNodeDescriptor {
  typeId: string;
  family: FlowFamily;
  /** A lucide icon name, kebab-case — see `lib/flows/nodeIcons`. */
  icon: string;
  inputs: number;
  outputs: number;
  inputLabels: string[];
  outputLabels: string[];
  /** The milestone that makes it run (1–6). */
  milestone: number;
  /** What the node can be told — `flows::params`. Empty for a node with nothing to set (or that
   *  does not run yet). */
  params: FlowParamSpec[];
}

/** `params::Kind`, tagged by `type`. */
export type FlowParamKind =
  | { type: "text"; multiline: boolean; placeholder: string }
  | { type: "code"; lang: string }
  | { type: "number"; min: number | null; max: number | null }
  | { type: "boolean" }
  | { type: "select"; options: string[]; raw: boolean }
  | { type: "keyValue" }
  | { type: "conditions" }
  | { type: "rules" }
  | { type: "assignments" }
  | { type: "sortKeys" }
  | { type: "aggregations" }
  | { type: "strings" }
  | { type: "folder" }
  | { type: "credential"; kinds: string[] }
  | { type: "multiSelect"; options: string[] }
  | { type: "project" }
  | { type: "flows"; multiple: boolean }
  | { type: "service" }
  | { type: "engine" }
  | { type: "engines" }
  | { type: "outputFields" }
  | { type: "categories" }
  | { type: "mcpServers" }
  | { type: "localModel" }
  | { type: "agent" }
  | { type: "chainTemplate" };

/** `engine::EngineChoice` — an AI node's engine. `provider: ""` is the Flows routing row's engine,
 *  `"local"` the local model of Settings; `account: ""` is automatic. */
export interface FlowEngineChoice {
  provider: string;
  model: string;
  account: string;
}

/** One field of an AI node's answer — `schema::from_fields`. */
export interface FlowAnswerField {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "list" | "enum";
  description: string;
  required: boolean;
  /** `enum` only: the choices, comma separated. */
  options?: string;
}

/** `params::ParamSpec`. Its label is the translation `flows.param.<name>`. */
export interface FlowParamSpec {
  name: string;
  kind: FlowParamKind;
  default: unknown;
  /** Shown only while `param` holds one of `values`. */
  showIf?: { param: string; values: string[] };
  /** Whether the field can switch to an expression. */
  expr: boolean;
}

/** `flow_queries::FlowMeta` — every column but `spec`. */
export interface FlowMetaRow {
  id: string;
  workspace_id: string;
  scope: "workspace" | "global";
  folder_id: string | null;
  name: string;
  description: string;
  node_count: number;
  /** A JSON array of trigger type ids, in canvas order. */
  trigger_types: string;
  active: boolean;
  version: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FlowRow extends FlowMetaRow {
  spec: string;
}

export interface FlowFolderRow {
  id: string;
  workspace_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FlowsTree {
  folders: FlowFolderRow[];
  flows: FlowMetaRow[];
}

/** `meta: null` — the flow was deleted while it was open. `conflict` — another write got there first
 *  and nothing was saved. */
export interface FlowSaved {
  meta: FlowMetaRow | null;
  conflict: boolean;
  /** The flow was active and what was saved cannot be armed: it was switched off, and this is why. */
  trigger_error?: string;
}

/** A flow's history rides in `doc_versions` with the notes' and the diagrams' (kind `flow`). */
export type FlowVersion = DocVersion;

export const flowsNodeCatalog = () => invoke<FlowNodeDescriptor[]>("flows_node_catalog");

export const flowsLoadTree = (workspaceId: string) => invoke<FlowsTree>("flows_load_tree", { workspaceId });

export const flowsGetFlow = (id: string) => invoke<FlowRow | null>("flows_get_flow", { id });

export const flowsCreateFlow = (workspaceId: string, folderId: string | null, name: string, spec?: string) =>
  invoke<FlowMetaRow>("flows_create_flow", { workspaceId, folderId, name, spec: spec ?? null });

export const flowsSaveFlow = (id: string, spec: string, expectedVersion: number | null) =>
  invoke<FlowSaved>("flows_save_flow", { id, spec, expectedVersion });

export const flowsRenameFlow = (id: string, name: string) =>
  invoke<FlowMetaRow | null>("flows_rename_flow", { id, name });

export const flowsSetDescription = (id: string, description: string) =>
  invoke<FlowMetaRow | null>("flows_set_description", { id, description });

export const flowsMoveFlow = (id: string, folderId: string | null) =>
  invoke<FlowMetaRow | null>("flows_move_flow", { id, folderId });

export const flowsSetScope = (id: string, global: boolean) =>
  invoke<FlowMetaRow | null>("flows_set_scope", { id, global });

export const flowsMoveToWorkspace = (id: string, workspaceId: string) =>
  invoke<FlowMetaRow | null>("flows_move_to_workspace", { id, workspaceId });

export const flowsDuplicateFlow = (id: string, name: string) =>
  invoke<FlowMetaRow | null>("flows_duplicate_flow", { id, name });

export const flowsDeleteFlow = (id: string) => invoke<void>("flows_delete_flow", { id });

export const flowsCreateFolder = (workspaceId: string, name: string) =>
  invoke<FlowFolderRow>("flows_create_folder", { workspaceId, name });

export const flowsRenameFolder = (id: string, name: string) =>
  invoke<FlowFolderRow | null>("flows_rename_folder", { id, name });

export const flowsDeleteFolder = (id: string) => invoke<void>("flows_delete_folder", { id });

export const flowsListVersions = (id: string) => invoke<FlowVersion[]>("flows_list_versions", { id });

export const flowsVersionContent = (versionId: string) =>
  invoke<string | null>("flows_version_content", { versionId });

export const flowsDeleteVersion = (versionId: string) => invoke<void>("flows_delete_version", { versionId });

export const flowsClearVersions = (id: string) => invoke<void>("flows_clear_versions", { id });

// ---------- runs ----------

/** `run::RunMode`. */
export type FlowRunMode = { kind: "full" } | { kind: "upTo"; node: string } | { kind: "step"; node: string };

export type FlowRunStatus = "running" | "success" | "error" | "canceled" | "interrupted";
export type FlowNodeRunStatus =
  | "running"
  | "success"
  | "error"
  | "skipped"
  | "canceled"
  | "pinned"
  | "reused"
  | "disabled";

/** `flow_run_queries::FlowRunRow` — also the payload of `flows:run`. */
export interface FlowRunRow {
  id: string;
  flowId: string;
  workspaceId: string;
  flowName: string;
  flowVersion: number;
  mode: "manual" | "partial" | "step" | string;
  triggerNode: string;
  targetNode: string;
  status: FlowRunStatus;
  error: string;
  errorNode: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  dataBytes: number;
  /** For runs nobody started by hand: when their end becomes a notification. */
  notify?: "never" | "failure" | "always";
}

/** `flow_run_queries::FlowRunNodeRow` — also inside `flows:node`. */
export interface FlowRunNodeRow {
  runId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: FlowNodeRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  itemsIn: number;
  itemsOut: number[];
  attempts: number;
  error: string;
  seq: number;
}

export interface FlowRunDetail {
  run: FlowRunRow;
  nodes: FlowRunNodeRow[];
}

export interface FlowNodeEvent {
  runId: string;
  flowId: string;
  workspaceId: string;
  node: FlowRunNodeRow;
}

export type FlowLogStream = "stdout" | "stderr" | "console" | "info";

export interface FlowLogLine {
  nodeId: string;
  stream: FlowLogStream;
  text: string;
  ts: number;
}

export interface FlowLogEvent {
  runId: string;
  flowId: string;
  workspaceId: string;
  lines: FlowLogLine[];
}

export interface FlowNotifyEvent {
  runId: string;
  flowId: string;
  workspaceId: string;
  flowName: string;
  title: string;
  body: string;
}

/** `runs::NodeDataView`: JSON per port, cut to the requested count. */
export interface FlowNodeData {
  inputs: unknown[][];
  outputs: unknown[][];
  inputCounts: number[];
  outputCounts: number[];
}

export interface FlowPreview {
  ok: boolean;
  value?: unknown;
  type?: string;
  error?: string;
  /** How many input items the preview had to work with. */
  items: number;
}

export const flowsRun = (flowId: string, mode: FlowRunMode, trigger?: string | null) =>
  invoke<FlowRunRow>("flows_run", { flowId, mode, trigger: trigger ?? null });

export const flowsCancelRun = (runId: string) => invoke<boolean>("flows_cancel_run", { runId });

export const flowsActiveRuns = (workspaceId: string) => invoke<FlowRunRow[]>("flows_active_runs", { workspaceId });

export const flowsListRuns = (flowId: string, limit?: number, before?: string | null) =>
  invoke<FlowRunRow[]>("flows_list_runs", { flowId, limit: limit ?? null, before: before ?? null });

export const flowsGetRun = (runId: string) => invoke<FlowRunDetail | null>("flows_get_run", { runId });

export const flowsRunNodeData = (runId: string, nodeId: string, limit?: number) =>
  invoke<FlowNodeData | null>("flows_run_node_data", { runId, nodeId, limit: limit ?? null });

export const flowsRunLog = (runId: string) => invoke<FlowLogLine[]>("flows_run_log", { runId });

export const flowsDeleteRun = (runId: string) => invoke<void>("flows_delete_run", { runId });

export const flowsClearRuns = (flowId: string) => invoke<number>("flows_clear_runs", { flowId });

export const flowsPreviewExpression = (
  flowId: string,
  nodeId: string,
  expression: string,
  itemIndex: number,
  spec: string | null,
) => invoke<FlowPreview>("flows_preview_expression", { flowId, nodeId, expression, itemIndex, spec });

// ---------- pinned output, state ----------

export const flowsListPins = (flowId: string) => invoke<Record<string, unknown[][]>>("flows_list_pins", { flowId });

export const flowsPinNode = (flowId: string, nodeId: string, ports: unknown[][]) =>
  invoke<void>("flows_pin_node", { flowId, nodeId, ports });

export const flowsUnpinNode = (flowId: string, nodeId: string) => invoke<void>("flows_unpin_node", { flowId, nodeId });

export interface FlowStateEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

export const flowsStateList = (flowId: string) => invoke<FlowStateEntry[]>("flows_state_list", { flowId });

export const flowsStateClear = (flowId: string) => invoke<void>("flows_state_clear", { flowId });

// ---------- variables and credentials ----------

export interface FlowVariable {
  id: string;
  workspaceId: string;
  scope: "workspace" | "global";
  name: string;
  value: string;
  updatedAt: string;
}

export const flowsListVariables = (workspaceId: string) => invoke<FlowVariable[]>("flows_list_variables", { workspaceId });

export const flowsPutVariable = (workspaceId: string, name: string, value: string) =>
  invoke<FlowVariable>("flows_put_variable", { workspaceId, name, value });

export const flowsRenameVariable = (id: string, name: string) => invoke<void>("flows_rename_variable", { id, name });

export const flowsDeleteVariable = (id: string) => invoke<void>("flows_delete_variable", { id });

export const flowsSetVariableScope = (id: string, global: boolean) =>
  invoke<void>("flows_set_variable_scope", { id, global });

export type FlowCredentialKind = "bearer" | "basic" | "header" | "query" | "hmac";

/** A credential as the frontend sees it: never the secret. */
export interface FlowCredential {
  id: string;
  workspaceId: string;
  scope: "workspace" | "global";
  name: string;
  kind: FlowCredentialKind;
  meta: { user?: string; name?: string };
  createdAt: string;
  updatedAt: string;
}

export const flowsListCredentials = (workspaceId: string) =>
  invoke<FlowCredential[]>("flows_list_credentials", { workspaceId });

export const flowsCreateCredential = (
  workspaceId: string,
  name: string,
  kind: FlowCredentialKind,
  meta: Record<string, string>,
  secret: string,
) => invoke<FlowCredential>("flows_create_credential", { workspaceId, name, kind, meta, secret });

export const flowsUpdateCredential = (id: string, name: string, meta: Record<string, string>, secret: string | null) =>
  invoke<void>("flows_update_credential", { id, name, meta, secret });

export const flowsDeleteCredential = (id: string) => invoke<void>("flows_delete_credential", { id });

export const flowsSetCredentialScope = (id: string, global: boolean) =>
  invoke<void>("flows_set_credential_scope", { id, global });

// ---------- triggers ----------

/** `triggers::TriggerView`: one armed trigger. */
export interface FlowTriggerView {
  nodeId: string;
  nodeName: string;
  typeId: string;
  detail: string;
  url: string | null;
  next: string | null;
  /** A schedule's occurrences in the next 24 hours. */
  upcoming: string[];
  lastFired: string | null;
  /** `started`, `skipped`, `queued`, `missed`. */
  lastOutcome: string | null;
  problem: string | null;
}

/** `triggers::ArmedFlowView`: an active flow and what it listens for. */
export interface FlowArmedView {
  flowId: string;
  flowName: string;
  workspaceId: string;
  scope: "workspace" | "global";
  overlap: "skip" | "queue" | "parallel";
  triggers: FlowTriggerView[];
}

export const flowsSetActive = (id: string, active: boolean) => invoke<FlowMetaRow | null>("flows_set_active", { id, active });

export const flowsTriggerStatus = (workspaceId: string | null) =>
  invoke<FlowArmedView[]>("flows_trigger_status", { workspaceId });

export const flowsArmedNames = () => invoke<string[]>("flows_armed_names");

export const flowsWebhookBase = () => invoke<string>("flows_webhook_base");

// ---------- AI (milestone 3)

/** `runs::RunEdits` — what a run's editing AI nodes changed in one repository. */
export interface FlowRunEdits {
  path: string;
  files: string[];
  diff: string;
  /** The restore point is gone: the repository moved, or its ref was deleted. */
  missing: boolean;
}

export const flowsRunEdits = (runId: string) => invoke<FlowRunEdits[]>("flows_run_edits", { runId });

/** Puts back what the run's editing nodes changed; the paths it touched. */
export const flowsUndoEdits = (runId: string) => invoke<string[]>("flows_undo_edits", { runId });

/** The models a local server lists, for the Local model node. */
export const flowsLocalModels = (server: string, url: string) => invoke<string[]>("flows_local_models", { server, url });

/** `flows:ai` — an AI node's model call is starting; the status bar adopts it under the flow's name. */
export interface FlowAiEvent {
  runId: string;
  flowRunId: string;
  flowId: string;
  flowName: string;
  workspaceId: string;
  node: string;
}

/** `flows:agent` — a flow filed a chain in Agents; the main window advances it. */
export interface FlowAgentEvent {
  chainId: string;
  workspaceId: string;
  flowId?: string;
  flowRunId?: string;
  aborted?: boolean;
}
