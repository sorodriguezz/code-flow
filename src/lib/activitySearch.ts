import { entryTitle, type ActivityEntry } from "./activityEntries";
import type { AssistantChatHit } from "./tauri/commands";

export function searchSnippet(text: string, query: string): string | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const offset = text.toLowerCase().indexOf(needle);
  if (offset < 0) return null;
  const chars = Array.from(text);
  let folded = 0;
  let at = 0;
  while (at < chars.length && folded < offset) folded += chars[at++].toLowerCase().length;
  const start = Math.max(0, at - 40);
  return `${start ? "…" : ""}${chars.slice(start, start + 180).join("").replace(/\s+/g, " ")}${chars.length > start + 180 ? "…" : ""}`;
}

/** null means no match; an empty snippet means the visible title already explains the match. */
export function activitySearchMatch(entry: ActivityEntry, query: string, hits: AssistantChatHit[]): string | null {
  if (!query.trim() || searchSnippet(entryTitle(entry), query) !== null) return "";
  if (entry.type === "chat") {
    for (const message of entry.live?.messages ?? []) {
      const snippet = searchSnippet(message.content, query);
      if (snippet !== null) return snippet;
    }
    return hits.find((hit) => hit.projectId === entry.conv.project_id && hit.conversationId === entry.conv.session_id)?.snippet ?? null;
  }
  for (const run of entry.runs) {
    for (const text of [run.result, run.error ? JSON.stringify(run.error) : null, JSON.stringify(run.meta)]) {
      const snippet = text ? searchSnippet(text, query) : null;
      if (snippet !== null) return snippet;
    }
  }
  return null;
}
