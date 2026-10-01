import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityLogEntry } from "../types/domain";

/**
 * The assistant's chat resumes the engine's session instead of replaying the transcript, and a
 * session belongs to one account — so the turn where the account changed is where the engine lost
 * everything above it. That used to be a toast, gone in seconds; now it is a line in the transcript,
 * and it has to be there however the conversation reached the screen: live, reopened, or synced.
 */

let stored: ActivityLogEntry[] = [];
/** What `chat_context_resets` answers — where the stored `/clear`s fall. */
let resets: { turns: number[]; pending: boolean } = { turns: [], pending: false };

/**
 * Every `send_chat_message` is parked until a test settles it — "a turn is running" is then a state
 * the queue tests hold open as long as they need. Lists answer `[]`, anything else `null`.
 */
const backend = vi.hoisted(() => ({
  sends: [] as { args: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }[],
  asked: [] as string[],
  /** Conversations a `/clear` was written down for. */
  cleared: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "get_chat_conversation") return stored;
    if (name === "chat_context_resets") return resets;
    if (name === "reset_chat_context") {
      backend.cleared.push(String(args.sessionId));
      return null;
    }
    if (name === "send_chat_message") {
      backend.asked.push(String(args.message));
      return new Promise((resolve, reject) => backend.sends.push({ args, resolve, reject }));
    }
    return /(^|_)list(_|$)/.test(name) ? [] : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
// A landed turn raises a notification, and for an assistant target that notification lazily imports
// `lib/aiPanelNav` to mark the tab unread — a module graph that, pulled in mid-test, can reach a
// module of the cycle before it has finished initialising ("Cannot access … before
// initialization"), as an unhandled rejection after the test that caused it has passed. The app
// has all of it loaded long before; the queue tests below have no use for notifications at all.
vi.mock("./notificationStore", () => ({ notify: () => {} }));

const { turnsToMessages, useChatStore } = await import("./chatStore");
const { chatQueueKey, queueHold, queuedMessages, useChatQueueStore } = await import("./chatQueueStore");

function turn(n: number, partial: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return {
    id: `t${n}`,
    project_id: "p-1",
    session_id: "conv-1",
    engine_session_id: `ses-${n}`,
    question: `question ${n}`,
    answer: `answer ${n}`,
    trace: null,
    created_at: `2026-09-24T10:0${n}:00Z`,
    response_time_ms: 1000,
    is_error: false,
    provider: "claude",
    model: null,
    engine_version: null,
    account_id: "acct-work",
    ...partial,
  };
}

/** The questions that carry the line, by their text. */
function breaks(entries: ActivityLogEntry[]): string[] {
  return turnsToMessages(entries).flatMap((m) => (m.accountBreak ? [m.content] : []));
}

beforeEach(() => {
  stored = [];
  resets = { turns: [], pending: false };
  useChatStore.setState({ byConversation: {} });
});

describe("turnsToMessages", () => {
  it("draws the line above the first question another account answered", () => {
    const messages = turnsToMessages([turn(1), turn(2, { account_id: "acct-home" }), turn(3, { account_id: "acct-home" })]);
    expect(messages.filter((m) => m.accountBreak).map((m) => m.content)).toEqual(["question 2"]);
    expect(messages[2].accountBreak).toEqual({ provider: "claude", accountId: "acct-home" });
  });

  it("counts the CLI's own account as an account", () => {
    expect(breaks([turn(1, { account_id: null }), turn(2)])).toEqual(["question 2"]);
    expect(breaks([turn(1), turn(2, { account_id: null })])).toEqual(["question 2"]);
  });

  it("draws nothing when there was no session to lose", () => {
    expect(breaks([turn(1, { engine_session_id: null }), turn(2, { account_id: "acct-home" })])).toEqual([]);
  });

  it("leaves a change of provider alone — the backend does not report it as an account change", () => {
    expect(breaks([turn(1), turn(2, { provider: "codex", account_id: "acct-home" })])).toEqual([]);
  });

  it("draws nothing for a failed turn, as the live reply never could, and compares with it after", () => {
    const entries = [turn(1), turn(2, { account_id: "acct-home", is_error: true }), turn(3, { account_id: "acct-home" })];
    expect(breaks(entries)).toEqual([]);
  });

  it("skips turns recorded before the engine was", () => {
    expect(breaks([turn(1), turn(2, { provider: null, account_id: null }), turn(3, { account_id: "acct-home" })])).toEqual([
      "question 3",
    ]);
  });
});

describe("the line survives the ways a conversation reaches the screen", () => {
  it("reopened from disk", async () => {
    stored = [turn(1), turn(2, { account_id: "acct-home" })];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    const messages = useChatStore.getState().byConversation["conv-1"].messages;
    expect(messages.filter((m) => m.accountBreak).map((m) => m.content)).toEqual(["question 2"]);
  });

  it("synced from another device, judged against a turn this window already held", async () => {
    stored = [turn(1)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    stored = [turn(1), turn(2, { account_id: "acct-home" })];
    await useChatStore.getState().reconcile("p-1", "conv-1");
    const messages = useChatStore.getState().byConversation["conv-1"].messages;
    expect(messages.map((m) => m.content)).toEqual(["question 1", "answer 1", "question 2", "answer 2"]);
    expect(messages[2].accountBreak).toEqual({ provider: "claude", accountId: "acct-home" });
  });
});

/**
 * The panel's half of the queue the two chats share (`chatQueueStore`): the same rules as the chat
 * workspace's, driven by this store's own turns — which go through the repository wait first, so
 * these also prove the two waits do not get in each other's way.
 */
describe("messages sent while a turn runs", () => {
  const KEY = chatQueueKey("panel", "conv-1");
  const queued = (key = KEY) => queuedMessages(key).map((item) => item.text);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function answer(conversationId: string) {
    const at = backend.sends.findIndex((s) => s.args.conversationId === conversationId);
    const [turn] = backend.sends.splice(at, 1);
    turn.resolve({
      text: "ok",
      session_id: "ses-1",
      model: null,
      provider: "claude",
      engine_version: null,
      created_at: `2026-09-30T10:00:0${backend.asked.length}Z`,
      response_time_ms: 10,
    });
  }
  function fail(conversationId: string, error: string) {
    const at = backend.sends.findIndex((s) => s.args.conversationId === conversationId);
    const [turn] = backend.sends.splice(at, 1);
    turn.reject(error);
  }

  beforeEach(() => {
    backend.sends.length = 0;
    backend.asked.length = 0;
    useChatQueueStore.setState({ items: {}, held: {} });
  });

  it("sends at once when the conversation is free", () => {
    useChatStore.getState().submit("p-1", "conv-1", "hola");
    expect(backend.asked).toEqual(["hola"]);
    expect(queued()).toEqual([]);
  });

  it("queues what is sent during a turn and sends it, in order, as each answer lands", async () => {
    const store = useChatStore.getState();
    store.submit("p-1", "conv-1", "one");
    store.submit("p-1", "conv-1", "two");
    store.submit("p-1", "conv-1", "three");
    expect(backend.asked).toEqual(["one"]);
    expect(queued()).toEqual(["two", "three"]);

    answer("conv-1");
    await flush();
    expect(backend.asked).toEqual(["one", "two"]);
    answer("conv-1");
    await flush();
    expect(backend.asked).toEqual(["one", "two", "three"]);
    expect(queued()).toEqual([]);
  });

  it("holds the queue when the turn fails, and when it is stopped", async () => {
    const store = useChatStore.getState();
    store.submit("p-1", "conv-1", "one");
    store.submit("p-1", "conv-1", "two");
    fail("conv-1", "boom");
    await flush();
    expect(backend.asked).toEqual(["one"]);
    expect(queueHold(KEY)).toBe("error");

    useChatStore.getState().resumeQueue("conv-1");
    expect(backend.asked).toEqual(["one", "two"]);
    store.submit("p-1", "conv-1", "three");
    fail("conv-1", "RUN_CANCELLED::");
    await flush();
    expect(backend.asked).toEqual(["one", "two"]);
    expect(queued()).toEqual(["three"]);
    expect(queueHold(KEY)).toBe("stopped");
  });

  it("keeps each conversation's queue to itself", async () => {
    const store = useChatStore.getState();
    store.submit("p-1", "conv-1", "one");
    store.submit("p-1", "conv-2", "elsewhere");
    store.submit("p-1", "conv-1", "two");
    answer("conv-2");
    await flush();
    expect(backend.asked).toEqual(["one", "elsewhere"]);
    expect(queued()).toEqual(["two"]);
    answer("conv-1");
    await flush();
    expect(backend.asked).toEqual(["one", "elsewhere", "two"]);
  });

  it("applies a `/clear` written during a turn after it, so only what follows starts fresh", async () => {
    const store = useChatStore.getState();
    store.submit("p-1", "conv-1", "one");
    store.submit("p-1", "conv-1", "two");
    store.submit("p-1", "conv-1", "/clear", { command: { id: "clear", args: "" } });
    store.submit("p-1", "conv-1", "three");

    answer("conv-1");
    await flush();
    // "two" was asked before the `/clear`, so it resumes the session "one" left.
    expect(backend.sends[0].args.sessionId).toBe("ses-1");
    answer("conv-1");
    await flush();
    expect(backend.asked).toEqual(["one", "two", "three"]);
    expect(backend.sends[0].args.sessionId).toBeNull();
    const questions = useChatStore.getState().byConversation["conv-1"].messages.filter((m) => m.role === "user");
    expect(questions.map((m) => [m.content, m.contextReset ?? false])).toEqual([
      ["one", false],
      ["two", false],
      ["three", true],
    ]);
  });
});

describe("a /clear is kept on disk", () => {
  it("draws its line where it fell, reopened", () => {
    const messages = turnsToMessages([turn(1), turn(2), turn(3)], [2]);
    expect(messages.filter((m) => m.contextReset).map((m) => m.content)).toEqual(["question 3"]);
  });

  it("is still waiting after a restart, and the composer says so", async () => {
    stored = [turn(1), turn(2)];
    resets = { turns: [1], pending: true };
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    const session = useChatStore.getState().byConversation["conv-1"];
    expect(session.resetPending).toBe(true);
    expect(session.messages.filter((m) => m.contextReset).map((m) => m.content)).toEqual(["question 2"]);
  });

  it("is written down when typed, and only for a conversation that has something stored", async () => {
    stored = [turn(1)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    backend.cleared.length = 0;
    useChatStore.getState().clearContext("conv-1");
    expect(useChatStore.getState().byConversation["conv-1"].resetPending).toBe(true);
    await Promise.resolve();
    expect(backend.cleared).toEqual(["conv-1"]);
  });

  it("follows another window: a clear typed there, and the turn that used it up", async () => {
    stored = [turn(1)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    resets = { turns: [], pending: true };
    await useChatStore.getState().reconcile("p-1", "conv-1");
    expect(useChatStore.getState().byConversation["conv-1"].resetPending).toBe(true);

    stored = [turn(1), turn(2)];
    resets = { turns: [1], pending: false };
    await useChatStore.getState().reconcile("p-1", "conv-1");
    const session = useChatStore.getState().byConversation["conv-1"];
    expect(session.resetPending).toBe(false);
    expect(session.messages.filter((m) => m.contextReset).map((m) => m.content)).toEqual(["question 2"]);
  });
});
