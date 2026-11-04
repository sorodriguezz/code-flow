/**
 * Where a chat island's comings and goings are announced — the chat half of `islandSync`.
 *
 * `windowStore` sees every `windows:satellites` push and calls these; what they do lives in
 * `lib/chatIslands`, which registers itself here. The indirection keeps `windowStore` free of the
 * chat stores (and of an import cycle through them).
 */

/** What a chat island holds, read from its `refId`. */
export type ChatIslandRef =
  | { surface: "panel"; projectId: string; conversationId: string }
  | { surface: "ws"; workspaceId: string; conversationId: string };

/** `"panel:<project>:<conversation>"` / `"ws:<workspace>:<conversation>"`. Ids never hold a colon
 *  (UUIDs, `conv-<uuid>`), but the conversation part takes everything after the second one anyway. */
export function chatIslandRefId(ref: ChatIslandRef): string {
  return ref.surface === "panel"
    ? `panel:${ref.projectId}:${ref.conversationId}`
    : `ws:${ref.workspaceId}:${ref.conversationId}`;
}

export function parseChatIslandRef(refId: string): ChatIslandRef | null {
  const first = refId.indexOf(":");
  const second = first < 0 ? -1 : refId.indexOf(":", first + 1);
  if (second < 0) return null;
  const surface = refId.slice(0, first);
  const scope = refId.slice(first + 1, second);
  const conversationId = refId.slice(second + 1);
  if (!scope || !conversationId) return null;
  if (surface === "panel") return { surface, projectId: scope, conversationId };
  if (surface === "ws") return { surface, workspaceId: scope, conversationId };
  return null;
}

interface ChatIslandHandler {
  opened: (ref: ChatIslandRef) => void;
  returned: (ref: ChatIslandRef) => void;
}

let handler: ChatIslandHandler | null = null;

export function registerChatIslandHandler(next: ChatIslandHandler): void {
  handler = next;
}

export function chatIslandOpened(refId: string): void {
  const ref = parseChatIslandRef(refId);
  if (ref) handler?.opened(ref);
}

export function chatIslandReturned(refId: string): void {
  const ref = parseChatIslandRef(refId);
  if (ref) handler?.returned(ref);
}

/** Whether a pointer is past the window's edges — where a chat tab let go becomes an island. The
 *  page keeps receiving a captured pointer out there, with coordinates beyond the viewport. Pure. */
export function outsideViewport(clientX: number, clientY: number, width: number, height: number): boolean {
  return clientX < 0 || clientY < 0 || clientX >= width || clientY >= height;
}

/** How far a press has to travel before it is a drag and not a click. */
export const TEAR_THRESHOLD_PX = 6;
