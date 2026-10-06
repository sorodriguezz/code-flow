import type { PrCommentThread } from "../types/domain";

/**
 * A pull request's comment thread as text for a model — the instruction a fix is given, and the
 * conversation a reply is drafted from. One place, because the PR panel's comment card and Flujos'
 * "Resolver con IA" / "Responder con IA" nodes (through `flows::bridge`) must say the same thing.
 */

function locationLabel(thread: PrCommentThread): string | null {
  if (!thread.file_path || thread.start_line === null) return null;
  const end = thread.end_line !== null && thread.end_line !== thread.start_line ? `-${thread.end_line}` : "";
  return `${thread.file_path}:${thread.start_line}${end}`;
}

/** What a fix of the thread's request is told. */
export function threadFixPrompt(thread: PrCommentThread): string {
  const lines = ["Comentario de revisión en el pull request:"];
  const loc = locationLabel(thread);
  if (loc) lines.push(`Ubicación: ${loc}`);
  for (const c of thread.comments) lines.push(`${c.author}: ${c.content}`);
  return lines.join("\n");
}

/** The conversation as plain text, for the model drafting a reply to it. Same shape the card
 *  renders, minus the markup — what was said, by whom, and where. */
export function threadAsText(thread: PrCommentThread): string {
  const loc = locationLabel(thread);
  const head = loc ? `Ubicación: ${loc}\n` : "";
  return head + thread.comments.map((c) => `${c.author}: ${c.content}`).join("\n\n");
}

/** The thread's location, `file:line` or `file:start-end` — what a card shows. */
export function threadLocation(thread: PrCommentThread): string | null {
  return locationLabel(thread);
}
