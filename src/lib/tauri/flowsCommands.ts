import { invoke } from "@tauri-apps/api/core";
import type { DocVersion } from "../../types/notes";

/**
 * Flujos ("Flows"), from the frontend's side. Mirrors `src-tauri/src/commands/flows_cmd.rs`, the
 * rows of `src-tauri/src/db/flow_queries.rs` and the descriptors of `src-tauri/src/flows/catalog.rs`.
 * Its own file for the reason `localaiCommands.ts` gives: one feature, one module of wire types.
 */

/** The palette's sections — `catalog::Family`, serialised lowercase. */
export type FlowFamily = "trigger" | "ai" | "code" | "git" | "net" | "messaging" | "apps" | "data" | "files" | "logic" | "transform" | "app";

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
  /** The milestone that makes it run. */
  milestone: number;
  /** The palette sub-heading it sits under in its family (`flows.group.<group>`); `""` for none. */
  group: string;
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
  | { type: "formFields" }
  | { type: "apiRequest" }
  | { type: "apiEnvironment" }
  | { type: "extractRules" }
  | { type: "categories" }
  | { type: "mcpServers" }
  | { type: "localModel" }
  | { type: "file"; placeholder: string; save: string[] }
  | { type: "apiModel"; purpose: "chat" | "embed" }
  | { type: "agent" }
  | { type: "chainTemplate" }
  | { type: "dbConnection"; kinds: string[] }
  | { type: "remoteHost"; kinds: string[] }
  | { type: "note" }
  | { type: "vaultItem" }
  | { type: "connector" }
  | { type: "flowTable" }
  | { type: "apiCollection" }
  | { type: "fakeFields" }
  | { type: "validationRules" }
  | { type: "subflowInputs" };

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
  /** A second condition that must hold too. */
  alsoIf?: { param: string; values: string[] };
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
  /** What the flow would run, hashed (`spec::executable_hash`); empty when it runs nothing. */
  exec_hash: string;
  /** Whether what it runs is what the user trusted: written here, or reviewed and accepted. */
  trusted: boolean;
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

/** `connectors::Label` — a definition's text in both languages. */
export interface FlowLabel {
  es: string;
  en: string;
}

export interface FlowConnectorField {
  name: string;
  label: FlowLabel;
  placeholder: string;
  required: boolean;
  multiline: boolean;
  /** Parsed as JSON by the node (a Notion filter). */
  json: boolean;
  /** What an empty field stands for (ntfy's public server, gitlab.com) — so empty is not missing. */
  default?: string;
  /** Its value can be picked from what the service lists (`flowsConnectorOptions`) — once the
   *  fields it `needs` are filled. */
  lookup?: { needs?: string[] };
}

/** One thing a field can be (`connectors::Choice`): what it takes, what a person reads, and the
 *  other fields it fills (a GitHub repository's owner). */
export interface FlowChoice {
  value: string;
  label: string;
  fills?: Record<string, string>;
}

export interface FlowConnectorOperation {
  id: string;
  name: FlowLabel;
  method: string;
  fields: FlowConnectorField[];
}

/** `connectors::Connector`, the parts the form draws from. */
export interface FlowConnector {
  id: string;
  name: string;
  /** Its palette sub-heading in the Apps family (`flows.group.<group>`). */
  group: string;
  auth: "bearer" | "basic" | "path" | "url" | "headers" | "query" | "body" | "none";
  /** The credential may be left out (a public ntfy topic). */
  authOptional: boolean;
  authHint: FlowLabel;
  /** Where a person gets the credential: the service's token page, or its guide. */
  tokenUrl?: string;
  /** What the two halves of a user-and-secret credential are here (an email and an API token). */
  userLabel?: FlowLabel;
  secretLabel?: FlowLabel;
  /** Signed into with an account (OAuth 2) rather than a pasted token: the provider and scopes. */
  oauth?: { provider: "google" | "microsoft"; scopes: string };
  /** Present when the service can say who a credential is (`flowsConnectorTest`). */
  test?: unknown;
  /** A field every operation has (Jira's site), shown first. */
  siteField: FlowConnectorField | null;
  operations: FlowConnectorOperation[];
}

