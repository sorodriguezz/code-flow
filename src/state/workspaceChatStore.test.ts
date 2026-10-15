import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The assistant's workspace chat: a tab before it is a row, so its first question has to create
 * the row — with what was picked meanwhile — before it is sent; and Enter while it answers queues.
 */

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  sends: [] as { resolve: (value: unknown) => void; reject: (error: unknown) => void }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    backend.calls.push({ name, args });
    if (name === "chat_create_workspace_conversation") {
      return {
        id: args.conversationId,
        workspaceId: args.workspaceId,
        projectId: null,
        title: "",
        provider: args.provider || "claude",
        model: args.model ?? "",
        systemPrompt: "",
        effort: args.effort ?? "",
        groupId: null,
        unread: false,
        lastFailed: false,
        compactedSummary: "",
        compactedThroughTurn: null,
        cavemanLevel: "",
        contextTokens: null,
        engineSessionId: null,
        pinnedAt: null,
        archivedAt: null,
        parentConversationId: null,
        branchedAtTurn: null,
        accountId: null,
        workspaceScope: true,
        agentId: args.agentId ?? "",
        focusChainId: args.focusChainId ?? "",
        createdAt: "t",
        updatedAt: "t",
      };
    }
    if (name === "chat_attach_file") {
      const name_ = String(args.sourcePath).split("/").pop();
      return { id: `x-${name_}`, name: name_, path: `/state/chat-attachments/${args.conversationId}/x-${name_}`, bytes: 1, isImage: true };
    }
    if (name === "chat_send") return new Promise((resolve, reject) => backend.sends.push({ resolve, reject }));
    return /(^|_)list(_|$)/.test(name) || name === "chat_inflight_turns" ? [] : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: () => {} }));
vi.mock("../lib/speech/speakAnswer", () => ({ speakAnswer: () => {} }));

const { useWorkspaceChatStore, wsChatQueueKey } = await import("./workspaceChatStore");
const { queuedMessages } = await import("./chatQueueStore");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function reply(text: string) {
  return {
    text,
    session_id: "ses-1",
    model: "opus",
    provider: "claude",
    engine_version: null,
    created_at: "2026-10-15T10:00:00Z",
    response_time_ms: 10,
    message_id: `m-${text}`,
    compacted: false,
    outputs: [],
    account_id: null,
  };
}

beforeEach(() => {
  backend.calls = [];
  backend.sends = [];
  useWorkspaceChatStore.setState({ byConversation: {}, listByWorkspace: {}, attachments: {} });
});

describe("workspace chat", () => {
  it("creates the row with what was picked before the first question, then sends it", async () => {
    const store = useWorkspaceChatStore.getState();
    store.prepare("11111111-1111-4111-8111-111111111111", "ws-1", { focusChainId: "chain-9" });
    await store.setEffort("11111111-1111-4111-8111-111111111111", "high");
    await store.setAgent("11111111-1111-4111-8111-111111111111", "agent-2");
    // Nothing persisted yet: the picks wait for the row.
    expect(backend.calls.map((c) => c.name)).toEqual([]);

    store.send("11111111-1111-4111-8111-111111111111", "where is the story at?");
    await flush();
    const names = backend.calls.map((c) => c.name);
    expect(names.indexOf("chat_create_workspace_conversation")).toBeLessThan(names.indexOf("chat_send"));
    const created = backend.calls.find((c) => c.name === "chat_create_workspace_conversation")!.args;
    expect(created).toMatchObject({ workspaceId: "ws-1", effort: "high", agentId: "agent-2", focusChainId: "chain-9" });

    backend.sends[0].resolve(reply("at the gate"));
    await flush();
    const session = useWorkspaceChatStore.getState().byConversation["11111111-1111-4111-8111-111111111111"];
    expect(session.sending).toBe(false);
    expect(session.persisted).toBe(true);
    expect(session.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "where is the story at?"],
      ["assistant", "at the gate"],
    ]);
  });

  it("queues what is sent while a turn runs, and sends it when the answer lands", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    store.submit(id, "first");
    await flush();
    store.submit(id, "second");
    expect(queuedMessages(wsChatQueueKey(id)).map((q) => q.text)).toEqual(["second"]);
    backend.sends[0].resolve(reply("one"));
    await flush();
    expect(queuedMessages(wsChatQueueKey(id))).toHaveLength(0);
    expect(backend.calls.filter((c) => c.name === "chat_send").map((c) => c.args.message)).toEqual(["first", "second"]);
    // The row is created once, by the first question.
    expect(backend.calls.filter((c) => c.name === "chat_create_workspace_conversation")).toHaveLength(1);
  });

  it("files a failure in the transcript and holds the queue", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    store.send(id, "go");
    await flush();
    store.submit(id, "after");
    backend.sends[0].reject("engine exploded");
    await flush();
    const session = useWorkspaceChatStore.getState().byConversation[id];
    expect(session.messages[session.messages.length - 1]).toMatchObject({ role: "assistant", isError: true, content: "engine exploded" });
    expect(queuedMessages(wsChatQueueKey(id)).map((q) => q.text)).toEqual(["after"]);
  });

  it("sends the staged images with the question, and a queued question keeps its own", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    await store.attachImagePath(id, "/Users/me/shot.png");
    store.submit(id, "what is this?");
    await flush();
    // Taken off the composer the moment it was asked, and shown on the question.
    expect(useWorkspaceChatStore.getState().attachments[id]).toEqual([]);
    expect(useWorkspaceChatStore.getState().byConversation[id].messages[0].attachments?.map((f) => f.name)).toEqual(["shot.png"]);

    await store.attachImagePath(id, "/Users/me/next.png");
    store.submit(id, "and this one?");
    expect(useWorkspaceChatStore.getState().attachments[id]).toEqual([]);
    backend.sends[0].resolve(reply("a chart"));
    await flush();
    const sent = backend.calls.filter((c) => c.name === "chat_send").map((c) => c.args.attachments);
    expect(sent).toEqual([["x-shot.png"], ["x-next.png"]]);
  });

  it("removing a staged image deletes its copy", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    await store.attachImagePath(id, "/Users/me/shot.png");
    store.removeAttachment(id, "x-shot.png");
    expect(useWorkspaceChatStore.getState().attachments[id]).toEqual([]);
    expect(backend.calls.find((c) => c.name === "chat_remove_attachment")?.args).toEqual({ conversationId: id, attachmentId: "x-shot.png" });
  });
});
