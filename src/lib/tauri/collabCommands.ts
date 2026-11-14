import { invoke } from "./invoke";

/**
 * Shared workspace chats (`src-tauri/src/collab`, `commands/collab_cmd.rs`). See
 * `.claude/plans/multiplayer-chat.md`.
 */

export type CollabFileState =
  | { state: "base" }
  | { state: "deleted" }
  | { state: "present"; sha: string; size: number; binary: boolean };

export interface CollabSession {
  id: string;
  projectUrl: string;
  name: string;
  role: "owner" | "editor";
  nick: string;
  personId: string;
  workspaceId: string;
  chatId: string;
  status: "active" | "left" | "ended";
  lastSeq: number;
  createdAt: string;
}

export interface CollabRepo {
  sessionId: string;
  repoKey: string;
  name: string;
  projectId: string;
  checkoutPath: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  epoch: number;
  /** The workspace project showing the worktree («api · sesión»). */
  sessionProjectId: string;
}

export interface CollabSessionView {
  session: CollabSession;
  repos: CollabRepo[];
  isOwner: boolean;
  /** `chat`, or `run` for a shared «Equipo» run (`collabRunCommands.ts`). */
  kind: "chat" | "run";
  /** For a run, on its owner's machine: the local run id. */
  runId: string;
}

export type CollabSkipReason = "dependencies" | "build_output" | "secret" | "symlink" | "too_large" | "unportable";

export interface CollabShareCandidate {
  projectId: string;
  name: string;
  path: string;
  repoKey: string | null;
  base: string | null;
  branch: string | null;
  uncommitted: number;
  skipped: { path: string; reason: CollabSkipReason }[];
  problem: string | null;
}

export interface CollabPerson {
  id: string;
  nick: string;
  role: "owner" | "editor";
  lastSeen: string;
}

export interface CollabLock {
  repoKey: string;
  personId: string;
  turnId: string;
  expiresAt: string;
}

export interface CollabConflict {
  repoKey: string;
  path: string;
  local: CollabFileState;
  remote: CollabFileState;
  remoteBy: string;
  detectedAt: string;
}

export interface CollabMessage {
  seq: number;
  id: string;
  personId: string | null;
  kind: "user" | "assistant" | "turn_failed" | string;
  body: {
    nick?: string;
    text?: string;
    engine?: string;
    turn_id?: string;
    history?: boolean;
    repos?: string[];
    changes?: { repo: string | null; paths: string[] }[];
  };
  createdAt: string;
}

export interface CollabTick {
  sessionId: string;
  pushed: string[];
  pulled: string[];
  conflicts: CollabConflict[];
  messages: CollabMessage[];
  people: CollabPerson[];
  locks: CollabLock[];
  rebased: string[];
  sessionFiles: number;
  ended: boolean;
  errors: string[];
  /** The live channel's secret (`lib/collabLive`). */
  channel: string | null;
  me: string | null;
  /** The session's state of files open live here, which the round did not write. */
  liveRemote: CollabLiveRemote[];
}

export interface CollabLiveRemote {
  repoKey: string;
  path: string;
  text: string | null;
  deleted: boolean;
  updatedBy: string | null;
}

export interface CollabJoinPreview {
  name: string;
  host: string;
  projectUrl: string;
  repos: { key: string; name: string; projectId: string | null; path: string | null }[];
  kind: "chat" | "run";
}

export interface CollabCommitted {
  repo: string;
  commit: string | null;
  files: number;
}

export interface CollabLeft {
  repo: string;
  branch: string;
  commit: string | null;
  kept: boolean;
  discarded: boolean;
}

/** Prefix of a turn refused because another person's turn holds a repository; the nick follows. */
export const COLLAB_BUSY_MARKER = "collab-busy:";

export const collabTakeJoinLink = () => invoke<string | null>("collab_take_join_link");
export const collabSharePreview = (workspaceId: string) => invoke<CollabShareCandidate[]>("collab_share_preview", { workspaceId });
export const collabShare = (args: {
  workspaceId: string;
  chatId: string;
  projectUrl: string;
  nick: string;
  name: string;
  projectIds: string[];
  includeHistory: boolean;
}) => invoke<{ view: CollabSessionView; link: string }>("collab_share", args);
export const collabInvite = (sessionId: string) => invoke<string>("collab_invite", { sessionId });
export const collabJoinPreview = (workspaceId: string, linkText: string) =>
  invoke<CollabJoinPreview>("collab_join_preview", { workspaceId, linkText });
export const collabJoin = (workspaceId: string, linkText: string, nick: string) =>
  invoke<CollabSessionView>("collab_join", { workspaceId, linkText, nick });
export const collabSessionForChat = (chatId: string) => invoke<CollabSessionView | null>("collab_session_for_chat", { chatId });
export const collabSessions = (workspaceId: string) => invoke<CollabSessionView[]>("collab_sessions", { workspaceId });
export const collabTick = (sessionId: string, live: { repoKey: string; path: string }[] = []) =>
  invoke<CollabTick>("collab_tick", { sessionId, live });
export const collabLiveConnection = (sessionId: string) => invoke<{ url: string; anonKey: string }>("collab_live_connection", { sessionId });
export const collabThread = (sessionId: string) => invoke<CollabMessage[]>("collab_thread", { sessionId });
export const collabResolve = (sessionId: string, repoKey: string, path: string, keepMine: boolean) =>
  invoke<void>("collab_resolve", { sessionId, repoKey, path, keepMine });
export const collabCommit = (sessionId: string, message: string) => invoke<CollabCommitted[]>("collab_commit", { sessionId, message });
export const collabLeave = (sessionId: string, keep: boolean) => invoke<CollabLeft[]>("collab_leave", { sessionId, keep });
export const collabRemovePerson = (sessionId: string, personId: string) =>
  invoke<void>("collab_remove_person", { sessionId, personId });
export const collabInstallSql = () => invoke<string>("collab_install_sql");
