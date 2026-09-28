/**
 * Collection and folder scripts, run around every request beneath them — in Postman's order.
 *
 * Before the send: the collection's pre-request script, then each folder's from the outermost in,
 * then the request's own. After the response: the same order for the post-response (test) scripts.
 * Each script starts from the scopes the previous one left behind, so a token the collection's
 * script fetches is already in `pm.environment` when the request's own script reads it — which is
 * the whole reason a collection-level script exists.
 *
 * `pm.request` is shared the same way on the way out: every pre-request script mutates the one
 * resolved request that is about to be sent (see `runPreRequestScript`), so a header the collection
 * adds is on the wire and visible to the folder and request scripts after it.
 */

import { runPostResponseScript, runPreRequestScript, type SandboxScopes } from "./sandbox";
import type { ScriptPhase, ScriptRef } from "./scriptTrust";
import type {
  ApiCollection,
  ApiFolder,
  ApiResponse,
  ConsoleLine,
  ResolvedRequest,
  TestResult,
} from "../../types/api";

/** Folders from the outermost down to `folderId`. Stops on a cycle rather than hanging. */
export function folderChain(folders: ApiFolder[], folderId: string | null): ApiFolder[] {
  const chain: ApiFolder[] = [];
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const folder = folders.find((entry) => entry.id === current);
    if (!folder) break;
    chain.unshift(folder);
    current = folder.parent_id;
  }
  return chain;
}

/** What a request inherits scripts from. The request's own scripts come from its draft, the rest
 * from the saved rows — an unsaved edit to a collection's script is not what Postman runs either. */
export interface ChainOwner {
  collection: ApiCollection | null;
  /** Outermost first — `folderChain`'s order. */
  folders: ApiFolder[];
  request: { name: string; preScript: string; postScript: string };
}

/** Every non-blank script of one phase, in the order it runs. */
export function chainScripts(owner: ChainOwner, phase: ScriptPhase): ScriptRef[] {
  const pick = (pre: string, post: string) => (phase === "pre" ? pre : post);
  const collectionId = owner.collection?.id ?? null;
  const refs: ScriptRef[] = [];
  if (owner.collection) {
    refs.push({
      level: "collection",
      phase,
      owner: owner.collection.name,
      collectionId,
      code: pick(owner.collection.pre_script, owner.collection.post_script),
    });
  }
  for (const folder of owner.folders) {
    refs.push({
      level: "folder",
      phase,
      owner: folder.name,
      collectionId,
      code: pick(folder.pre_script, folder.post_script),
    });
  }
  refs.push({
    level: "request",
    phase,
    owner: owner.request.name,
    collectionId,
    code: pick(owner.request.preScript, owner.request.postScript),
  });
  return refs.filter((ref) => ref.code.trim() !== "");
}

export interface ChainOutcome {
  scopes: SandboxScopes;
  tests: TestResult[];
  console: ConsoleLine[];
  /** One entry per script that threw, in run order. */
  errors: { ref: ScriptRef; error: string }[];
  /** The last `setNextRequest` any script in the chain made. */
  nextRequest: string | null;
  /** The last visualizer any script set. */
  visualizer: { template: string; data: unknown } | null;
}

/**
 * Runs `refs` one after another, each on the scopes the previous one returned.
 *
 * A script that throws is recorded and the chain goes on — one broken folder script must not be
 * the reason the request's own tests never report — unless `stopOnError` is set, which the runner
 * uses for the pre-request phase: a request whose setup failed is not sent there.
 */
export async function runScriptChain(
  refs: ScriptRef[],
  ctx: { request: ResolvedRequest; response?: ApiResponse; scopes: SandboxScopes },
  options: { stopOnError?: boolean } = {},
): Promise<ChainOutcome> {
  const outcome: ChainOutcome = {
    scopes: ctx.scopes,
    tests: [],
    console: [],
    errors: [],
    nextRequest: null,
    visualizer: null,
  };
  for (const ref of refs) {
    const result =
      ref.phase === "pre" || ctx.response === undefined
        ? await runPreRequestScript(ref.code, { request: ctx.request, scopes: outcome.scopes })
        : await runPostResponseScript(ref.code, {
            request: ctx.request,
            response: ctx.response,
            scopes: outcome.scopes,
          });
    outcome.scopes = result.scopes;
    outcome.tests.push(...result.tests);
    outcome.console.push(...result.console);
    if (result.nextRequest !== null) outcome.nextRequest = result.nextRequest;
    if (result.visualizer !== null) outcome.visualizer = result.visualizer;
    if (result.error !== null) {
      outcome.errors.push({ ref, error: result.error });
      if (options.stopOnError) break;
    }
  }
  return outcome;
}
