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
  /** `app_settings`, as `get_setting`/`set_setting` see it. */
  settings: {} as Record<string, string>,
  /** What `chat_failed_turn_changes` answers. */
  failed: null as unknown,
  /** The row ids `truncate_chat_from` was asked to cut from; `truncateFails` makes it refuse. */
  truncated: [] as string[],
  truncateFails: null as string | null,
  /** What the confirmation dialog answers, and the messages it was shown. */
  confirm: true,
  confirmed: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "get_chat_conversation") return stored;
    if (name === "chat_context_resets") return resets;
    if (name === "reset_chat_context") {
      backend.cleared.push(String(args.sessionId));
      return null;
    }
    if (name === "chat_failed_turn_changes") return backend.failed;
    if (name === "truncate_chat_from") {
      if (backend.truncateFails) throw backend.truncateFails;
      backend.truncated.push(String(args.rowId));
      return 1;
    }
    if (name === "get_setting") return backend.settings[String(args.key)] ?? null;
    if (name === "set_setting") {
      backend.settings[String(args.key)] = String(args.value);
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
vi.mock("./confirmStore", () => ({
  confirmAction: async (message: string) => {
    backend.confirmed.push(message);
    return backend.confirm;
  },
}));

const { editPlan, turnsToMessages, useChatStore } = await import("./chatStore");
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

describe("turnsToMessages usage", () => {
  it("restores a turn's usage from the row and ignores bad JSON", () => {
    const usage = { input_tokens: 5, output_tokens: 6, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.01 };
    const out = turnsToMessages([turn(1, { usage: JSON.stringify(usage) }), turn(2, { usage: "{bad" }), turn(3)]);
    const answers = out.filter((m) => m.role === "assistant");
    expect(answers.map((m) => m.usage)).toEqual([usage, undefined, undefined]);
  });
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

describe("reopening a conversation this window already holds", () => {
  it("keeps what only memory has — stopped turns, the plan flag, the meter — and still takes new rows", async () => {
    stored = [turn(1)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    useChatStore.setState((s) => {
      const session = s.byConversation["conv-1"];
      return {
        byConversation: {
          ...s.byConversation,
          "conv-1": {
            ...session,
            contextTokens: 4200,
            messages: [
              ...session.messages,
              { role: "user", content: "stopped question", plan: true },
              { role: "assistant", content: "", isCancelled: true, plan: true },
            ],
          },
        },
      };
    });

    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    let session = useChatStore.getState().byConversation["conv-1"];
    expect(session.messages.map((m) => m.content)).toEqual(["question 1", "answer 1", "stopped question", ""]);
    expect(session.messages[3].isCancelled).toBe(true);
    expect(session.messages[2].plan).toBe(true);
    expect(session.contextTokens).toBe(4200);

    // A turn sent from another device still shows up on reopening.
    stored = [turn(1), turn(2)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    session = useChatStore.getState().byConversation["conv-1"];
    expect(session.messages.map((m) => m.content)).toEqual(["question 1", "answer 1", "stopped question", "", "question 2", "answer 2"]);
  });
});

describe("per-conversation picks survive a restart", () => {
  it("restores engine, account, effort and plan from settings, and forgets them with the conversation", async () => {
    vi.useFakeTimers();
    try {
      backend.settings = {};
      vi.resetModules();
      const first = await import("./chatStore");
      first.useChatStore.getState().setEngine("conv-1", { provider: "claude", model: "opus", account: "acct-work" });
      first.useChatStore.getState().setEffort("conv-1", "high");
      first.useChatStore.getState().setPlan("conv-1", true);
      await vi.advanceTimersByTimeAsync(1000);
      const saved = JSON.parse(backend.settings["ai_panel_conversation_prefs"]);
      expect(saved["conv-1"]).toEqual({ engine: { provider: "claude", model: "opus", account: "acct-work" }, effort: "high", plan: true });

      // A new process: nothing in memory, the blob on disk.
      vi.resetModules();
      const second = await import("./chatStore");
      await second.loadConversationPrefs();
      const state = second.useChatStore.getState();
      expect(state.engineByConversation["conv-1"]).toEqual({ provider: "claude", model: "opus", account: "acct-work" });
      expect(state.effortByConversation["conv-1"]).toBe("high");
      expect(state.planByConversation["conv-1"]).toBe(true);

      second.useChatStore.getState().discard("conv-1");
      expect(second.useChatStore.getState().planByConversation["conv-1"]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(JSON.parse(backend.settings["ai_panel_conversation_prefs"])).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a stopped turn that changed files", () => {
  const cancelledRow = (n: number) =>
    turn(n, { is_error: true, answer: "RUN_CANCELLED::", checkpoint: JSON.stringify({ id: "cp-1", paths: ["a.ts"] }) });

  it("reads back from disk as a stopped bubble with its review, not as an error", async () => {
    stored = [turn(1), cancelledRow(2)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    const last = useChatStore.getState().byConversation["conv-1"].messages[3];
    expect(last.isCancelled).toBe(true);
    expect(last.isError).toBeUndefined();
    expect(last.content).toBe("");
    expect(last.changes).toEqual({ checkpointId: "cp-1", paths: ["a.ts"] });
  });

  it("is not drawn twice when its row turns up next to the live bubble", async () => {
    stored = [turn(1)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    // The live bubble, filed when the stop landed, stamped with the local clock.
    useChatStore.setState((s) => {
      const session = s.byConversation["conv-1"];
      return {
        byConversation: {
          ...s.byConversation,
          "conv-1": {
            ...session,
            messages: [
              ...session.messages,
              { role: "user", content: "question 2" },
              { role: "assistant", content: "", isCancelled: true, createdAt: "2026-09-24T10:02:07Z" },
            ],
          },
        },
      };
    });
    stored = [turn(1), cancelledRow(2)];
    await useChatStore.getState().reconcile("p-1", "conv-1");
    const messages = useChatStore.getState().byConversation["conv-1"].messages;
    expect(messages).toHaveLength(4);
    expect(messages[3].rowId).toBe("t2");
    expect(messages[3].changes?.checkpointId).toBe("cp-1");
    await useChatStore.getState().reconcile("p-1", "conv-1");
    expect(useChatStore.getState().byConversation["conv-1"].messages).toHaveLength(4);
  });
});

/**
 * «Editar y reenviar»: sending an edited question replaces the thread from it on. The rows are cut
 * first, then the session — memory, engine token and all — so the next turn is handed no session
 * (`send_chat_message` then replays the surviving rows) and the later turns are gone from the screen.
 */
describe("editing a question replaces the thread from it", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const load = async () => {
    stored = [turn(1), turn(2), turn(3)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
  };

  beforeEach(() => {
    backend.sends.length = 0;
    backend.asked.length = 0;
    backend.truncated.length = 0;
    backend.truncateFails = null;
    backend.confirm = true;
    backend.confirmed.length = 0;
    useChatStore.setState({ byConversation: {}, editing: {} });
    useChatQueueStore.setState({ items: {}, held: {} });
  });

  it("plans the cut from the transcript: the first stored row at or after the question", () => {
    const messages = turnsToMessages([turn(1), turn(2), turn(3)]);
    expect(editPlan(messages, 2)).toMatchObject({ laterTurns: 1, cutRowId: "t2" });
    expect(editPlan(messages, 4)).toMatchObject({ laterTurns: 0, cutRowId: "t3" });
    // A stopped turn is never stored: the cut falls on the next stored turn.
    const stopped = [...messages.slice(0, 2), { role: "user" as const, content: "q" }, { role: "assistant" as const, content: "", isCancelled: true }, ...messages.slice(2)];
    expect(editPlan(stopped, 2).cutRowId).toBe("t2");
    expect(editPlan(stopped, 2).laterTurns).toBe(2);
    expect(editPlan(stopped.slice(0, 4), 2).cutRowId).toBeNull();
  });

  it("marks the question, and cancelling clears the marker", async () => {
    await load();
    const store = useChatStore.getState();
    store.beginEdit("conv-1", 2);
    expect(useChatStore.getState().editing["conv-1"]).toEqual({ index: 2, fromTurn: 2 });
    // Only a question can be edited.
    store.beginEdit("conv-1", 1);
    expect(useChatStore.getState().editing["conv-1"]).toEqual({ index: 2, fromTurn: 2 });
    store.cancelEdit("conv-1");
    expect(useChatStore.getState().editing["conv-1"]).toBeUndefined();
  });

  it("confirms once, cuts the rows, drops the later turns and the session, then asks", async () => {
    await load();
    expect(useChatStore.getState().byConversation["conv-1"].sessionId).toBe("ses-3");
    useChatStore.getState().beginEdit("conv-1", 2);
    expect(await useChatStore.getState().submitEdit("p-1", "conv-1", "question 2, better")).toBe(true);

    expect(backend.confirmed).toHaveLength(1);
    expect(backend.truncated).toEqual(["t2"]);
    expect(useChatStore.getState().editing["conv-1"]).toBeUndefined();
    const session = useChatStore.getState().byConversation["conv-1"];
    expect(session.messages.map((m) => m.content)).toEqual(["question 1", "answer 1", "question 2, better"]);
    expect(session.sending).toBe(true);
    // No session handed on: the backend replays the surviving turns instead of resuming one that
    // still holds the removed ones.
    expect(backend.sends[0].args.sessionId).toBeNull();
    expect(backend.asked).toEqual(["question 2, better"]);
  });

  it("asks nothing when the last question is edited, and sends nothing when the user declines", async () => {
    await load();
    useChatStore.getState().beginEdit("conv-1", 4);
    expect(await useChatStore.getState().submitEdit("p-1", "conv-1", "again")).toBe(true);
    expect(backend.confirmed).toHaveLength(0);
    expect(backend.truncated).toEqual(["t3"]);

    backend.sends.length = 0;
    backend.asked.length = 0;
    backend.truncated.length = 0;
    useChatStore.setState({ byConversation: {}, editing: {} });
    useChatQueueStore.setState({ items: {}, held: {} });
    await load();
    backend.confirm = false;
    useChatStore.getState().beginEdit("conv-1", 2);
    expect(await useChatStore.getState().submitEdit("p-1", "conv-1", "no")).toBe(false);
    expect(backend.truncated).toEqual([]);
    expect(useChatStore.getState().byConversation["conv-1"].messages).toHaveLength(6);
    expect(useChatStore.getState().editing["conv-1"]).toBeDefined();
  });

  it("keeps the transcript and the marker when the cut is refused", async () => {
    await load();
    backend.truncateFails = "busy::conv-1";
    useChatStore.getState().beginEdit("conv-1", 2);
    expect(await useChatStore.getState().submitEdit("p-1", "conv-1", "x")).toBe(false);
    expect(useChatStore.getState().byConversation["conv-1"].messages).toHaveLength(6);
    expect(useChatStore.getState().editing["conv-1"]).toBeDefined();
    expect(backend.asked).toEqual([]);
  });

  it("cuts a stopped turn out of memory without touching disk, bubbles cancelled or failed included", async () => {
    stored = [turn(1)];
    await useChatStore.getState().ensureLoaded("p-1", "conv-1");
    useChatStore.setState((s) => ({
      byConversation: {
        ...s.byConversation,
        "conv-1": {
          ...s.byConversation["conv-1"],
          messages: [
            ...s.byConversation["conv-1"].messages,
            { role: "user", content: "stopped one" },
            { role: "assistant", content: "", isCancelled: true },
            { role: "user", content: "failed one" },
            { role: "assistant", content: "boom", isError: true },
          ],
        },
      },
    }));
    useChatStore.getState().beginEdit("conv-1", 2);
    await useChatStore.getState().submitEdit("p-1", "conv-1", "stopped one, reworded");
    expect(backend.truncated).toEqual([]);
    expect(useChatStore.getState().byConversation["conv-1"].messages.map((m) => m.content)).toEqual([
      "question 1",
      "answer 1",
      "stopped one, reworded",
    ]);
  });

  it("is an ordinary send without a marker, and leaves what is queued behind it queued", async () => {
    await load();
    expect(await useChatStore.getState().submitEdit("p-1", "conv-1", "plain")).toBe(true);
    expect(backend.truncated).toEqual([]);
    expect(useChatStore.getState().byConversation["conv-1"].messages.at(-1)?.content).toBe("plain");

    // Queued messages stay queued while the replacement runs.
    backend.sends.length = 0;
    backend.asked.length = 0;
    useChatStore.setState({ byConversation: {}, editing: {} });
    await load();
    useChatQueueStore.setState({ items: { [chatQueueKey("panel", "conv-1")]: [{ id: "q1", text: "later" }] } as never, held: {} });
    useChatStore.getState().beginEdit("conv-1", 2);
    await useChatStore.getState().submitEdit("p-1", "conv-1", "edited");
    await flush();
    expect(backend.asked).toEqual(["edited"]);
    expect(queuedMessages(chatQueueKey("panel", "conv-1")).map((q) => q.text)).toEqual(["later"]);
  });

  it("is not undone by a sync that read the disk before the cut", async () => {
    await load();
    useChatStore.getState().beginEdit("conv-1", 2);
    const sync = useChatStore.getState().reconcile("p-1", "conv-1");
    await useChatStore.getState().submitEdit("p-1", "conv-1", "edited");
    await sync;
    expect(useChatStore.getState().byConversation["conv-1"].messages.map((m) => m.content)).toEqual([
      "question 1",
      "answer 1",
      "edited",
    ]);
  });
});
