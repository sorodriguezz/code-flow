import {
  apiCancelHttp,
  apiListCookies,
  apiListEnvironments,
  apiLoadSettings,
  apiLoadTree,
  apiSendHttpTracked,
} from "../tauri/apiCommands";
import { getSetting } from "../tauri/commands";
import { resolveRequest, toHttpSendRequest } from "./send";
import { chainScripts, folderChain, runScriptChain, type ChainOwner } from "./scriptChain";
import { gateScripts } from "./scriptTrust";
import type { SandboxScopes } from "./sandbox";
import type { VariableContext } from "./variables";
import {
  activeEnvironmentKey,
  ancestorAuthIn,
  migrateSettings,
  parseJson,
  parseSpec,
  parseVariables,
  type StoredSettings,
} from "../../state/apiStore";
import { defaultApiSettings, type ApiRequestRow, type ApiResponse } from "../../types/api";

/**
 * A saved request of the API client, sent from a flow (`app.apiRequest` → `flows::bridge`).
 *
 * **The runner's path, for one request.** Resolved by `resolveRequest` — the only way a request is
 * ever built — with the auth it inherits from its folders and collection, the workspace's active
 * environment (or the one the node names) and the collection's and globals' variables; the node's
 * own variables go in the run's local scope, so `{{id}}` in the saved URL takes `{{ $json.id }}`.
 * Then its pre-request scripts, the send, its tests — exactly as `RunnerModal` runs a row.
 *
 * **Read from the workspace, not from the API tab.** A flow belongs to a workspace that may not be
 * the one the API tab has open, so the tree, the environments and the cookies are read for that
 * workspace here, and the API client's store is never touched.
 *
 * **Nobody is there to ask.** A run is often unattended, so a script this machine has not trusted
 * is skipped (and counted), never run and never asked about. An expired OAuth 2 token is not
 * refreshed here either: the request goes as the API client last left it.
 */

export interface SavedRequestAsk {
  workspaceId: string;
  requestId: string;
  /** `""` is the environment active in the API client for that workspace; `"none"` is none. */
  environmentId: string;
  variables: Record<string, string>;
}

export interface SavedRequestAnswer {
  name: string;
  method: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Parsed when the answer is JSON, the text otherwise. */
  body: unknown;
  bodyBase64: string | null;
  durationMs: number;
  sizeBytes: number;
  tests: { name: string; passed: boolean; error: string | null }[];
  testsPassed: number;
  testsFailed: number;
  skippedScripts: number;
  interrupted: string | null;
}

