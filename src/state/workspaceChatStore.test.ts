import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The assistant's workspace chat: a tab before it is a row, so its first question has to create
 * the row — with what was picked meanwhile — before it is sent; and Enter while it answers queues.
 */

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  sends: [] as { resolve: (value: unknown) => void; reject: (error: unknown) => void }[],
  /** Rows `chat_list_workspace_conversations` answers with. */
  list: [] as Record<string, unknown>[],
  /** `chat_get_conversation` fails with this while set. */
  getFails: null as string | null,
  failedChanges: null as unknown,
  clearReply: null as unknown,
  /** `chat_get_conversation` rows, when a test needs the disk to answer with some. */
  rows: [] as Record<string, unknown>[],
  truncateFails: null as string | null,
  confirm: true,
  confirmed: [] as string[],
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
        focusChainId: args.focusChainId ?? "",
        createdAt: "t",
        updatedAt: "t",
      };
    }
    if (name === "chat_attach_file") {
      const name_ = String(args.sourcePath).split("/").pop();
      return { id: `x-${name_}`, name: name_, path: `/state/chat-attachments/${args.conversationId}/x-${name_}`, bytes: 1, isImage: true };
    }
    if (name === "chat_get_conversation") {
      if (backend.getFails) throw backend.getFails;
      return backend.rows;
    }
    if (name === "chat_truncate_from") {
      if (backend.truncateFails) throw backend.truncateFails;
      return { id: args.conversationId, contextResets: [], engineSessionId: null };
    }
    if (name === "chat_caveman_levels") return ["lite", "full", "ultra"];
    if (name === "chat_caveman_resolve") return args.argument === "nope" ? null : args.argument || "full";
    if (name === "chat_clear_context") return backend.clearReply;
    if (name === "chat_failed_turn_changes") return backend.failedChanges;
    if (name === "chat_list_workspace_conversations") return backend.list;
    if (name === "chat_send") return new Promise((resolve, reject) => backend.sends.push({ resolve, reject }));
    return /(^|_)list(_|$)/.test(name) || name === "chat_inflight_turns" ? [] : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: () => {} }));
vi.mock("./confirmStore", () => ({
  confirmAction: async (message: string) => {
    backend.confirmed.push(message);
    return backend.confirm;
  },
}));
vi.mock("../lib/speech/speakAnswer", () => ({ speakAnswer: () => {} }));

const { messageFromRow, useWorkspaceChatStore, wsChatQueueKey, wsEditPlan, pruneSessions, pinWsChat } = await import("./workspaceChatStore");
const { CANCELLED_MARKER } = await import("./aiRunStore");
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
  backend.list = [];
  backend.getFails = null;
  backend.rows = [];
  backend.truncateFails = null;
  backend.confirm = true;
  backend.confirmed = [];
  useWorkspaceChatStore.setState({ byConversation: {}, listByWorkspace: {}, attachments: {}, scopeRepos: {}, compacting: {}, editing: {} });
});

