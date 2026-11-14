import { invoke } from "./invoke";
import type { CollabPerson, CollabSessionView } from "./collabCommands";

/**
 * Shared «Equipo» runs (`src-tauri/src/collab/team.rs`): a run that stays on its owner's machine,
 * with seats other people fill with agents of their own, on their machines and accounts.
 */

/** A member of a run as the share dialog offers it. */
export interface CollabSeatCandidate {
  memberId: string;
  name: string;
  role: string;
  engine: string;
  /** Why it cannot be a seat (it plans), or `null`. */
  fixed: string | null;
}

/** A seat as this machine knows it. `personId` is `""` while free. */
export interface CollabRunSeat {
  memberId: string;
  name: string;
  role: string;
  personId: string;
  nick: string;
  /** The agent's name on its person's machine, and its engine. */
  agent: string;
  engine: string;
  /** On a guest's machine: the agent of their roster sitting in it. */
  localAgentId: string;
}

/** A seat's task, as the owner offered it. */
export interface CollabRemoteTask {
  itemId: string;
  attempt: number;
  memberId: string;
  personId: string;
  repoKey: string;
  kind: "work" | "review";
  title: string;
  /** The message the agent starts from, composed on the owner's machine. */
  message: string;
  writes: boolean;
  target: string;
  startSha: string;
  status: "offered" | "accepted" | "done" | "failed" | "declined" | "withdrawn";
  updatedAt: string;
}

export interface CollabRunJob {
  itemId: string;
  attempt: number;
  /** Owner: queued → offered → settled. Guest: offered → running → reported, declined, withdrawn. */
  state: string;
  title: string;
  error: string;
  updatedAt: string;
}

/** The owner's picture of the run, as every other screen draws it. */
export interface SharedRunPicture {
  title: string;
  goal: string;
  status: string;
  gate: string;
  gateNote: string;
  lead: string;
  members: { id: string; name: string; role: string; engine: string }[];
  repos: { name: string; targetBranch: string }[];
  items: {
    id: string;
    key: string;
    memberId: string;
    kind: string;
    title: string;
    status: string;
    remote: boolean;
    merged: boolean;
    lastError: string;
    startedAt: string;
    finishedAt: string;
  }[];
  messages: { id: string; fromId: string; fromName: string; toId: string; toName: string; kind: string; body: string; createdAt: string }[];
}

export interface CollabRunTick {
  sessionId: string;
  owner: boolean;
  ended: boolean;
  people: CollabPerson[];
  seats: CollabRunSeat[];
  run: SharedRunPicture | null;
  /** Guest: offered to them, waiting for their answer. */
  offers: CollabRemoteTask[];
  jobs: CollabRunJob[];
  errors: string[];
}

export const collabRunCandidates = (runId: string) => invoke<CollabSeatCandidate[]>("collab_run_candidates", { runId });
export const collabRunShare = (args: { runId: string; projectUrl: string; nick: string; seats: string[] }) =>
  invoke<{ view: CollabSessionView; link: string }>("collab_run_share", args);
export const collabRunFor = (runId: string) => invoke<CollabSessionView | null>("collab_run_for", { runId });
export const collabRunSessions = (workspaceId: string) => invoke<CollabSessionView[]>("collab_run_sessions", { workspaceId });
export const collabRunTick = (sessionId: string) => invoke<CollabRunTick>("collab_run_tick", { sessionId });
export const collabRunSetSeats = (sessionId: string, seats: string[]) => invoke<void>("collab_run_set_seats", { sessionId, seats });
export const collabRunTakeSeat = (sessionId: string, memberId: string, agentId: string) =>
  invoke<void>("collab_run_take_seat", { sessionId, memberId, agentId });
export const collabRunFreeSeat = (sessionId: string, memberId: string) => invoke<void>("collab_run_free_seat", { sessionId, memberId });
export const collabRunAccept = (sessionId: string, itemId: string) => invoke<void>("collab_run_accept", { sessionId, itemId });
export const collabRunDecline = (sessionId: string, itemId: string, reason?: string) =>
  invoke<void>("collab_run_decline", { sessionId, itemId, reason: reason ?? null });
export const collabRunNote = (sessionId: string, to: string, text: string) => invoke<void>("collab_run_note", { sessionId, to, text });
