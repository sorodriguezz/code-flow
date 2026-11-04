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

/** The decision layer's settings (`src-tauri/src/decide`). */
export interface DeciderConfig {
  enabled: boolean;
  engine: "auto" | "local" | "cloud" | "jev" | "off";
  forks: number;
  threshold: number;
  risk_threshold: number;
  jev_url: string;
}

export interface DeciderVerdict {
  choice: string | null;
  p: number;
  sharp: boolean;
  source: string;
  votes: string[];
  ms: number;
}

export const deciderConfig = () => invoke<DeciderConfig>("decider_config");
export const deciderSet = (config: DeciderConfig) => invoke<DeciderConfig>("decider_set", { config });
export const deciderTry = () => invoke<DeciderVerdict>("decider_try");
