import type { useT } from "../../state/languageStore";

/** What `create_hybrid_chain` stores as a hybrid run's execute-step agent name: an identifier, not
 *  copy. Matches `queries::LOCAL_EXEC_AGENT_NAME`. */
export const LOCAL_EXEC_AGENT_NAME = "Local model";

/**
 * The name to draw for a step or a task. A hybrid run's execute step has no roster agent behind it —
 * the backend stores a fixed English name — so that one is said in the reader's language.
 *
 * Told apart by provider wherever there is one. A step brief carries none, and only there does the
 * stored name decide, so a roster agent somebody named "Local model" keeps its name everywhere else.
 */
export function agentName(name: string, provider: string | undefined, t: ReturnType<typeof useT>): string {
  const isExecutor = provider === undefined ? name === LOCAL_EXEC_AGENT_NAME : provider === "local-exec";
  return isExecutor ? t("localexec.title") : name;
}
