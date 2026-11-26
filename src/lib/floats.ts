import { WINDOW } from "./windowIdentity";

/**
 * The floating windows: a conversation with a team, one with a single agent, and the call with a
 * team, each in a window of the system's of its own (`windows::float_open`).
 *
 * A window is known by its **key** — `call`, `team:<team id>`, `agent:<agent id>` — which is what
 * makes it one window per team, per agent and for the call, whichever conversation it is showing.
 * What it shows travels beside it as a **ref**: `key|conversation|workspace|owner`, which the
 * window is opened with and reads its first frame from.
 */
export type FloatKind = "team" | "agent" | "call";

export interface FloatRef {
  key: string;
  kind: FloatKind;
  /** The team chat, the task that is an agent's conversation, or the call's id. */
  chatId: string;
  workspaceId: string;
  /** The team, or the agent. */
  owner: string;
}

/** An agent that is gone has a window per conversation: nothing else tells them apart. */
export function floatKey(kind: FloatKind, owner: string, chatId: string): string {
  if (kind === "call") return "call";
  return kind === "team" ? `team:${owner || chatId}` : `agent:${owner || `task-${chatId}`}`;
}

export const encodeFloatRef = (ref: FloatRef): string => [ref.key, ref.chatId, ref.workspaceId, ref.owner].join("|");

export function parseFloatRef(raw: string): FloatRef | null {
  const [key = "", chatId = "", workspaceId = "", owner = ""] = raw.split("|");
  const family = key.split(":")[0];
  const kind: FloatKind | null = family === "call" ? "call" : family === "team" ? "team" : family === "agent" ? "agent" : null;
  return kind && chatId ? { key, kind, chatId, workspaceId, owner } : null;
}

/** What this window holds when it is a floating one, as it was opened; `null` in every other. */
export const FLOAT: FloatRef | null = WINDOW.satellite?.kind === "float" ? parseFloatRef(WINDOW.satellite.refId) : null;
