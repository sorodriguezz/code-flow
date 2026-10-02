import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentChain, ChainDetail, ChainTemplate, HybridTemplateConfig } from "../../types/domain";

/**
 * The hybrid task, from the frontend's side. Mirrors `src-tauri/src/commands/hybrid_cmd.rs`.
 *
 * A hybrid run is a chain (`kind: "hybrid"`, phases `plan` → `execute` → `review`) and is pumped like
 * every other one; what is here is what only it has — its frozen configuration, its plan's tasks, the
 * gate that edits them, and the undo against its baseline.
 */

export interface HybridRegion {
  start_line: number;
  end_line: number;
  first_line: string;
}

export interface HybridReference {
  /** The repository's project id; `null` is the task's own. */
  repo: string | null;
  file: string;
  start_line: number | null;
  end_line: number | null;
  first_line: string | null;
  why: string;
}

/** A command that validates the change, and the repository (project id) it runs in. Mirrors
 *  `hybrid::plan::PlanCheck`. */
export interface HybridCheck {
  repo: string;
  command: string;
}

/** A run's configuration, frozen when it was created. Mirrors `hybrid_queries::HybridRun`. */
export interface HybridRun {
  chain_id: string;
  backend: "bundled" | "ollama" | "openai";
  base_url: string;
  model: string;
  ctx: number;
  budget_input: number;
  budget_output: number;
  delegate: "easy" | "medium" | "all";
  on_fail: "review" | "skip";
  review_mode: "local" | "fix" | "report";
  unload: boolean;
  thinking: boolean;
  plan_summary: string;
  plan_risks: string[];
  checks: HybridCheck[];
  approved_checks: HybridCheck[];
  gate_note: string;
  baseline_commit: string;
  plan_input_tokens: number;
  plan_output_tokens: number;
  review_input_tokens: number;
  review_output_tokens: number;
  /** Small enough to skip the plan: the local model wrote it straight from the objective. */
  direct: boolean;
  /** How many rounds of corrections the review has handed back to the local model. */
  fix_round: number;
  /** Why the review was skipped: a direct run, or a small plan whose checks passed. */
  review_skip: "" | "direct" | "small";
  created_at: string;
  updated_at: string;
}

export type HybridItemStatus = "pending" | "running" | "done" | "failed" | "skipped" | "escalated" | "reviewed";

/** Why a task did not get done locally. Matches `hybrid::execute::why`. */
export type HybridWhy = "file" | "moved" | "too-big" | "cut-prompt" | "server" | "answer" | "changed" | "dependency";

/** One task of the plan. Mirrors `hybrid_queries::HybridItem`. */
export interface HybridItem {
  id: string;
  chain_id: string;
  ord: number;
  task_key: string;
  title: string;
  file: string;
  action: "create" | "modify" | "delete";
  regions: HybridRegion[];
  instruction: string;
  context: HybridReference[];
  acceptance: string[];
  depends_on: string[];
  difficulty: "easy" | "medium" | "hard";
  assignee: "local" | "sub";
  enabled: boolean;
  status: HybridItemStatus;
  attempts: number;
  /** English: it is what the review model reads. The panel shows {@link HybridItem.error_code}. */
  error: string;
  /** The kind of failure — `hybrid::execute::why`. Empty when there is none. */
  error_code: HybridWhy | "";
  tokens_in: number;
  tokens_out: number;
  ms: number;
  lines_added: number;
  lines_removed: number;
  hash_before: string;
  hash_after: string;
  updated_at: string;
  /** The repository it writes in; empty is the run's first. */
  project_id: string;
  /** 0 for the plan's tasks, n for the corrections of round n. */
  round: number;
}

export interface HybridView {
  run: HybridRun;
  items: HybridItem[];
  /** The run's repositories, first one first. */
  repos: { project_id: string; name: string }[];
  /** Checks approved before in these repositories — pre-ticked at the gate. */
  trusted_checks: HybridCheck[];
  max_fix_rounds: number;
}

