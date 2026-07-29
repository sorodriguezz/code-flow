import { useApiStore } from "../../state/apiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import {
  supabasePull,
  supabasePush,
  supabaseShareToken,
  type SyncResult,
} from "../tauri/apiCommands";

/**
 * Keeping a shared workspace in step with everyone else's copy.
 *
 * Push then pull, both against the user's own Supabase project. There is no realtime channel: this
 * syncs on demand and on a timer. For collections and requests — which is what a team actually
 * edits together — a minute of lag is invisible, and the WebSocket it would take to close that gap
 * is the one part of Supabase that a hand-rolled REST client has no cheap answer for.
 *
 * Conflicts resolve last-write-wins per record, on the server-side `updated_at`. Two people editing
 * *different* requests never conflict; two people editing the *same* request in the same minute
 * means the later save wins and the earlier one is lost. That is the honest limit of this design.
 */

/** Long enough not to hammer a free-tier project, short enough that a teammate's change lands. */
const INTERVAL_MS = 60_000;

/** After a local edit, wait for the typing to stop before pushing it. */
const PUSH_DEBOUNCE_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let running = false;

/** The invitation a host hands out: everything a guest needs to reach the workspace, in one blob. */
export interface Invite {
  url: string;
  key: string;
  token: string;
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

/** The workspace being synced, or `null` when this one isn't shared. */
async function sharedWorkspace(): Promise<{ id: string; name: string } | null> {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore.getState();
  if (activeWorkspaceId === null) return null;
  const token = await supabaseShareToken(activeWorkspaceId);
  if (!token) return null;
  return {
    id: activeWorkspaceId,
    name: workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? "",
  };
}

/**
 * One full round: send what changed here, then take what changed elsewhere.
 *
 * Push first on purpose. The reverse order would apply a teammate's older copy of a record over an
 * edit made here that hasn't been sent yet, and the local edit would be gone before it was ever
 * shared.
 */
export async function syncNow(): Promise<SyncResult | null> {
  const workspace = await sharedWorkspace();
  if (workspace === null) return null;
  const { settings } = useApiStore.getState();
  if (settings.supabaseUrl.trim() === "") return null;
  if (running) return null;

  running = true;
  try {
    await supabasePush(settings.supabaseUrl, workspace.id);

    const since = settings.syncCursors[workspace.id] ?? "";
    const result = await supabasePull(settings.supabaseUrl, workspace.id, workspace.name, since);

    if (result.cursor !== "") {
      await useApiStore.getState().updateSettings({
        syncCursors: { ...useApiStore.getState().settings.syncCursors, [workspace.id]: result.cursor },
      });
    }

    // A pull that changed nothing still costs a full tree reload if we reload unconditionally, and
    // that reload is what makes the sidebar flicker on a quiet timer tick.
    const changed =
      result.deleted > 0 ||
      result.applied.collections > 0 ||
      result.applied.requests > 0 ||
      result.applied.environments > 0;
    if (changed) {
      await useApiStore.getState().reloadTree();
      await useApiStore.getState().reloadEnvironments();
    }

    return result;
  } finally {
    running = false;
  }
}

/** Forgets a workspace's cursor, so the next sync pulls its whole history again. */
export async function resetCursor(workspaceId: string) {
  const cursors = { ...useApiStore.getState().settings.syncCursors };
  delete cursors[workspaceId];
  await useApiStore.getState().updateSettings({ syncCursors: cursors });
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!useApiStore.getState().settings.syncAuto) return;
    // Silent: this runs unattended, and a project that is briefly unreachable would otherwise
    // produce a toast every time someone types.
    void syncNow().catch(() => {});
  }, PUSH_DEBOUNCE_MS);
}

/** Idempotent — called from `ensureApiStoreLoaded`, which several entry points race into. */
export function startSyncWatcher() {
  if (started) return;
  started = true;

  timer = setInterval(() => {
    if (!useApiStore.getState().settings.syncAuto) return;
    void syncNow().catch(() => {});
  }, INTERVAL_MS);

  useApiStore.subscribe((state, prev) => {
    if (
      state.collections === prev.collections &&
      state.folders === prev.folders &&
      state.requests === prev.requests &&
      state.environments === prev.environments
    ) {
      return;
    }
    if (!useApiStore.getState().settings.syncAuto) return;
    schedulePush();
  });
}

/** Only for tests and teardown; the watcher otherwise lives as long as the window. */
export function stopSyncWatcher() {
  if (timer) clearInterval(timer);
  if (pushTimer) clearTimeout(pushTimer);
  timer = null;
  pushTimer = null;
  started = false;
}
