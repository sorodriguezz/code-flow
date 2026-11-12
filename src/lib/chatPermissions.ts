/**
 * The chat composers' permissions selector, beside «Plan».
 *
 * - **Restringido** (`restricted`, the default): the turn runs as every turn always has — commands
 *   and edits go ahead, but a destructive command (`rm -rf`, a force-push, a dropped table…), the use
 *   of a saved credential and a destructive app action each wait for the user's yes.
 * - **Completo** (`full`): the turn asks nothing. Claude runs with `bypassPermissions`, Codex outside
 *   its workspace sandbox, and every approval CodeFlow would have shown is a yes
 *   (`agentcli::FULL_ACCESS` in the backend).
 *
 * Plan mode wins over both: a plan turn is read-only whatever this says, so the backend ignores
 * `full` on it and the composer greys the selector out.
 */
export type ChatPermissions = "restricted" | "full";

export const DEFAULT_CHAT_PERMISSIONS: ChatPermissions = "restricted";

/** What a turn sends as `permissions`: only `"full"` means anything to the backend. */
export function permissionsArg(permissions: ChatPermissions | undefined, plan: boolean): "full" | null {
  return !plan && permissions === "full" ? "full" : null;
}
