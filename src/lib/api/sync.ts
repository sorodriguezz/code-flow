import { useApiStore } from "../../state/apiStore";
import { useCollabStore } from "../../state/collabStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { supabaseSync, supabaseWatermark, type SyncResult } from "../tauri/apiCommands";
import type { ApiCollection, ApiFolder, ApiRequestRow } from "../../types/api";

/**
 * Keeping shared collections in step with everyone else's copy.
 *
 * ## Why this is a poll and not a socket
 *
 * The unit of change detection is `supabaseWatermark`: one indexed row, no payload, the newest
 * server clock this share has seen. It is small enough to ask every three seconds without
 * embarrassing a free-tier project, and a full sync only follows when it has actually moved. That
 * puts a teammate's change on screen in about the time it takes to notice it arrived, with no
 * WebSocket, no Phoenix handshake, no reconnection state machine, and no dependency on Realtime
 * being enabled in whichever project the user happened to create.
 *
 * The poll is also honest about attention: while the window is hidden it drops to once every thirty
 * seconds, and a share whose project is failing backs off geometrically instead of hammering it.
 *
 * ## Push and pull are one call
 *
 * A round is `supabase_sync` in the backend — push, then pull, then the base bookkeeping between
 * them, under one command. Splitting it would leave a window in which the push has landed but the
 * base has not moved, and every record we just sent would come back looking like someone else's
 * edit on top of ours. See the module comment in `db/api_sync.rs`.
 */

/** How often to ask "has anything changed?" while the window is in front of someone. */
const PROBE_MS = 3_000;

/** And while it isn't. A background window is worth keeping current, not worth keeping instant. */
const HIDDEN_PROBE_MS = 30_000;

/** After a local edit, wait for the typing to stop before sending it. */
const PUSH_DEBOUNCE_MS = 1_200;

/** A failing share doubles its wait up to this, so a project that is down is asked about rarely. */
const BACKOFF_MAX_MS = 120_000;

/** How many probes have to fail in a row before the panel is told. One is a blip, three is a fact. */
const PROBE_FAILURES_BEFORE_REPORTING = 3;

let probeTimer: ReturnType<typeof setInterval> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let started = false;

/** Rounds in flight, so a slow one never overlaps itself. */
const running = new Set<string>();

/** Consecutive failures per share, for the backoff. */
const failures = new Map<string, number>();
const nextAttempt = new Map<string, number>();

/** Collections with a local change waiting to be sent. */
const dirty = new Set<string>();

/**
 * Set while a pull is being written into the store. The tree reload that follows an apply looks
 * exactly like a local edit to the subscriber below, and treating it as one would schedule a push
 * for a change that came from the server — a loop that never settles and never stops talking.
 */
let applying = false;

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** The invitation a host hands out: everything a guest needs to reach the collection, in one blob. */
export interface Invite {
  url: string;
  key: string;
  token: string;
  /** The collection's name, so the guest can be told what they are about to accept. */
  name: string;
}

/**
 * Encoded rather than shown as raw JSON so it survives being pasted through a chat client that
 * would otherwise linkify or reflow it. This is obfuscation, not protection — the token inside is
 * a real credential, and the code should be shared the way a password would be.
 */
export function encodeInvite(invite: Invite): string {
  const json = JSON.stringify(invite);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `codeflow:${btoa(binary)}`;
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim().replace(/^codeflow:/, "");
  let invite: Invite;
  try {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    invite = JSON.parse(new TextDecoder().decode(bytes)) as Invite;
  } catch {
    throw new Error("that is not a CodeFlow invitation code");
  }
  if (!invite?.url || !invite.key || !invite.token) {
    throw new Error("that invitation code is incomplete");
  }
  return invite;
}

// ---------------------------------------------------------------------------
// One round
// ---------------------------------------------------------------------------

/**
 * Push what changed in one collection, then apply what changed elsewhere.
 *
 * Returns `null` when there was nothing to do — no project configured, or a round already in
 * flight — which is what the manual button distinguishes from "synced, nothing had changed".
 */
export async function syncCollection(collectionId: string): Promise<SyncResult | null> {
  const url = useApiStore.getState().settings.supabaseUrl.trim();
  if (url === "") return null;
  if (running.has(collectionId)) return null;

  running.add(collectionId);
  useCollabStore.getState().setBusy(collectionId, true);
  try {
    const result = await supabaseSync(url, collectionId);
    dirty.delete(collectionId);
    failures.delete(collectionId);
    nextAttempt.delete(collectionId);

    // A round that changed nothing still costs a full tree reload if we reload unconditionally,
    // and that reload is what makes the sidebar flicker on a quiet heartbeat.
    const changed =
      result.deleted > 0 ||
      result.conflicts > 0 ||
      result.applied.collections > 0 ||
      result.applied.folders > 0 ||
      result.applied.requests > 0;
    if (changed) {
      applying = true;
      try {
        await useApiStore.getState().reloadTree();
        // The tree is not the only thing showing these records: an open tab holds its own copy, and
        // one that is never reconciled shows the version it was opened with until it is closed —
        // then writes it back over whatever arrived, with no conflict raised anywhere, because the
        // divergence lives in a draft the sync layer cannot see.
        useApiStore.getState().adoptRemoteChanges();
      } finally {
        applying = false;
      }
    }
    // Cheap, local, and the only way the panel's "last synced" and the tabs' conflict marks stay
    // truthful without every component polling the database itself.
    await useCollabStore.getState().refresh();
    return result;
  } catch (e) {
    const count = (failures.get(collectionId) ?? 0) + 1;
    failures.set(collectionId, count);
    nextAttempt.set(collectionId, Date.now() + Math.min(PROBE_MS * 2 ** count, BACKOFF_MAX_MS));
    throw e;
  } finally {
    running.delete(collectionId);
    useCollabStore.getState().setBusy(collectionId, false);
  }
}

