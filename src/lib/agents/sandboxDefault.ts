import { teamSandboxStatus } from "../tauri/teamCommands";
import type { TeamPolicy } from "../../types/team";

/**
 * A new team's policy with its checks isolated when this computer can isolate them. A team is
 * never switched behind its back: only the ones made from now on start this way, and only where a
 * container engine answers — otherwise they start on this computer, as the editor shows.
 */
export async function withSandboxDefault(policy: TeamPolicy): Promise<TeamPolicy> {
  if (policy.sandbox === "checks") return policy;
  try {
    const status = await teamSandboxStatus();
    return status.available ? { ...policy, sandbox: "checks" } : policy;
  } catch {
    return policy;
  }
}
