import { invoke } from "./invoke";

/**
 * The bench and the model registry. Mirrors `src-tauri/src/commands/evals_cmd.rs`,
 * `src-tauri/src/evals/report.rs` and `src-tauri/src/model_registry/store.rs`.
 */

export type EvalSuite = "speed" | "tools" | "text" | "agent" | "retrieval";

export interface EvalProgress {
  step: string;
  done: number;
  total: number;
}

/** What arrives on `ai:eval`. */
export interface EvalEvent {
  state: "progress" | "done" | "failed";
  progress: EvalProgress | null;
  model: string | null;
  evaluationId: string | null;
  score: number | null;
  error: string | null;
}

export interface EvalStatus {
  running: boolean;
  progress: EvalProgress | null;
  model: string | null;
}

export interface EvalSpeed {
  sent_tokens: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  prompt_tps: number | null;
  gen_tps: number | null;
  first_token_ms: number | null;
  total_ms: number;
  gpu_share: number | null;
  truncated: boolean;
}

export interface EvalCase {
  id: string;
  passed: boolean;
  native: boolean;
  detail: string;
}

export interface EvalConformance {
  cases: EvalCase[];
  passed: number;
  total: number;
  parallel: boolean;
}

export interface EvalTaskResult {
  id: string;
  suite: EvalSuite;
  runs: number;
  passed: number;
  seconds: number[];
  failures: string[];
  prompt_tokens: number;
  completion_tokens: number;
  skipped: string | null;
}

export interface EvalMachine {
  os: string;
  arch: string;
  ram_gb: number;
  gpu: string;
  gpu_name: string | null;
  gpu_gb: number | null;
}

export interface EvalReport {
  format: number;
  app_version: string | null;
  started_at: string;
  finished_at: string;
  backend: string;
  model: string;
  model_digest: string | null;
  adapter: string | null;
  ctx: number;
  machine: EvalMachine;
  speed: EvalSpeed | null;
  conformance: EvalConformance | null;
  tasks: EvalTaskResult[];
  peak_rss_bytes: number | null;
  score: number;
  aborted: string | null;
}

export interface EvaluationRow {
  id: string;
  backend: string;
  model: string;
  digest: string | null;
  adapter_id: string | null;
  score: number;
  tools_passed: number | null;
  tools_total: number | null;
  created_at: number;
  report: EvalReport;
}

export interface EvalDelta {
  id: string;
  before: [number, number];
  after: [number, number];
  seconds_before: number | null;
  seconds_after: number | null;
}

export interface EvalComparison {
  score_before: number;
  score_after: number;
  tools_before: number | null;
  tools_after: number | null;
  tasks: EvalDelta[];
  regressions: string[];
}

export interface ModelDeclared {
  tools: boolean;
  thinking: boolean;
  vision: boolean;
  insert: boolean;
  embedding: boolean;
}

export interface ModelRecord {
  id: string;
  backend: string;
  model: string;
  digest: string | null;
  family: string | null;
  declared: ModelDeclared;
  /** `null`: never tested. */
  tools_verified: boolean | null;
  verified_digest: string | null;
  conformance: EvalConformance | null;
  updated_at: number;
}

/** The verdict that applies to the model's current bytes — a re-pull that changed the digest
 *  makes an old verdict a statement about different weights. Mirrors `ModelRecord::current_verdict`. */
export function currentVerdict(record: ModelRecord | undefined): boolean | null {
  if (!record) return null;
  if (record.digest && record.verified_digest && record.digest !== record.verified_digest) return null;
  return record.tools_verified;
}

export interface EvalRequest {
  runs?: number;
  suites?: EvalSuite[];
  only?: string[];
  model?: string;
}

/** Starts a run; the outcome arrives on `ai:eval`. Rejects with `busy` while one is running. */
export const aiEvalRun = (request: EvalRequest) => invoke<void>("ai_eval_run", { request });
export const aiEvalStatus = () => invoke<EvalStatus>("ai_eval_status");
export const aiEvalCancel = () => invoke<void>("ai_eval_cancel");
export const aiEvalList = (limit?: number) => invoke<EvaluationRow[]>("ai_eval_list", { limit });
export const aiEvalDelete = (id: string) => invoke<void>("ai_eval_delete", { id });
export const aiEvalCompare = (before: string, after: string) => invoke<EvalComparison>("ai_eval_compare", { before, after });
export const aiModelRegistryList = () => invoke<ModelRecord[]>("ai_model_registry_list");

export interface RuntimeStatus {
  executor: string | null;
  completion: string | null;
  embedder: string | null;
  /** `[model, bytes, bytes on the GPU]`. */
  ollama: [string, number, number][];
  pressure: "normal" | "warning" | "critical" | "unknown";
  sandbox: boolean;
}

export interface AuditRow {
  at: number;
  runRef: string | null;
  model: string | null;
  tool: string;
  level: string;
  args: string;
  outcome: string;
  exitCode: number | null;
  durationMs: number | null;
  detail: string;
}

export const aiRuntimeStatus = () => invoke<RuntimeStatus>("ai_runtime_status");
export const aiToolAuditList = (workspaceId?: string | null, limit?: number) =>
  invoke<AuditRow[]>("ai_tool_audit_list", { workspaceId: workspaceId ?? null, limit: limit ?? null });