/** Every shared collection in the workspace on screen. The others sync when it is their turn. */
function activeShares(): string[] {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return [];
  return useCollabStore
    .getState()
    .shares.filter((share) => share.workspace_id === workspaceId)
    .map((share) => share.collection_id);
}

/** Forces a round on everything shared in this workspace, ignoring the backoff. */
export async function syncNow(): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const id of activeShares()) {
    nextAttempt.delete(id);
    const result = await syncCollection(id);
    if (result) results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// The heartbeat
// ---------------------------------------------------------------------------

async function probe(collectionId: string) {
  const url = useApiStore.getState().settings.supabaseUrl.trim();
  if (url === "" || running.has(collectionId)) return;

  const due = nextAttempt.get(collectionId) ?? 0;
  if (Date.now() < due) return;

  const before = failures.get(collectionId) ?? 0;
  try {
    const mark = await supabaseWatermark(url, collectionId);
    failures.delete(collectionId);
    // A share that was failing and now isn't has an error message on screen that is no longer
    // true; the backend cleared it, so the panel has to be told to re-read it.
    if (before > 0) void useCollabStore.getState().refresh();

    // Compared against the share row rather than a cursor mirrored in this module. The backend owns
    // that column, `syncCollection` re-reads the rows before it returns, and a local mirror that
    // never learned about a share created mid-session would compare against "" — which is less than
    // every timestamp, so the probe would fire a pointless full round every three seconds forever.
    const cursor = useCollabStore.getState().shareFor(collectionId)?.cursor ?? "";
    // String comparison is the right one: these are RFC 3339 timestamps with a fixed offset, which
    // sort lexicographically, and the backend compares them the same way.
    if (mark !== "" && mark > cursor) {
      await syncCollection(collectionId);
    }
  } catch {
    const count = before + 1;
    failures.set(collectionId, count);
    nextAttempt.set(collectionId, Date.now() + Math.min(PROBE_MS * 2 ** count, BACKOFF_MAX_MS));
    // Surfaced once, on the third consecutive failure rather than the first: a single dropped
    // request is noise, but a rotated invitation code looks exactly like this and would otherwise
    // leave the panel claiming "synced 5 minutes ago" for the rest of the session.
    if (count === PROBE_FAILURES_BEFORE_REPORTING) void useCollabStore.getState().refresh();
  }
}

let sinceLastProbe = 0;

function tick() {
  const { syncAuto, supabaseUrl } = useApiStore.getState().settings;
  if (!syncAuto || supabaseUrl.trim() === "") return;

  // One interval drives both cadences: a second timer that had to be torn down and rebuilt on every
  // visibility change is two things to keep in step instead of one number to compare against.
  sinceLastProbe += PROBE_MS;
  const wanted = document.visibilityState === "visible" ? PROBE_MS : HIDDEN_PROBE_MS;
  if (sinceLastProbe < wanted) return;
  sinceLastProbe = 0;

  for (const id of activeShares()) void probe(id);
}

/** Which collections a store change touched, so a push doesn't wake every share in the workspace. */
function changedCollections(
  next: { collections: ApiCollection[]; folders: ApiFolder[]; requests: ApiRequestRow[] },
  prev: { collections: ApiCollection[]; folders: ApiFolder[]; requests: ApiRequestRow[] },
): Set<string> {
  const touched = new Set<string>();

  const compare = <T extends { id: string }>(
    after: T[],
    before: T[],
    collectionOf: (row: T) => string,
  ) => {
    const previous = new Map(before.map((row) => [row.id, row]));
    for (const row of after) {
      // Reference equality is exact here: every mutation in `apiStore` replaces the row object, and
      // nothing ever edits one in place.
      if (previous.get(row.id) !== row) touched.add(collectionOf(row));
      previous.delete(row.id);
    }
    for (const row of previous.values()) touched.add(collectionOf(row));
  };

  compare(next.collections, prev.collections, (c) => c.id);
  compare(next.folders, prev.folders, (f) => f.collection_id);
  compare(next.requests, prev.requests, (r) => r.collection_id);
  return touched;
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!useApiStore.getState().settings.syncAuto) return;
    for (const id of [...dirty]) {
      // Silent: this runs unattended, and a project that is briefly unreachable would otherwise
      // produce a toast every time someone types.
      void syncCollection(id).catch(() => {});
    }
  }, PUSH_DEBOUNCE_MS);
}

/** Idempotent — called from `ensureApiStoreLoaded`, which several entry points race into. */
export function startSyncWatcher() {
  if (started) return;
  started = true;

  void useCollabStore.getState().refresh();

  probeTimer = setInterval(tick, PROBE_MS);

  unsubscribe = useApiStore.subscribe((state, prev) => {
    if (
      state.collections === prev.collections &&
      state.folders === prev.folders &&
      state.requests === prev.requests
    ) {
      return;
    }
    if (applying) return;
    if (!useApiStore.getState().settings.syncAuto) return;

    const shared = new Set(activeShares());
    if (shared.size === 0) return;
    let queued = false;
    for (const id of changedCollections(state, prev)) {
      if (!shared.has(id)) continue;
      dirty.add(id);
      queued = true;
    }
    if (queued) schedulePush();
  });
}

/** Only for tests and teardown; the watcher otherwise lives as long as the window. */
export function stopSyncWatcher() {
  if (probeTimer) clearInterval(probeTimer);
  if (pushTimer) clearTimeout(pushTimer);
  unsubscribe?.();
  probeTimer = null;
  pushTimer = null;
  unsubscribe = null;
  started = false;
  running.clear();
  failures.clear();
  nextAttempt.clear();
  dirty.clear();
}