/** `Connector::credential_kinds`: which credentials sign a connector in, by how it signs in. */
export const CONNECTOR_CREDENTIALS: Record<FlowConnector["auth"], FlowCredentialKind[]> = {
  bearer: ["bearer", "oauth2"],
  path: ["bearer"],
  headers: ["bearer"],
  basic: ["basic"],
  query: ["basic"],
  body: ["basic"],
  url: ["webhook"],
  none: [],
};

/** `{ connector, operation, fields }` — the "Conector" node's `call` parameter. */
export interface FlowConnectorCall {
  connector: string;
  operation: string;
  fields: Record<string, unknown>;
}

export const flowsConnectors = () => invoke<FlowConnector[]>("flows_connectors");

/** What a connector field can be, asked of the service with the node's credential and fields. */
export const flowsConnectorOptions = (connector: string, operation: string, field: string, credential: string | null, fields: Record<string, unknown>) =>
  invoke<FlowChoice[]>("flows_connector_options", { connector, operation, field, credential, fields });

/** Who a credential signs in as for a connector ("Ana · ana@example.com"). */
export const flowsConnectorTest = (connector: string, credential: string, fields?: Record<string, unknown>) =>
  invoke<string>("flows_connector_test", { connector, credential, fields: fields ?? null });

export const flowsLoadTree = (workspaceId: string) => invoke<FlowsTree>("flows_load_tree", { workspaceId });

export const flowsGetFlow = (id: string) => invoke<FlowRow | null>("flows_get_flow", { id });

/** Writes a flow to a JSON file: its document and its credentials' names, never a secret. */
export const flowsExportFlow = (id: string, path: string) => invoke<void>("flows_export_flow", { id, path });

/** What an import had to change to fit this workspace. */
export interface FlowImportNotes {
  /** Credentials it named that this workspace has no match for (by name and kind). */
  unmatchedCredentials: string[];
  /** References to things that do not exist here, cleared: `node · parameter`. */
  cleared: string[];
  /** n8n nodes with no counterpart here, kept switched off: `Name (type)`. */
  unmapped: string[];
}

/** Reads a flow file into a new, untrusted, inactive flow of the workspace. */
export const flowsImportFlow = (workspaceId: string, folderId: string | null, path: string, fallbackName: string) =>
  invoke<{ meta: FlowMetaRow; notes: FlowImportNotes }>("flows_import_flow", { workspaceId, folderId, path, fallbackName });

/** Trusts what a flow runs, as reviewed — refused with `changed` when it changed since. */
export const flowsTrustFlow = (id: string, execHash: string) => invoke<FlowMetaRow>("flows_trust_flow", { id, execHash });

/** `spec::EXECUTABLE_TYPES`: the nodes whose parameters are code or commands — what a review shows. */
export const EXECUTABLE_TYPES = new Set([
  "code.shell",
  "code.python",
  "code.node",
  "code.command",
  "code.script",
  "code.js",
  "code.ssh",
  "code.docker",
  "app.terminal",
  "app.agent",
  "ai.agent",
  "data.sql",
  "data.mongo",
  "data.redis",
]);

export const flowsCreateFlow = (workspaceId: string, folderId: string | null, name: string, spec?: string) =>
  invoke<FlowMetaRow>("flows_create_flow", { workspaceId, folderId, name, spec: spec ?? null });

/** `keepTrust: false` saves a change the user did not write (an accepted AI proposal). */
export const flowsSaveFlow = (id: string, spec: string, expectedVersion: number | null, keepTrust = true) =>
  invoke<FlowSaved>("flows_save_flow", { id, spec, expectedVersion, keepTrust });

/** A flow the model wrote, checked by the backend — the whole document and what it says it did. */
export interface FlowBuilt {
  spec: string;
  summary: string;
}

/** The AI builder (`flows::builder`): nothing is saved, the answer is a proposal to show. */
export const flowsBuildWithAi = (args: {
  workspaceId: string;
  flowName: string;
  prompt: string;
  current: string;
  language: string;
  /** What each node type does, in the app's language. */
  notes: Record<string, string>;
  runId: string;
}) => invoke<FlowBuilt>("flows_build_with_ai", args);

