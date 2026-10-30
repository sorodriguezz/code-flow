import { invoke } from "./invoke";

export type ArchAiActionId = "ask" | "review" | "adr" | "threats" | "tutor" | "design";

/** Something an architecture is generated from — see `architecture::sources`. A `cloud` entry is a
 *  snapshot already read with the person's authorization (`architectureCloudRead`), passed as text. */
export type ArchSource =
  | { kind: "repo"; path: string }
  | { kind: "document"; path: string }
  | { kind: "text"; name: string; text: string }
  | { kind: "cloud"; name: string; text: string };

/** One read-only turn of Arquitectura's assistant, with the section's own skills — see
 *  `commands::architecture_cmd`. Answers the model's raw text. `sources` are read again for the
 *  answer to stand on (never a `cloud` one: that needs a fresh authorization). */
export const architectureAi = (args: {
  workspaceId: string | null;
  action: ArchAiActionId;
  question: string;
  document: string;
  context: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  language: string;
  runId: string;
  sources?: ArchSource[];
}) => invoke<string>("architecture_ai", args);

/** A new document from sources (`document` null → an `arch-doc` answer), or changes to the open one
 *  (`document` its text → an `arch-patch` answer). Answers the model's raw text. */
export const architectureGenerate = (args: {
  workspaceId: string | null;
  sources: ArchSource[];
  focus: string;
  document: string | null;
  language: string;
  runId: string;
}) => invoke<string>("architecture_generate", args);

export type RepoFactKind = "compose" | "k8s" | "helm" | "terraform" | "bicep" | "openapi" | "adr" | "dependency" | "env";

export interface RepoFact {
  kind: RepoFactKind;
  path: string;
  /** 1-based. */
  line: number;
  title: string;
  detail: string;
}

export interface RepoScan {
  name: string;
  facts: RepoFact[];
  counts: Partial<Record<RepoFactKind, number>>;
}

/** What a repository's files say, read without a model — the preview before generating. */
export const architectureScanRepo = (path: string) => invoke<RepoScan>("architecture_scan_repo", { path });

export type CloudProvider = "azure" | "aws" | "gcp";

export interface CloudContext {
  id: string;
  name: string;
  detail: string;
  default: boolean;
}

export interface CloudContexts {
  /** Whether the provider's CLI is installed. */
  found: boolean;
  contexts: CloudContext[];
  /** The CLI's own complaint — not signed in, usually. */
  error: string | null;
}

export interface CloudScope {
  id: string;
  name: string;
}

export interface CloudCommandResult {
  command: string;
  ok: boolean;
  error: string | null;
  count: number;
}

export interface CloudResource {
  id: string;
  name: string;
  kind: string;
  location: string;
  group: string;
  sku: string;
}

export interface CloudSnapshot {
  provider: CloudProvider;
  context: string;
  scope: string | null;
  commands: CloudCommandResult[];
  resources: CloudResource[];
  /** One line per resource, sanitized — what the model reads. */
  text: string;
}

/** Subscriptions (Azure), profiles (AWS), projects (Google Cloud). Runs the CLI: only on the
 *  person's click. */
export const architectureCloudContexts = (provider: CloudProvider) =>
  invoke<CloudContexts>("architecture_cloud_contexts", { provider });

/** Resource groups (Azure, runs the CLI), regions (AWS, no CLI call), none (Google Cloud). */
export const architectureCloudScopes = (provider: CloudProvider, context: string) =>
  invoke<CloudScope[]>("architecture_cloud_scopes", { provider, context });

/** The exact command lines `architectureCloudRead` runs — what the authorization card shows. */
export const architectureCloudPlan = (provider: CloudProvider, context: string, scope: string | null) =>
  invoke<string[]>("architecture_cloud_plan", { provider, context, scope });

/** The read-only listing itself, sanitized in Rust. Only from the authorization's own button. */
export const architectureCloudRead = (provider: CloudProvider, context: string, scope: string | null) =>
  invoke<CloudSnapshot>("architecture_cloud_read", { provider, context, scope });
