import type { FlowConnector, FlowLabel } from "../tauri/flowsCommands";
import type { FlowNodeSpec } from "./spec";

/**
 * What a node still needs before it can run, in words — marked on the canvas so an unfinished node
 * is seen before a run fails on it: a Conector without its service, its credential or a required
 * field; a Google or Microsoft node without an account.
 *
 * Only what is certain from the document: a field written as an expression may well be filled at
 * run time, and a credential that merely failed last time is the run's to say.
 */

export type IssueKey = "flows.issue.service" | "flows.issue.credential" | "flows.issue.credentialGone" | "flows.issue.field";
export type Translate = (key: IssueKey, params?: Record<string, string>) => string;

/** The account nodes, and whose account. */
const ACCOUNT_NODES: Record<string, string> = {
  "net.google": "Google",
  "trigger.google": "Google",
  "net.microsoft": "Microsoft 365",
  "trigger.microsoft": "Microsoft 365",
};

const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

export function nodeIssues(
  node: FlowNodeSpec,
  connectors: readonly FlowConnector[],
  /** The workspace's credentials; empty while they load, when a missing one is not yet known. */
  credentialIds: ReadonlySet<string>,
  say: (label: FlowLabel) => string,
  t: Translate,
  /** The catalogue's `call` for the node's type: a node that never touched it runs on it (the
   *  inspector shows it picked), so it is no missing service. */
  defaultCall?: unknown,
): string[] {
  if (node.disabled) return [];
  const params = node.params ?? {};
  const credential = typeof params.credential === "string" ? params.credential.trim() : "";
  const credentialIssue = (service: string): string[] => {
    if (!credential) return [t("flows.issue.credential", { service })];
    if (credentialIds.size > 0 && !credentialIds.has(credential)) return [t("flows.issue.credentialGone")];
    return [];
  };

  const account = ACCOUNT_NODES[node.type];
  if (account) return credentialIssue(account);
  if ((node.type !== "net.connector" && node.type !== "trigger.connector") || connectors.length === 0) return [];

  const given = params.call ?? defaultCall;
  const call = given && typeof given === "object" ? (given as Record<string, unknown>) : {};
  const connector = connectors.find((c) => c.id === call.connector);
  if (!connector) return [t("flows.issue.service")];
  const out: string[] = [];
  if (connector.auth !== "none" && !connector.authOptional) out.push(...credentialIssue(connector.name));
  const operation = connector.operations.find((o) => o.id === call.operation);
  const fields = call.fields && typeof call.fields === "object" ? (call.fields as Record<string, unknown>) : {};
  for (const field of [...(connector.siteField ? [connector.siteField] : []), ...(operation?.fields ?? [])]) {
    if (field.required && !field.default && blank(fields[field.name])) out.push(t("flows.issue.field", { field: say(field.label) }));
  }
  return out;
}
