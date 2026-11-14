import type { CollabMessage } from "./tauri/collabCommands";

/**
 * Pure helpers of shared workspace chats (`state/sharedChatStore.ts`), kept apart so they are tested
 * directly.
 */

/** One row of a shared chat's transcript: one of this machine's own messages, or another person's turn. */
export type TranscriptRow<T> = { kind: "own"; message: T; index: number } | { kind: "other"; message: CollabMessage };

/**
 * The chat's own messages with the other people's turns slotted in by time. An own message with no
 * timestamp (the bubble of a question still being sent) counts as now. Turns from others that
 * happened after everything local go at the end.
 */
export function interleave<T extends { createdAt?: string }>(own: T[], others: CollabMessage[], now = Date.now()): TranscriptRow<T>[] {
  const time = (iso: string | undefined, fallback: number) => {
    const parsed = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const pending = [...others].sort((a, b) => time(a.createdAt, 0) - time(b.createdAt, 0) || a.seq - b.seq);
  const rows: TranscriptRow<T>[] = [];
  let next = 0;
  own.forEach((message, index) => {
    const at = time(message.createdAt, now);
    while (next < pending.length && time(pending[next].createdAt, 0) <= at) {
      rows.push({ kind: "other", message: pending[next++] });
    }
    rows.push({ kind: "own", message, index });
  });
  while (next < pending.length) rows.push({ kind: "other", message: pending[next++] });
  return rows;
}

const ENGINES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  agy: "Gemini",
  cline: "Cline",
  grok: "Grok",
  opencode: "OpenCode",
  copilot: "Copilot",
};

/** A provider id as people say it ("codex" → "Codex"); unknown ids are capitalised. */
export function engineName(provider: string | undefined | null): string {
  const id = (provider ?? "").trim().toLowerCase();
  if (!id) return "su agente";
  return ENGINES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The two letters of an avatar: initials of a nick ("Dev B" → "DB", "sebas" → "SE"). */
export function initials(nick: string): string {
  const words = nick.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** A stable hue per person, so the same nick keeps its colour in every window. */
export function hueOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}
