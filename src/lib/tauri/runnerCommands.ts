import { invoke } from "@tauri-apps/api/core";

/** The workspace-wide limit on agent turns at once (`src-tauri/src/runner/governor.rs`). */
export interface GovernorConfig {
  max_turns: number;
  per_model: Record<string, number>;
}

export interface GovernorStatus {
  max_turns: number;
  running: number;
  waiting: number;
  by_model: Record<string, number>;
  per_model: Record<string, number>;
}

export const governorStatus = () => invoke<GovernorStatus>("governor_status");
export const governorSet = (config: GovernorConfig) => invoke<GovernorStatus>("governor_set", { config });
export const teamPump = (runId: string) => invoke<void>("team_pump", { runId });
