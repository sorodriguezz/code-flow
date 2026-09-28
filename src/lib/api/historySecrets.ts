import type { ApiCollection, ApiEnvironment, ApiFolder } from "../../types/api";
import type { HistorySecrets } from "../tauri/apiCommands";

/**
 * What the backend needs to keep a send's credentials out of history: every auth block and every
 * variable list that could have put one on the wire.
 *
 * Handed over whole rather than picked apart here, because the backend already knows which fields of
 * an `AuthConfig` hold a credential (`api_secrets::AUTH_SECRET_FIELDS`) and which variables are
 * secret — a second copy of that list in TypeScript would be a list that drifts, and the one that
 * fell behind would be the one leaving a token in a history row.
 *
 * Every collection and folder of the workspace, not only the sent request's own chain: a scratch tab
 * has no chain, the list is short, and scrubbing a credential that did not happen to be sent costs
 * nothing.
 */
export function historySecrets(state: {
  collections: ApiCollection[];
  folders: ApiFolder[];
  environments: ApiEnvironment[];
}): HistorySecrets {
  const present = (raw: string) => raw.trim() !== "" && raw.trim() !== "[]";
  return {
    auths: [...state.collections.map((c) => c.auth), ...state.folders.map((f) => f.auth)].filter(present),
    variables: [...state.collections.map((c) => c.variables), ...state.environments.map((e) => e.variables)].filter(
      present,
    ),
  };
}