describe("workspace chat", () => {
  it("creates the row with what was picked before the first question, then sends it", async () => {
    const store = useWorkspaceChatStore.getState();
    store.prepare("11111111-1111-4111-8111-111111111111", "ws-1", { focusChainId: "chain-9" });
    await store.setEffort("11111111-1111-4111-8111-111111111111", "high");
    // Nothing persisted yet: the picks wait for the row.
    expect(backend.calls.map((c) => c.name)).toEqual([]);

    store.send("11111111-1111-4111-8111-111111111111", "where is the story at?");
    await flush();
    const names = backend.calls.map((c) => c.name);
    expect(names.indexOf("chat_create_workspace_conversation")).toBeLessThan(names.indexOf("chat_send"));
    const created = backend.calls.find((c) => c.name === "chat_create_workspace_conversation")!.args;
    expect(created).toMatchObject({ workspaceId: "ws-1", effort: "high", focusChainId: "chain-9" });
    expect(created).not.toHaveProperty("agentId");

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

  it("keeps /caveman for the row a fresh chat's first question creates, and writes it live after", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    expect(await store.applyCaveman(id, "ultra")).toBe(true);
    expect(await store.applyCaveman(id, "nope")).toBe(false);
    expect(useWorkspaceChatStore.getState().byConversation[id].cavemanLevel).toBe("ultra");
    // No row yet, so nothing was written.
    expect(backend.calls.some((c) => c.name === "chat_set_caveman")).toBe(false);
    store.send(id, "hello");
    await flush();
    const names = backend.calls.map((c) => c.name);
    expect(names.indexOf("chat_set_caveman")).toBeGreaterThan(names.indexOf("chat_create_workspace_conversation"));
    expect(names.indexOf("chat_set_caveman")).toBeLessThan(names.indexOf("chat_send"));
    backend.sends[0].resolve(reply("hi"));
    await flush();
    await store.applyCaveman(id, "off");
    expect(backend.calls.filter((c) => c.name === "chat_set_caveman").pop()?.args.level).toBe("off");
  });

  it("restores context, usage and unprotected folders from a stored row", () => {
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null };
    const base = { id: "m", turn: 1, role: "assistant", content: "a", createdAt: "t", isError: false, isCancelled: false };
    const full = messageFromRow({ ...base, context: [{ kind: "file", label: "x" }], usage, unprotectedDirs: ["/tmp/a"] } as never);
    expect(full.usage).toEqual(usage);
    expect(full.unprotectedDirs).toEqual(["/tmp/a"]);
    expect(full.context).toHaveLength(1);
    const bare = messageFromRow({ ...base, context: [], unprotectedDirs: [] } as never);
    expect([bare.context, bare.usage, bare.unprotectedDirs]).toEqual([undefined, undefined, undefined]);
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
    await store.attachFilePath(id, "/Users/me/shot.png");
    store.submit(id, "what is this?");
    await flush();
    // Taken off the composer the moment it was asked, and shown on the question.
    expect(useWorkspaceChatStore.getState().attachments[id]).toEqual([]);
    expect(useWorkspaceChatStore.getState().byConversation[id].messages[0].attachments?.map((f) => f.name)).toEqual(["shot.png"]);

    await store.attachFilePath(id, "/Users/me/next.png");
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
    await store.attachFilePath(id, "/Users/me/shot.png");
    store.removeAttachment(id, "x-shot.png");
    expect(useWorkspaceChatStore.getState().attachments[id]).toEqual([]);
    expect(backend.calls.find((c) => c.name === "chat_remove_attachment")?.args).toEqual({ conversationId: id, attachmentId: "x-shot.png" });
  });

  const row = (id: string) => ({
    id,
    workspaceId: "ws-1",
    projectId: null,
    title: "t",
    provider: "claude",
    model: "opus",
    effort: "",
    contextTokens: null,
    engineSessionId: null,
    focusChainId: "",
    contextResets: [{ turn: 2, reason: "clear" }],
    workspaceScope: true,
    createdAt: "t",
    updatedAt: "t",
  });

  it("keeps a transcript that could not be read as an error, not as an empty chat", async () => {
    const id = "66666666-6666-4666-8666-666666666666";
    backend.list = [row(id)];
    backend.getFails = "disk gone";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1", { fresh: false });
    expect(useWorkspaceChatStore.getState().byConversation[id].loaded).toBe(false);
    await store.ensureLoaded(id, "ws-1");
    let session = useWorkspaceChatStore.getState().byConversation[id];
    expect(session.loaded).toBe(false);
    expect(session.loadError).toBe("disk gone");

    // Retry once the disk is back: loaded, error gone, the row's resets carried.
    backend.getFails = null;
    await store.ensureLoaded(id, "ws-1");
    session = useWorkspaceChatStore.getState().byConversation[id];
    expect(session.loaded).toBe(true);
    expect(session.loadError).toBeNull();
    expect(session.contextResets).toEqual([{ turn: 2, reason: "clear" }]);
  });

  it("a chat with no row yet is loaded, not stuck loading", async () => {
    const id = "77777777-7777-4777-8777-777777777777";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1", { fresh: false });
    await store.ensureLoaded(id, "ws-1");
    const session = useWorkspaceChatStore.getState().byConversation[id];
    expect(session.loaded).toBe(true);
    expect(session.loadError).toBeNull();
  });

  it("refuses to delete a chat that is answering, and says whether it deleted", async () => {
    const id = "88888888-8888-4888-8888-888888888888";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    store.send(id, "long one");
    await flush();
    expect(await store.remove(id)).toBe(false);
    expect(backend.calls.some((c) => c.name === "chat_delete_conversation")).toBe(false);
    expect(useWorkspaceChatStore.getState().byConversation[id]).toBeDefined();

    backend.sends[0].resolve(reply("done"));
    await flush();
    expect(await useWorkspaceChatStore.getState().remove(id)).toBe(true);
    expect(backend.calls.some((c) => c.name === "chat_delete_conversation")).toBe(true);
    expect(useWorkspaceChatStore.getState().byConversation[id]).toBeUndefined();
  });

  it("retry stops the running turn and asks the same question again", async () => {
    const id = "99999999-9999-4999-8999-999999999999";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    store.send(id, "same question");
    await flush();
    store.retryTurn(id);
    backend.sends[0].reject(`${CANCELLED_MARKER}`);
    await flush();
    await flush();
    const asked = backend.calls.filter((c) => c.name === "chat_send").map((c) => c.args.message);
    expect(asked).toEqual(["same question", "same question"]);
    expect(useWorkspaceChatStore.getState().byConversation[id].sending).toBe(true);
  });

  it("regenerating is the same question submitted again", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    store.send(id, "explain");
    await flush();
    backend.sends[0].resolve(reply("first take"));
    await flush();
    store.submit(id, "explain");
    await flush();
    backend.sends[1].resolve(reply("second take"));
    await flush();
    const messages = useWorkspaceChatStore.getState().byConversation[id].messages;
    expect(messages.map((m) => m.content)).toEqual(["explain", "first take", "explain", "second take"]);
  });

  it("limits a conversation to some repositories, null for all", () => {
    const store = useWorkspaceChatStore.getState();
    expect(store.scopeFor("c")).toBeNull();
    store.setScope("c", ["p1", "p2"]);
    expect(useWorkspaceChatStore.getState().scopeFor("c")).toEqual(["p1", "p2"]);
    useWorkspaceChatStore.getState().setScope("c", []);
    expect(useWorkspaceChatStore.getState().scopeFor("c")).toBeNull();
  });

  it("drops the oldest idle sessions past the cap, never a running, unsaved or on-screen one", async () => {
    const store = useWorkspaceChatStore.getState();
    useWorkspaceChatStore.setState({ byConversation: {} });
    for (let i = 0; i < 6; i++) {
      backend.list = [...backend.list, row(`c${i}`)];
    }
    useWorkspaceChatStore.setState({ listByWorkspace: { "ws-1": backend.list as never } });
    for (let i = 0; i < 6; i++) store.prepare(`c${i}`, "ws-1");
    store.prepare("fresh", "ws-1"); // never written: memory is its only copy
    const unpin = pinWsChat("c0"); // on screen
    pruneSessions(3);
    const left = Object.keys(useWorkspaceChatStore.getState().byConversation).sort();
    expect(left).toContain("c0");
    expect(left).toContain("fresh");
    expect(left.length).toBe(3);
    unpin();
  });

  it("sends the conversation's repository scope with the question, null for all", async () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    store.send(id, "all of them");
    await flush();
    expect(backend.calls.filter((c) => c.name === "chat_send")[0].args.repos).toBeNull();
    backend.sends[0].resolve(reply("ok"));
    await flush();
    useWorkspaceChatStore.getState().setScope(id, ["p1"]);
    useWorkspaceChatStore.getState().send(id, "just one");
    await flush();
    expect(backend.calls.filter((c) => c.name === "chat_send")[1].args.repos).toEqual(["p1"]);
    // A removed repository in the scope is refused by name: shown, and the scope goes back to all.
    backend.sends[1].reject("unknown repository for this workspace: p1");
    await flush();
    const session = useWorkspaceChatStore.getState().byConversation[id];
    expect(session.messages[session.messages.length - 1]).toMatchObject({ isError: true, content: "unknown repository for this workspace: p1" });
    expect(useWorkspaceChatStore.getState().scopeFor(id)).toBeNull();
  });

  it("re-keys a failed turn to its persisted id and attaches what it changed", async () => {
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    backend.failedChanges = { message_id: "persisted-1", checkpoint: null, checkpoints: JSON.stringify([{ repo: "api", path: "/w/api", id: "cp1", paths: ["a.ts"] }]) };
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    store.send(id, "edit things");
    await flush();
    backend.sends[0].reject("engine exploded");
    await flush();
    await flush();
    const last = useWorkspaceChatStore.getState().byConversation[id].messages.slice(-1)[0];
    expect(last.id).toBe("persisted-1");
    expect(last.changes).toEqual([{ repo: "api", repoPath: "/w/api", checkpointId: "cp1", paths: ["a.ts"] }]);
    backend.failedChanges = null;
  });

  it("keeps a reply's context, usage and unprotected folders on the answer", async () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    store.send(id, "q");
    await flush();
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null };
    backend.sends[0].resolve({ ...reply("a"), usage, unprotected_dirs: ["/w/scratch"], context: [{ kind: "file", label: "x" }] });
    await flush();
    const answer = useWorkspaceChatStore.getState().byConversation[id].messages.slice(-1)[0];
    expect(answer.usage).toEqual(usage);
    expect(answer.unprotectedDirs).toEqual(["/w/scratch"]);
    expect(answer.context).toHaveLength(1);
  });

  it("/clear stores the reset the backend wrote and drops the measured context", async () => {
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    backend.list = [{ ...row(id), contextResets: [] }];
    useWorkspaceChatStore.setState({ listByWorkspace: { "ws-1": backend.list as never } });
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    backend.clearReply = { ...row(id), contextResets: [{ turn: 4, reason: "clear" }] };
    await store.clearContext(id);
    const session = useWorkspaceChatStore.getState().byConversation[id];
    expect(session.contextResets).toEqual([{ turn: 4, reason: "clear" }]);
    expect(session.contextTokens).toBeNull();
    expect(backend.calls.some((c) => c.name === "chat_clear_context")).toBe(true);
  });
});

