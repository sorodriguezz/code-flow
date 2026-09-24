import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityLogEntry } from "../types/domain";

/**
 * The assistant's chat resumes the engine's session instead of replaying the transcript, and a
 * session belongs to one account — so the turn where the account changed is where the engine lost
 * everything above it. That used to be a toast, gone in seconds; now it is a line in the transcript,
 * and it has to be there however the conversation reached the screen: live, reopened, or synced.
 */

let stored: ActivityLogEntry[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string) => (name === "get_chat_conversation" ? stored : null),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { turnsToMessages, useChatStore } = await import("./chatStore");

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