/** Whether a task can go straight to the local model. Mirrors `hybrid::triage::Triage`. */
export interface HybridTriage {
  direct: boolean;
  /** `multi-repo` | `not-ready` | `no-files` | `not-found` | `ambiguous` | `too-many-files` |
   *  `too-long` | `file-too-big`; empty when it can. */
  reason: string;
  files: { path: string; tokens: number }[];
}

/** A file a run changed, in one of its repositories. */
export interface RunFile {
  project_id: string;
  repo: string;
  path: string;
}

export type { HybridTemplateConfig };

/** An edit made at the gate. */
export interface HybridItemEdit {
  id: string;
  instruction: string;
  assignee: "local" | "sub";
  enabled: boolean;
}

/** What `create_hybrid_task` rejects with when the local model cannot run: a translation key. A wire
 *  constant — it must match `hybrid_cmd::NOT_READY`. */
export const LOCAL_NOT_READY = "localexec.notReady";

/** What `create_hybrid_task` rejects with when the planner's CLI cannot be given several working
 *  copies: a translation key. Matches `hybrid_cmd::MULTI_REPO_UNSUPPORTED`. */
export const MULTI_REPO_UNSUPPORTED = "chain.multiRepoUnsupported";

/** The providers whose CLI takes more than one working copy — one plan across several
 *  repositories. Mirrors `AiEngine::supports_extra_dirs`. */
export const SPANS_REPOS = new Set(["claude", "codex", "gemini"]);

/** Creates a run, frozen with the local model as Settings resolve it now. Several repositories make
 *  one plan across them; `direct_files` makes it a direct run (checked again on the way in). */
export const createHybridTask = (task: {
  project_ids: string[];
  title: string;
  goal: string;
  planner_agent_id: string;
  reviewer_agent_id?: string;
  agent_project_id: string;
  gate: boolean;
  direct_files?: string[] | null;
  overrides?: { review_mode?: string; delegate?: string; checks?: string[] } | null;
}) => invoke<ChainDetail>("create_hybrid_task", { task });

/** Whether the objective names a change small enough for the local model alone. */
export const hybridTriage = (projectIds: string[], goal: string) =>
  invoke<HybridTriage>("hybrid_triage", { projectIds, goal });

export const hybridView = (chainId: string) => invoke<HybridView | null>("hybrid_view", { chainId });

/** Rejects with `chain.gateMoved` when the chain is no longer parked where the caller saw it. */
export const approveHybridPlan = (input: {
  chainId: string;
  stepId: string;
  edits: HybridItemEdit[];
  checks: HybridCheck[];
  note: string;
}) => invoke<AgentChain | null>("approve_hybrid_plan", input);

export const hybridChangedPaths = (chainId: string) => invoke<RunFile[]>("hybrid_changed_paths", { chainId });

/** Restores files to the run's baselines: all of them, or the ones named. */
export const hybridUndo = (chainId: string, files?: RunFile[]) =>
  invoke<RunFile[]>("hybrid_undo", { chainId, files: files ?? null });

/** Saves a hybrid task's setup as a workspace template, or replaces the one `id` names. */
export const upsertHybridTemplate = (
  id: string | undefined,
  workspaceId: string,
  name: string,
  description: string,
  config: HybridTemplateConfig,
) => invoke<ChainTemplate>("upsert_hybrid_template", { id: id ?? null, workspaceId, name, description, config });

export interface HybridItemEvent {
  chain_id: string;
  item: HybridItem;
}

export interface HybridProgressEvent {
  chain_id: string;
  item_id: string;
  tokens: number;
  elapsed_ms: number;
}

export const onHybridItem = (handler: (event: HybridItemEvent) => void) =>
  listen<HybridItemEvent>("hybrid:item", (e) => handler(e.payload));

export const onHybridProgress = (handler: (event: HybridProgressEvent) => void) =>
  listen<HybridProgressEvent>("hybrid:progress", (e) => handler(e.payload));