/** «Editar y reenviar»: the thread is cut at the edited question, in the rows and on screen. */
describe("editing a question in a workspace chat", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const msg = (n: number, role: "user" | "assistant", partial: Record<string, unknown> = {}) => ({
    id: `${role}-${n}`,
    role,
    content: `${role} ${n}`,
    turn: n,
    isError: false,
    isCancelled: false,
    ...partial,
  });
  const seed = async (messages: Record<string, unknown>[]) => {
    // A fresh session and queue each time: an earlier send leaves its turn "running" in the store.
    const { useChatQueueStore } = await import("./chatQueueStore");
    useChatQueueStore.setState({ items: {}, held: {} });
    useWorkspaceChatStore.setState({ byConversation: {}, editing: {} });
    const store = useWorkspaceChatStore.getState();
    store.prepare(id, "ws-1");
    useWorkspaceChatStore.setState((s) => ({
      byConversation: {
        ...s.byConversation,
        [id]: { ...s.byConversation[id], persisted: true, loaded: true, engineSessionId: "ses-9", contextTokens: 900, messages: messages as never },
      },
    }));
  };
  const three = () => seed([msg(0, "user"), msg(0, "assistant"), msg(1, "user"), msg(1, "assistant"), msg(2, "user"), msg(2, "assistant")]);
  const contents = () => useWorkspaceChatStore.getState().byConversation[id].messages.map((m) => m.content);

  it("cuts at the exchange's own stored message, not at a later one", () => {
    const messages = [msg(0, "user", { id: "pending-user-1" }), msg(0, "assistant", { id: "u1-failed" }), msg(1, "user"), msg(1, "assistant")] as never[];
    expect(wsEditPlan(messages, 0)).toMatchObject({ cutId: null, laterTurns: 1, userOrdinal: 0 });
    expect(wsEditPlan(messages, 2)).toMatchObject({ cutId: "user-1", laterTurns: 0, userOrdinal: 1 });
    expect(wsEditPlan([msg(3, "user", { id: "pending-user-2" }), msg(3, "assistant")] as never[], 0).cutId).toBe("assistant-3");
  });

  it("marks the question and clears the marker on cancel; a running turn refuses", async () => {
    await three();
    const store = useWorkspaceChatStore.getState();
    store.beginEdit(id, 3);
    expect(useWorkspaceChatStore.getState().editing[id]).toBeUndefined();
    store.beginEdit(id, 2);
    expect(useWorkspaceChatStore.getState().editing[id]).toEqual({ index: 2, fromTurn: 2 });
    store.cancelEdit(id);
    expect(useWorkspaceChatStore.getState().editing[id]).toBeUndefined();
    useWorkspaceChatStore.setState((s) => ({ byConversation: { ...s.byConversation, [id]: { ...s.byConversation[id], sending: true } } }));
    store.beginEdit(id, 2);
    expect(useWorkspaceChatStore.getState().editing[id]).toBeUndefined();
  });

  it("confirms once, cuts the rows, forgets the session and asks the edited text", async () => {
    await three();
    const store = useWorkspaceChatStore.getState();
    store.beginEdit(id, 2);
    expect(await store.submitEdit(id, "user 1, better")).toBe(true);
    await flush();
    expect(backend.confirmed).toHaveLength(1);
    expect(backend.calls.find((c) => c.name === "chat_truncate_from")?.args).toEqual({ conversationId: id, messageId: "user-1" });
    const names = backend.calls.map((c) => c.name);
    expect(names.indexOf("chat_truncate_from")).toBeLessThan(names.indexOf("chat_send"));
    expect(contents()).toEqual(["user 0", "assistant 0", "user 1, better"]);
    const session = useWorkspaceChatStore.getState().byConversation[id];
    expect(session.engineSessionId).toBeNull();
    expect(session.contextTokens).toBeNull();
    expect(useWorkspaceChatStore.getState().editing[id]).toBeUndefined();
  });

  it("does not ask when the last question is edited, and sends nothing when declined or refused", async () => {
    await three();
    useWorkspaceChatStore.getState().beginEdit(id, 4);
    expect(await useWorkspaceChatStore.getState().submitEdit(id, "last, again")).toBe(true);
    expect(backend.confirmed).toHaveLength(0);

    await seed([msg(0, "user"), msg(0, "assistant"), msg(1, "user"), msg(1, "assistant")]);
    backend.calls = [];
    backend.confirm = false;
    useWorkspaceChatStore.getState().beginEdit(id, 0);
    expect(await useWorkspaceChatStore.getState().submitEdit(id, "no")).toBe(false);
    expect(backend.calls.some((c) => c.name === "chat_truncate_from")).toBe(false);

    backend.confirm = true;
    backend.truncateFails = "busy::x";
    expect(await useWorkspaceChatStore.getState().submitEdit(id, "no")).toBe(false);
    expect(contents()).toEqual(["user 0", "assistant 0", "user 1", "assistant 1"]);
    expect(useWorkspaceChatStore.getState().editing[id]).toBeDefined();
  });

  it("finds the row by its place among the questions when the bubbles carry no stored id", async () => {
    await seed([
      msg(0, "user"),
      msg(0, "assistant"),
      msg(1, "user", { id: "pending-user-7" }),
      msg(1, "assistant", { id: "pending-user-7-failed", isError: true }),
      msg(2, "user"),
      msg(2, "assistant"),
    ]);
    backend.rows = [
      { id: "r-u0", role: "user" },
      { id: "r-a0", role: "assistant" },
      { id: "r-u1", role: "user" },
      { id: "r-a1", role: "assistant" },
      { id: "r-u2", role: "user" },
      { id: "r-a2", role: "assistant" },
    ];
    useWorkspaceChatStore.getState().beginEdit(id, 2);
    await useWorkspaceChatStore.getState().submitEdit(id, "again");
    expect(backend.calls.find((c) => c.name === "chat_truncate_from")?.args.messageId).toBe("r-u1");
    expect(contents()).toEqual(["user 0", "assistant 0", "again"]);
  });

  it("leaves what is queued behind queued", async () => {
    await three();
    const { enqueueChatMessage } = await import("./chatQueueStore");
    enqueueChatMessage(wsChatQueueKey(id), { text: "later" });
    useWorkspaceChatStore.getState().beginEdit(id, 4);
    await useWorkspaceChatStore.getState().submitEdit(id, "edited");
    await flush();
    expect(backend.calls.filter((c) => c.name === "chat_send").map((c) => c.args.message)).toEqual(["edited"]);
    expect(queuedMessages(wsChatQueueKey(id)).map((q) => q.text)).toEqual(["later"]);
  });
});
