import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_QUEUE,
  chatQueueKey,
  dropChatQueue,
  enqueueChatMessage,
  holdChatQueue,
  queueHold,
  queuedAttachmentIds,
  queuedMessages,
  releaseChatQueue,
  requeueChatMessageFirst,
  shiftChatQueue,
  takeQueuedChatMessage,
  useChatQueueStore,
} from "./chatQueueStore";
import type { ChatAttachment } from "../lib/tauri/chatCommands";

/**
 * The queue both chats share. What is pinned here is the part the two surfaces must agree on —
 * order, what "held" stops, and what lets it go again — because each store only decides *when* to
 * advance and relies on these for everything else.
 */

const KEY = chatQueueKey("chat", "c-1");

function file(id: string): ChatAttachment {
  return { id, name: id, path: `/tmp/${id}`, bytes: 1, isImage: false };
}

const texts = (key = KEY) => queuedMessages(key).map((item) => item.text);

beforeEach(() => {
  useChatQueueStore.setState({ items: {}, held: {} });
});

describe("the queue", () => {
  it("hands messages back in the order they were written", () => {
    enqueueChatMessage(KEY, { text: "one" });
    enqueueChatMessage(KEY, { text: "two" });
    enqueueChatMessage(KEY, { text: "three" });
    expect(shiftChatQueue(KEY)?.text).toBe("one");
    expect(shiftChatQueue(KEY)?.text).toBe("two");
    expect(texts()).toEqual(["three"]);
  });

  it("keeps each conversation's queue, and each surface's, apart", () => {
    enqueueChatMessage(KEY, { text: "here" });
    enqueueChatMessage(chatQueueKey("chat", "c-2"), { text: "elsewhere" });
    enqueueChatMessage(chatQueueKey("panel", "c-1"), { text: "the panel's" });
    expect(shiftChatQueue(chatQueueKey("chat", "c-2"))?.text).toBe("elsewhere");
    expect(texts()).toEqual(["here"]);
    expect(texts(chatQueueKey("panel", "c-1"))).toEqual(["the panel's"]);
  });

  it("gives nothing back while held, and everything once released", () => {
    enqueueChatMessage(KEY, { text: "one" });
    holdChatQueue(KEY, "error");
    expect(shiftChatQueue(KEY)).toBeNull();
    expect(texts()).toEqual(["one"]);
    releaseChatQueue(KEY);
    expect(shiftChatQueue(KEY)?.text).toBe("one");
  });

  it("never holds an empty queue — the mark would hold back the next message written", () => {
    holdChatQueue(KEY, "stopped");
    expect(queueHold(KEY)).toBeNull();
  });

  it("lets a held queue go when something new is written, and puts the new one last", () => {
    enqueueChatMessage(KEY, { text: "old" });
    holdChatQueue(KEY, "error");
    enqueueChatMessage(KEY, { text: "new" });
    expect(queueHold(KEY)).toBeNull();
    expect(texts()).toEqual(["old", "new"]);
  });

  it("puts a message that never ran back first, without touching the hold", () => {
    enqueueChatMessage(KEY, { text: "second" });
    holdChatQueue(KEY, "error");
    requeueChatMessageFirst(KEY, { text: "first" });
    expect(texts()).toEqual(["first", "second"]);
    expect(queueHold(KEY)).toBe("error");
  });

  it("takes one message out by id, and clears the hold once nothing is left", () => {
    const one = enqueueChatMessage(KEY, { text: "one" });
    const two = enqueueChatMessage(KEY, { text: "two" });
    holdChatQueue(KEY, "stopped");
    expect(takeQueuedChatMessage(KEY, one.id)?.text).toBe("one");
    expect(queueHold(KEY)).toBe("stopped");
    expect(takeQueuedChatMessage(KEY, two.id)?.text).toBe("two");
    expect(queueHold(KEY)).toBeNull();
    expect(takeQueuedChatMessage(KEY, "gone")).toBeNull();
  });

  it("forgets a deleted conversation's queue and says what was in it", () => {
    enqueueChatMessage(KEY, { text: "one", attachments: [file("a.pdf")] });
    holdChatQueue(KEY, "error");
    expect(dropChatQueue(KEY).map((item) => item.text)).toEqual(["one"]);
    expect(queuedMessages(KEY)).toBe(EMPTY_QUEUE);
    expect(queueHold(KEY)).toBeNull();
  });

  it("knows which files its messages are carrying", () => {
    enqueueChatMessage(KEY, { text: "one", attachments: [file("a.pdf"), file("b.png")] });
    enqueueChatMessage(KEY, { text: "two" });
    expect([...queuedAttachmentIds(KEY)].sort()).toEqual(["a.pdf", "b.png"]);
  });

  it("answers the same empty list for every empty queue", () => {
    // A selector returning a fresh `[]` would re-render every subscriber on each store write.
    expect(queuedMessages(KEY)).toBe(EMPTY_QUEUE);
    const only = enqueueChatMessage(KEY, { text: "one" });
    takeQueuedChatMessage(KEY, only.id);
    expect(queuedMessages(KEY)).toBe(EMPTY_QUEUE);
  });
});
