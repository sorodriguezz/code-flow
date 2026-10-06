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
import { defaultApiSettings, type ApiResponse } from "../../types/api";

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

export async function runSavedRequest(ask: SavedRequestAsk, signal?: AbortSignal): Promise<SavedRequestAnswer> {
  const [tree, environments, rawSettings, cookies, activeEnvironment] = await Promise.all([
    apiLoadTree(ask.workspaceId),
    apiListEnvironments(ask.workspaceId),
    apiLoadSettings().catch(() => null),
    apiListCookies(ask.workspaceId).catch(() => []),
    getSetting(activeEnvironmentKey(ask.workspaceId)).catch(() => null),
  ]);
  const row = tree.requests.find((request) => request.id === ask.requestId);
  if (!row) throw new Error("That request is no longer in the API client");
  const spec = parseSpec(row);
  if (spec.protocol !== "http") {
    throw new Error(`Only HTTP requests run from a flow — “${row.name}” is ${spec.protocol}`);
  }

  const stored = parseJson<StoredSettings>(rawSettings, {});
  const settings = migrateSettings(stored) ?? { ...defaultApiSettings(), ...stored };
  const environmentId = ask.environmentId === "" ? activeEnvironment : ask.environmentId === "none" ? null : ask.environmentId;
  const environment = environments.find((candidate) => candidate.id === environmentId && !candidate.is_global);
  if (ask.environmentId !== "" && ask.environmentId !== "none" && !environment) {
    throw new Error("That environment is no longer in the API client");
  }
  const globals = environments.find((candidate) => candidate.is_global);
  const collection = tree.collections.find((candidate) => candidate.id === row.collection_id) ?? null;
  const ctx: VariableContext = {
    local: { ...ask.variables },
    data: {},
    environment: parseVariables(environment?.variables),
    collection: parseVariables(collection?.variables),
    global: parseVariables(globals?.variables),
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
    tests.push(...after.tests);
    if (after.errors.length > 0) throw new Error(`A test script failed: ${after.errors[0].error}`);
  }

  const passed = tests.filter((test) => test.passed).length;
  return {
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
}