export const flowsRenameFlow = (id: string, name: string) =>
  invoke<FlowMetaRow | null>("flows_rename_flow", { id, name });

export const flowsSetDescription = (id: string, description: string) =>
  invoke<FlowMetaRow | null>("flows_set_description", { id, description });

export const flowsMoveFlow = (id: string, folderId: string | null) =>
  invoke<FlowMetaRow | null>("flows_move_flow", { id, folderId });

/**
 * One list of the explorer — a folder's flows, or the top level's — in the order a drag left it:
 * `ids` is that whole list. A drag that crossed lists calls `flowsMoveFlow` first. Only the
 * workspace's own flows are renumbered; see `flow_queries::reorder_flows`.
 */
export const flowsReorderFlows = (workspaceId: string, ids: string[]) =>
  invoke<void>("flows_reorder_flows", { workspaceId, ids });

/** The workspace's folders — one flat list — in the order a drag left them. */
export const flowsReorderFolders = (workspaceId: string, ids: string[]) =>
  invoke<void>("flows_reorder_folders", { workspaceId, ids });

export const flowsSetScope = (id: string, global: boolean) =>
  invoke<FlowMetaRow | null>("flows_set_scope", { id, global });

export const flowsMoveToWorkspace = (id: string, workspaceId: string) =>
  invoke<FlowMetaRow | null>("flows_move_to_workspace", { id, workspaceId });

export const flowsDuplicateFlow = (id: string, name: string) =>
  invoke<FlowMetaRow | null>("flows_duplicate_flow", { id, name });

