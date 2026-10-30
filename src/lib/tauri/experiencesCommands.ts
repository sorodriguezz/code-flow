import { invoke } from "./invoke";

/**
 * Experiences — what happened after an AI answer, kept as evidence. Mirrors
 * `src-tauri/src/experiences/mod.rs` and `commands/experiences_cmd.rs`.
 */

export type ExperienceSource =
  | "turn_review"
  | "apply_code"
  | "checkpoint_restore"
  | "hybrid_check"
  | "fix_verify"
  | "chat"
  | "memory"
  | "manual";

export type ExperienceSignal = "accepted" | "rejected" | "reverted" | "passed" | "failed" | "error" | "cancelled" | "corrected";

export type ExperienceQuality = "unreviewed" | "approved" | "excluded";

export interface NewExperience {
  workspaceId?: string | null;
  projectId?: string | null;
  source: ExperienceSource;
  signal: ExperienceSignal;
  provider?: string | null;
  model?: string | null;
  task?: string | null;
  runRef?: string | null;
  prompt?: string | null;
  response?: string | null;
  detail?: Record<string, unknown>;
  /** The checkout it happened in, when the project id is not at hand: resolved by the backend. */
  repoPath?: string | null;
}

export interface Experience {
  id: string;
  createdAt: number;
  workspaceId: string | null;
  projectId: string | null;
  source: ExperienceSource;
  signal: ExperienceSignal;
  provider: string | null;
  model: string | null;
  digest: string | null;
  task: string | null;
  runRef: string | null;
  prompt: string | null;
  response: string | null;
  detail: Record<string, unknown> | null;
  trainingAllowed: boolean;
  quality: ExperienceQuality;
}

export interface ExperienceFilter {
  workspaceId?: string | null;
  source?: string | null;
  signal?: string | null;
  quality?: string | null;
  limit?: number;
}

/** Fire-and-forget: an experience lost is better than an action that fails over it. */
export function recordExperience(input: NewExperience) {
  void invoke<string | null>("ai_experience_record", { input }).catch(() => {});
}

export const aiExperiencesList = (filter?: ExperienceFilter) => invoke<Experience[]>("ai_experiences_list", { filter: filter ?? null });
export const aiExperiencesCounts = (workspaceId?: string | null) =>
  invoke<[string, number][]>("ai_experiences_counts", { workspaceId: workspaceId ?? null });
export const aiExperienceSetQuality = (id: string, quality: ExperienceQuality) => invoke<void>("ai_experience_set_quality", { id, quality });
export const aiExperienceDelete = (id: string) => invoke<void>("ai_experience_delete", { id });
export const aiExperiencesClear = (workspaceId?: string | null) => invoke<number>("ai_experiences_clear", { workspaceId: workspaceId ?? null });
export const aiExperiencesExport = (path: string, filter?: ExperienceFilter) =>
  invoke<number>("ai_experiences_export", { filter: filter ?? null, path });
export const aiTrainingAllowed = (workspaceId: string) => invoke<boolean>("ai_training_allowed", { workspaceId });
export const aiSetTrainingAllowed = (workspaceId: string, allowed: boolean) =>
  invoke<void>("ai_set_training_allowed", { workspaceId, allowed });
