import { describe, expect, it, vi } from "vitest";
import { create } from "zustand";

vi.mock("./tauri/chatRefsCommands", () => ({ chatDelegateAccept: vi.fn(), chatDelegateSettle: vi.fn(), onChatDelegate: vi.fn() }));
vi.mock("../state/chatStore", () => ({ useChatStore: { getState: () => ({}) } }));
vi.mock("../state/workspaceChatStore", () => ({ useWorkspaceChatStore: { getState: () => ({}) } }));

import { awaitTurn, holdsConversation } from "./chatDelegate";

describe("holdsConversation", () => {
  const island = { kind: "chat", ref_id: "panel:p1:conv-a" };
  it("an island holds its own conversation and nothing else", () => {
    const me = { main: false, satellite: { kind: "chat", refId: "panel:p1:conv-a" } };
    expect(holdsConversation(me, [island], "conv-a")).toBe(true);
    expect(holdsConversation(me, [island], "conv-b")).toBe(false);
    expect(holdsConversation({ main: false, satellite: { kind: "app", refId: "notes" } }, [], "conv-a")).toBe(false);
  });
  it("main holds every conversation no island does", () => {
    const main = { main: true, satellite: null };
    expect(holdsConversation(main, [island], "conv-a")).toBe(false);
    expect(holdsConversation(main, [island], "conv-b")).toBe(true);
  });
});

describe("awaitTurn", () => {
  type S = { sending: boolean; last: { content: string; isError?: boolean } | null };
  const store = () => create<S>(() => ({ sending: false, last: null }));

  it("resolves with the answer once the turn ran and ended", async () => {
    const s = store();
    const turn = awaitTurn(s.subscribe, (x) => x, s.getState());
    s.setState({ sending: true });
    s.setState({ sending: false, last: { content: "hecho" } });
    await expect(turn).resolves.toBe("hecho");
  });

  it("rejects with the error a failed turn ended on", async () => {
    const s = store();
    const turn = awaitTurn(s.subscribe, (x) => x, s.getState());
    s.setState({ sending: true });
    s.setState({ sending: false, last: { content: "sin cuota", isError: true } });
    await expect(turn).rejects.toThrow("sin cuota");
  });
});