/** `flow_queries::FlowTemplateMeta`: a template the user saved from a flow, offered in every workspace. */
export interface FlowTemplateMeta {
  id: string;
  name: string;
  description: string;
  /** The node type whose glyph stands for it: the first trigger of the flow it came from. */
  icon: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export const flowsListTemplates = () => invoke<FlowTemplateMeta[]>("flows_list_templates");

/** Saves a flow as a template — a new one, or over `replace`, which keeps its name and description. */
export const flowsSaveTemplate = (flowId: string, name: string, replace: string | null) =>
  invoke<FlowTemplateMeta>("flows_save_template", { flowId, name, replace });

export const flowsUpdateTemplate = (id: string, name: string, description: string) =>
  invoke<FlowTemplateMeta>("flows_update_template", { id, name, description });

export const flowsDeleteTemplate = (id: string) => invoke<void>("flows_delete_template", { id });

/** A flow from one of the user's templates — trusted only while it runs what was trusted when saved. */
export const flowsCreateFromTemplate = (workspaceId: string, folderId: string | null, templateId: string, name: string) =>
  invoke<FlowMetaRow>("flows_create_from_template", { workspaceId, folderId, templateId, name });

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

export type FlowRunStatus = "running" | "waiting" | "success" | "error" | "canceled" | "interrupted";

/** `flow_run_queries::FlowWaitRow` — a run parked at a node until someone decides; also `flows:wait`. */
export interface FlowWait {
  id: string;
  runId: string;
  flowId: string;
  workspaceId: string;
  flowName: string;
  nodeId: string;
  nodeName: string;
  kind: "approval" | "webhook" | "time";
  message: string;
  createdAt: string;
  expiresAt: string | null;
  /** `null` while it is open. */
  decidedAt: string | null;
  decision: string;
  decidedBy: string;
  payload: unknown;
}

/** The open waits of a workspace, oldest first. */
export const flowsListWaits = (workspaceId: string) => invoke<FlowWait[]>("flows_list_waits", { workspaceId });

/** Approves or rejects an approval; `resumed` lets a wait for a call or a time go on. Refused with
 *  `already-decided` when the other device got there first. */
export const flowsDecideWait = (id: string, decision: "approved" | "rejected" | "resumed", comment?: string) =>
  invoke<FlowWait>("flows_decide_wait", { id, decision, comment: comment ?? null });

/** Where a run's "wait for a call" node listens — the webhook server's address with `/resume/<run>`. */
export function resumeUrlOf(webhookBase: string, runId: string): string {
  return `${webhookBase.replace(/\/hooks\/?$/, "")}/resume/${runId}`;
}
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
  /** What the run filed about itself with «Datos de la ejecución». */
  customData?: Record<string, unknown>;
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

/** `input` is what the run's form was filled with (`flowsRunForm`); `null` lets the trigger use
 *  its fields' defaults. */
/** A flow file in one of the workspace's repositories (`.codeflow/flows/`) and where it stands. */
export interface RepoFlowEntry {
  projectId: string;
  projectName: string;
  path: string;
  name: string;
  description: string;
  nodeCount: number;
  hash: string;
  error: string | null;
  flowId: string | null;
  /** The file moved on disk since it was last written or read here (a pull, a checkout). */
  fileChanged: boolean;
  /** The flow was edited here since it last agreed with the file. */
  flowChanged: boolean;
  missing: boolean;
}

export interface RepoLink {
  flowId: string;
  projectId: string;
  path: string;
  fileHash: string;
  syncedAt: string;
}

export const flowsRepoScan = (workspaceId: string) => invoke<RepoFlowEntry[]>("flows_repo_scan", { workspaceId });
export const flowsRepoImport = (workspaceId: string, projectId: string, path: string, folderId: string | null) =>
  invoke<{ meta: FlowMetaRow; notes: FlowImportNotes }>("flows_repo_import", { workspaceId, projectId, path, folderId });
/** `changed` (as the error) when the linked file moved on disk and `force` is not set. */
export const flowsRepoSave = (flowId: string, projectId: string | null, force = false) => invoke<RepoLink>("flows_repo_save", { flowId, projectId, force });
export const flowsRepoPull = (flowId: string) => invoke<FlowSaved>("flows_repo_pull", { flowId });
export const flowsRepoUnlink = (flowId: string) => invoke<void>("flows_repo_unlink", { flowId });

/** `flow_run_queries::FlowMetrics`: a flow's finished executions over a window. */
export interface FlowMetrics {
  runs: number;
  success: number;
  error: number;
  canceled: number;
  medianMs: number | null;
  p95Ms: number | null;
  days: { date: string; success: number; error: number }[];
  failingNodes: { nodeId: string; name: string; count: number }[];
  slowNodes: { nodeId: string; name: string; avgMs: number }[];
  byMode: [string, number][];
}

/** `flow_run_queries::RunPeriod`: one week or month of a workspace's executions. */
export interface FlowRunPeriod {
  /** Its first day, `YYYY-MM-DD`: a Monday, or the 1st. */
  start: string;
  success: number;
  error: number;
  /** Canceled and interrupted. */
  canceled: number;
  /** Each flow that ran in it, most runs first. */
  flows: { flowId: string; name: string; success: number; error: number; canceled: number }[];
}

export type FlowPeriodUnit = "week" | "month";

/** The workspace's executions by week or month, oldest first — from day counters that outlive the
 *  executions themselves, so a month is a whole month. */
export const flowsRunPeriods = (workspaceId: string, unit: FlowPeriodUnit, count = 12) =>
  invoke<FlowRunPeriod[]>("flows_run_periods", { workspaceId, unit, count });

/** How a flow has been doing over its last `days`, bucketed by the person's own days. */
export const flowsMetrics = (flowId: string, days = 30) =>
  invoke<FlowMetrics>("flows_metrics", { flowId, days, offsetMinutes: -new Date().getTimezoneOffset() });

/** Runs a flow a `codeflow --flow <name>` asked for, once the window said yes. */
export const flowsConfirmLink = (flowId: string, nodeId: string, item: unknown) => invoke<void>("flows_confirm_link", { flowId, nodeId, item });

/** This build's own command line to start a flow by its link name. */
export const flowsCliCommand = (name: string) => invoke<string>("flows_cli_command", { name });

/** `flows_mcp_info`: the MCP server flows are offered on, its token and the tools on offer. */
export interface FlowMcpInfo {
  url: string;
  token: string;
  tools: { name: string; description: string; flowId: string; flowName: string }[];
}

export const flowsMcpInfo = () => invoke<FlowMcpInfo>("flows_mcp_info");
export const flowsMcpRotate = () => invoke<string>("flows_mcp_rotate");

/** `flows::tunnel::TunnelStatus`: the webhooks' public address. */
export interface FlowTunnelStatus {
  kind: "off" | "cloudflared" | "tailscale";
  url: string | null;
  starting: boolean;
  error: string | null;
}

export const flowsTunnelStatus = () => invoke<FlowTunnelStatus>("flows_tunnel_status");
export const flowsTunnelSet = (kind: FlowTunnelStatus["kind"]) => invoke<FlowTunnelStatus>("flows_tunnel_set", { kind });

/** An app event only the window knows about (an agents chain finishing), for "Evento de CodeFlow". */
export const flowsAppEvent = (event: "agentChainFinished", payload: Record<string, unknown>) => invoke<void>("flows_app_event", { event, payload });

/** Starts a past run again: the same input, or (`fromFailed`) only from where it failed. */
export const flowsRetryRun = (runId: string, fromFailed: boolean) => invoke<FlowRunRow>("flows_retry_run", { runId, fromFailed });

export const flowsRun = (flowId: string, mode: FlowRunMode, trigger?: string | null, input?: Record<string, unknown> | null) =>
  invoke<FlowRunRow>("flows_run", { flowId, mode, trigger: trigger ?? null, input: input ?? null });

/** One field of a manual trigger's form — `flows::form::FormField`. */
export interface FlowFormField {
  name: string;
  label: string;
  type: "text" | "longText" | "number" | "boolean" | "select" | "date";
  required: boolean;
  default: unknown;
  options: string[];
}

/** The form a run asks for before it starts, or `null` when its trigger has none. */
export interface FlowRunForm {
  triggerId: string;
  triggerName: string;
  fields: FlowFormField[];
}

export const flowsRunForm = (flowId: string, mode: FlowRunMode, trigger?: string | null) =>
  invoke<FlowRunForm | null>("flows_run_form", { flowId, mode, trigger: trigger ?? null });

/** The main window's answer to a run's question — `lib/flows/bridge.ts`. */
export const flowsBridgeAnswer = (id: string, ok: boolean, value: unknown, error: string | null) =>
  invoke<boolean>("flows_bridge_answer", { id, ok, value, error });

export const flowsCancelRun = (runId: string) => invoke<boolean>("flows_cancel_run", { runId });

export const flowsActiveRuns = (workspaceId: string) => invoke<FlowRunRow[]>("flows_active_runs", { workspaceId });

export const flowsListRuns = (flowId: string, limit?: number, before?: string | null, search?: string | null) =>
  invoke<FlowRunRow[]>("flows_list_runs", { flowId, limit: limit ?? null, before: before ?? null, search: search?.trim() ? search.trim() : null });

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

export type FlowCredentialKind = "bearer" | "basic" | "header" | "query" | "hmac" | "smtp" | "imap" | "webhook" | "oauth2" | "aws";

/** A credential as the frontend sees it: never the secret. */
export interface FlowCredential {
  id: string;
  workspaceId: string;
  scope: "workspace" | "global";
  name: string;
  kind: FlowCredentialKind;
  meta: {
    user?: string;
    name?: string;
    host?: string;
    port?: string;
    security?: string;
    from?: string;
    /** OAuth 2: who signs in (`google`, `microsoft`, `custom`) and as which client. */
    provider?: string;
    clientId?: string;
    tenant?: string;
    authUrl?: string;
    tokenUrl?: string;
    scopes?: string;
    redirectUri?: string;
    /** AWS: the region a request goes to when its address does not say. */
    region?: string;
    /** Set by `flows_oauth_connect`: the account it signed in as, and that it did. */
    account?: string;
    connected?: boolean;
  };
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

/** Signs an OAuth 2 credential in, in the browser; resolves once the tokens are in the keychain. */
export const flowsOauthConnect = (id: string) => invoke<FlowCredential>("flows_oauth_connect", { id });

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
  /** The same webhook on the internet, while a tunnel is up (`flows::tunnel`). */
  publicUrl: string | null;
  next: string | null;
  /** A schedule's occurrences in the day from its next one (`schedule::outlook`). */
  upcoming: string[];
  /** Instead of `upcoming`, for a schedule too busy to list: the stretches that hold any. */
  busy: { from: string; to: string }[];
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

/** Tries a credential for real: an SMTP account signs in; an HTTP one signs a GET to `url`. */
export const flowsTestCredential = (id: string, url?: string) => invoke<string>("flows_test_credential", { id, url: url ?? null });

/** `flows:open` — a flow asked the window to show one of its views. */
export interface FlowOpenEvent {
  kind: string;
  target: string;
  workspaceId: string;
}

/** `flows:terminal` — a flow asked for a visible terminal running a command. */
export interface FlowTerminalEvent {
  command: string;
  cwd: string;
  projectId: string;
  title: string;
  workspaceId: string;
}

/** The models a local server lists, for the Local model node. */
export const flowsLocalModels = (server: string, url: string) => invoke<string[]>("flows_local_models", { server, url });

/** The models a provider's API offers (`chat` or `embed`), read with the node's credential. */
export const flowsAiModels = (provider: string, baseUrl: string, credentialId: string | null, purpose: "chat" | "embed") =>
  invoke<string[]>("flows_ai_models", { provider, baseUrl, credentialId, purpose });

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

// ---------- sharing (the user's own Supabase project — `flows::share`) ----------

/** `flow_share_queries::FlowShareRow`. */
export interface FlowShareRow {
  flowId: string;
  projectUrl: string;
  name: string;
  role: "owner" | "member";
  cursor: string;
  base: string;
  /** The remote version waiting while both sides changed, as JSON text. */
  conflict: string | null;
  conflictAt: string | null;
  lastError: string;
  syncedAt: string;
}

/** `share::Round`. */
export interface FlowShareRound {
  state: "synced" | "conflict";
  applied: boolean;
  pushed: boolean;
  meta: FlowMetaRow | null;
}

/** `flows:shared` — a teammate's version was applied, or a conflict appeared. */
export interface FlowSharedEvent {
  flowId: string;
  applied: boolean;
  state: "synced" | "conflict";
}

export const flowsShares = () => invoke<FlowShareRow[]>("flows_shares");

export const flowsShare = (url: string, flowId: string) =>
  invoke<{ id: string; name: string; share_token: string }>("flows_share", { url, flowId });

export const flowsJoinShared = (url: string, token: string, workspaceId: string, folderId: string | null) =>
  invoke<FlowMetaRow>("flows_join_shared", { url, token, workspaceId, folderId });

export const flowsShareTick = (flowId: string) => invoke<FlowShareRound | null>("flows_share_tick", { flowId });

export const flowsShareSync = (flowId: string) => invoke<FlowShareRound>("flows_share_sync", { flowId });

export const flowsShareResolve = (flowId: string, keepMine: boolean) =>
  invoke<FlowShareRound>("flows_share_resolve", { flowId, keepMine });

export const flowsShareRotate = (flowId: string) => invoke<string>("flows_share_rotate", { flowId });

export const flowsShareLeave = (flowId: string) => invoke<void>("flows_share_leave", { flowId });

// ---------- «Transformar con IA» ----------

/** What «Generar código» answers: the code, tried once against the node's input in the newest run. */
export interface FlowTransformCode {
  code: string;
  summary: string;
  tested: boolean;
  inputCount: number;
  outputCount?: number;
  preview?: unknown[];
  error?: string;
}

export const flowsAiTransformCode = (flowId: string, nodeId: string, spec: string | null, runId: string | null) =>
  invoke<FlowTransformCode>("flows_ai_transform_code", { flowId, nodeId, spec, runId });

// ---------- tables («Tablas») ----------

/** `flows::tables::TableInfo`. */
export interface FlowTable {
  id: string;
  workspaceId: string;
  name: string;
  columns: string[];
  rows: number;
  createdAt: string;
  updatedAt: string;
}

/** `flows::tables::RowView`. */
export interface FlowTableRow {
  key: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const flowsTablesList = (workspaceId: string) => invoke<FlowTable[]>("flows_tables_list", { workspaceId });
export const flowsTableCreate = (workspaceId: string, name: string) => invoke<FlowTable>("flows_table_create", { workspaceId, name });
export const flowsTableRename = (tableId: string, name: string) => invoke<FlowTable>("flows_table_rename", { tableId, name });
export const flowsTableDelete = (tableId: string) => invoke<void>("flows_table_delete", { tableId });
export const flowsTableRows = (tableId: string, offset: number, limit: number, search: string | null) =>
  invoke<{ table: FlowTable; rows: FlowTableRow[]; total: number }>("flows_table_rows", { tableId, offset, limit, search });
export const flowsTablePutRow = (tableId: string, key: string, data: Record<string, unknown>, previousKey: string | null) =>
  invoke<FlowTableRow | null>("flows_table_put_row", { tableId, key, data, previousKey });
export const flowsTableDeleteRows = (tableId: string, keys: string[]) => invoke<number>("flows_table_delete_rows", { tableId, keys });
export const flowsTableClear = (tableId: string) => invoke<number>("flows_table_clear", { tableId });
export const flowsTableDropColumn = (tableId: string, column: string) => invoke<void>("flows_table_drop_column", { tableId, column });
export const flowsTableSetColumns = (tableId: string, columns: string[]) => invoke<void>("flows_table_set_columns", { tableId, columns });
export const flowsTableImport = (tableId: string, rows: Record<string, unknown>[], keyField: string | null) =>
  invoke<number>("flows_table_import", { tableId, rows, keyField });

// ---------- tests («Pruebas») ----------

/** `flows::testing::FlowTest`. */
export interface FlowTest {
  id: string;
  flowId: string;
  name: string;
  input: unknown;
  nodeId: string;
  expected: unknown;
  matchMode: "contains" | "equals" | "runs";
  sortOrder: number;
  lastStatus: string;
  lastDetail: string;
  lastRunAt: string;
}

/** `flows::testing::TestOutcome`. */
export interface FlowTestOutcome {
  id: string;
  name: string;
  status: "passed" | "failed";
  detail: string;
  runId: string | null;
}

export const flowsTestsList = (flowId: string) => invoke<FlowTest[]>("flows_tests_list", { flowId });
export const flowsTestSave = (test: FlowTest) => invoke<FlowTest>("flows_test_save", { test });
export const flowsTestDelete = (id: string) => invoke<void>("flows_test_delete", { id });
export const flowsTestsRun = (flowId: string, ids: string[] | null) => invoke<FlowTestOutcome[]>("flows_tests_run", { flowId, ids });

// ---------- «Mis nodos», right-click entries, chat flows ----------

/** A flow published as a node by its «Llamado por otro flujo» trigger. */
export interface FlowPublishedNode {
  flowId: string;
  name: string;
  icon: string;
  description: string;
  fields: { name: string; label: string; type: string; required: boolean; options: string[]; default: unknown }[];
  scope: string;
}

export const flowsPublishedNodes = (workspaceId: string) => invoke<FlowPublishedNode[]>("flows_published_nodes", { workspaceId });

/** `triggers::ContextEntry` — «Menú contextual». */
export interface FlowContextEntry {
  flowId: string;
  nodeId: string;
  flowName: string;
  workspaceId: string;
  scope: string;
  label: string;
  places: string[];
  glob: string;
  askFirst: boolean;
}

export type FlowContextPlace = "file" | "folder" | "selection" | "commit" | "pr";

export const flowsContextEntries = (workspaceId: string, place: FlowContextPlace, path?: string | null) =>
  invoke<FlowContextEntry[]>("flows_context_entries", { workspaceId, place, path: path ?? null });

export const flowsContextRun = (flowId: string, nodeId: string, payload: Record<string, unknown>) =>
  invoke<{ held: boolean; runId: string | null }>("flows_context_run", { flowId, nodeId, payload });

/** `triggers::ChatAssistant` — a flow the Chat app can talk to. */
export interface FlowChatAssistant {
  flowId: string;
  nodeId: string;
  flowName: string;
  workspaceId: string;
  scope: string;
  name: string;
  description: string;
  historyTurns: number;
}

export const flowsChatAssistants = (workspaceId: string) => invoke<FlowChatAssistant[]>("flows_chat_assistants", { workspaceId });

export const flowsChatTurn = (flowId: string, message: string, history: { role: string; text: string }[], conversationId: string | null) =>
  invoke<{ text: string; runId: string | null; name: string }>("flows_chat_turn", { flowId, message, history, conversationId });