function bodyOf(text: string, headers: [string, string][]): unknown {
  const type = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  const looksJson = /json/i.test(type) || /^\s*[[{]/.test(text);
  if (!looksJson || text.trim() === "") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface Loaded {
  tree: Awaited<ReturnType<typeof apiLoadTree>>;
  environments: Awaited<ReturnType<typeof apiListEnvironments>>;
  settings: ReturnType<typeof defaultApiSettings>;
  cookies: Awaited<ReturnType<typeof apiListCookies>>;
  activeEnvironment: string | null;
}

async function load(workspaceId: string): Promise<Loaded> {
  const [tree, environments, rawSettings, cookies, activeEnvironment] = await Promise.all([
    apiLoadTree(workspaceId),
    apiListEnvironments(workspaceId),
    apiLoadSettings().catch(() => null),
    apiListCookies(workspaceId).catch(() => []),
    getSetting(activeEnvironmentKey(workspaceId)).catch(() => null),
  ]);
  const stored = parseJson<StoredSettings>(rawSettings, {});
  const settings = migrateSettings(stored) ?? { ...defaultApiSettings(), ...stored };
  return { tree, environments, settings, cookies, activeEnvironment };
}

/** The environment a run uses: `""` the one active in the API client, `"none"` none. */
function environmentOf(loaded: Loaded, asked: string) {
  const environmentId = asked === "" ? loaded.activeEnvironment : asked === "none" ? null : asked;
  const environment = loaded.environments.find((candidate) => candidate.id === environmentId && !candidate.is_global);
  if (asked !== "" && asked !== "none" && !environment) {
    throw new Error("That environment is no longer in the API client");
  }
  return environment;
}

/**
 * One saved request, start to end. `carried` is what an earlier request of the same collection run
 * left in the scopes — its scripts' `pm.environment.set(…)` — so a log-in request's token reaches
 * the next one, as in the runner.
 */
async function runRow(
  loaded: Loaded,
  row: ApiRequestRow,
  environmentId: string,
  variables: Record<string, string>,
  carried: SandboxScopes | null,
  signal?: AbortSignal,
): Promise<{ answer: SavedRequestAnswer; scopes: SandboxScopes }> {
  const { tree, environments, settings, cookies } = loaded;
  const spec = parseSpec(row);
  if (spec.protocol !== "http") {
    throw new Error(`Only HTTP requests run from a flow — “${row.name}” is ${spec.protocol}`);
  }
  const environment = environmentOf(loaded, environmentId);
  const globals = environments.find((candidate) => candidate.is_global);
  const collection = tree.collections.find((candidate) => candidate.id === row.collection_id) ?? null;
  const ctx: VariableContext = {
    local: { ...(carried?.local ?? {}), ...variables },
    data: carried?.data ?? {},
    environment: carried?.environment ?? parseVariables(environment?.variables),
    collection: carried?.collection ?? parseVariables(collection?.variables),
    global: carried?.global ?? parseVariables(globals?.variables),
    collectionId: row.collection_id,
  };
  const authChain = [spec.auth, ...ancestorAuthIn(tree.folders, tree.collections, row.collection_id, row.folder_id)];

  // The runner's planning: collection → folders → request, each phase gated.
  const owner: ChainOwner = {
    collection,
    folders: folderChain(tree.folders, row.folder_id),
    request: { name: row.name, preScript: spec.preScript, postScript: spec.postScript },
  };
  const pre = chainScripts(owner, "pre");
  const post = chainScripts(owner, "post");
  const gate = await gateScripts([...pre, ...post], async () => "skip");
  const allows = gate?.allows ?? (() => false);

  const resolved = await resolveRequest(spec, ctx, authChain, settings, cookies);
  let scopes: SandboxScopes = {
    local: ctx.local,
    data: ctx.data,
    environment: ctx.environment,
    collection: ctx.collection,
    global: ctx.global,
  };
  const before = await runScriptChain(pre.filter(allows), { request: resolved, scopes }, { stopOnError: true });
  scopes = before.scopes;
  if (before.errors.length > 0) throw new Error(`A pre-request script failed: ${before.errors[0].error}`);
  if (signal?.aborted) throw new Error("Stopped");

  const trackId = `flow-${crypto.randomUUID()}`;
  const stop = () => void apiCancelHttp(trackId).catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  let http;
  try {
    http = await apiSendHttpTracked(trackId, toHttpSendRequest(resolved));
  } finally {
    signal?.removeEventListener("abort", stop);
  }

  const tests = [...before.tests];
  const runnablePost = post.filter(allows);
  if (runnablePost.length > 0) {
    const response: ApiResponse = { ...http, tests: [], consoleLines: [], visualizer: null, error: null };
    const after = await runScriptChain(runnablePost, { request: resolved, response, scopes });
    scopes = after.scopes;
    tests.push(...after.tests);
    if (after.errors.length > 0) throw new Error(`A test script failed: ${after.errors[0].error}`);
  }

  const passed = tests.filter((test) => test.passed).length;
  const answer: SavedRequestAnswer = {
    name: row.name,
    method: resolved.method,
    url: resolved.url,
    status: http.status,
    statusText: http.status_text,
    headers: Object.fromEntries(http.headers.map(([name, value]) => [name.toLowerCase(), value])),
    body: http.body_base64 ? null : bodyOf(http.body_text, http.headers),
    bodyBase64: http.body_base64,
    durationMs: http.duration_ms,
    sizeBytes: http.size_bytes,
    tests: tests.map((test) => ({ name: test.name, passed: test.passed, error: test.error })),
    testsPassed: passed,
    testsFailed: tests.length - passed,
    skippedScripts: gate?.skipped.length ?? 0,
    interrupted: http.interrupted ?? null,
  };
  return { answer, scopes };
}

export async function runSavedRequest(ask: SavedRequestAsk, signal?: AbortSignal): Promise<SavedRequestAnswer> {
  const loaded = await load(ask.workspaceId);
  const row = loaded.tree.requests.find((request) => request.id === ask.requestId);
  if (!row) throw new Error("That request is no longer in the API client");
  return (await runRow(loaded, row, ask.environmentId, ask.variables, null, signal)).answer;
}

// ------------------------------------------------------------------------------- a whole collection

export interface SavedCollectionAsk {
  workspaceId: string;
  collectionId: string;
  environmentId: string;
  variables: Record<string, string>;
  stopOnFailure: boolean;
  delayMs: number;
}

export type CollectionRowAnswer = (SavedRequestAnswer & { ok: boolean; error?: undefined }) | { name: string; ok: false; error: string };

export interface SavedCollectionAnswer {
  collection: string;
  /** One per request sent, in the order they went. */
  results: CollectionRowAnswer[];
  /** Every HTTP request of the collection; `passed + failed + skipped`. */
  total: number;
  passed: number;
  /** Sent, and did not pass. */
  failed: number;
  /** Never sent: «Parar al fallar» ended the run before them. */
  skipped: number;
  durationMs: number;
}

/**
 * A collection's HTTP requests in the order the runner (`RunnerModal`) runs them: the requests
 * directly under a node before its subfolders' contents, each level by `sort_order`.
 */
export function requestsInRunOrder(tree: Loaded["tree"], collectionId: string): ApiRequestRow[] {
  const out: ApiRequestRow[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null) => {
    out.push(
      ...tree.requests
        .filter((r) => r.collection_id === collectionId && r.folder_id === parentId && r.protocol === "http")
        .sort((a, b) => a.sort_order - b.sort_order),
    );
    for (const folder of tree.folders.filter((f) => f.collection_id === collectionId && f.parent_id === parentId).sort((a, b) => a.sort_order - b.sort_order)) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      visit(folder.id);
    }
  };
  visit(null);
  return out;
}

/** A collection run from a flow (`app.apiCollection`): every HTTP request in the runner's order,
 *  the scopes carried from one to the next. A request "passes" with a status below 400 and no
 *  failed test; after a stop on failure, the ones never sent are counted apart (`skipped`) — not
 *  as passed, and not as failed. */
export async function runSavedCollection(ask: SavedCollectionAsk, signal?: AbortSignal): Promise<SavedCollectionAnswer> {
  const started = Date.now();
  const loaded = await load(ask.workspaceId);
  const collection = loaded.tree.collections.find((candidate) => candidate.id === ask.collectionId);
  if (!collection) throw new Error("That collection is no longer in the API client");
  environmentOf(loaded, ask.environmentId);
  const rows = requestsInRunOrder(loaded.tree, ask.collectionId);
  if (rows.length === 0) throw new Error(`“${collection.name}” has no HTTP request to run`);
  const results: CollectionRowAnswer[] = [];
  let scopes: SandboxScopes | null = null;
  for (const [index, row] of rows.entries()) {
    if (signal?.aborted) throw new Error("Stopped");
    let ok = false;
    try {
      const done = await runRow(loaded, row, ask.environmentId, ask.variables, scopes, signal);
      scopes = done.scopes;
      ok = done.answer.status > 0 && done.answer.status < 400 && done.answer.testsFailed === 0 && !done.answer.interrupted;
      results.push({ ...done.answer, ok });
    } catch (error) {
      if (signal?.aborted) throw new Error("Stopped");
      results.push({ name: row.name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    if (!ok && ask.stopOnFailure) break;
    if (ask.delayMs > 0 && index < rows.length - 1) await new Promise((resolve) => setTimeout(resolve, ask.delayMs));
  }
  const passed = results.filter((result) => result.ok).length;
  return {
    collection: collection.name,
    results,
    total: rows.length,
    passed,
    failed: results.length - passed,
    skipped: rows.length - results.length,
    durationMs: Date.now() - started,
  };
}
