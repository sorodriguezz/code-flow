import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown) => null as unknown) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));

const { acceptFloatAction, showingTeamChat, teamChatOnScreen, useTeamChatWindowStore } = await import("./teamChatWindowStore");

const windows = () => useTeamChatWindowStore.getState().windows;
const shape = () => windows().map((w) => `${w.teamId}:${w.chatId}:${w.minimized ? "folded" : "open"}${w.unread ? `:${w.unread}` : ""}`);
/** What the system was asked for: `command key`. */
const asked = () => api.invoke.mock.calls.map(([command, args]) => `${command} ${(args as { key?: string } | undefined)?.key ?? ""}`.trim()).filter((call) => call.startsWith("float_"));

beforeEach(() => {
  useTeamChatWindowStore.setState({ windows: [] });
  api.invoke.mockClear();
});

describe("team chat windows", () => {
  it("keeps one window per team, each open by itself", () => {
    const { open } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a", { workspaceId: "ws", title: "Equipo A" });
    open("chat-b", "team-b");
    // Opening one does not fold the other: they are windows of their own.
    expect(shape()).toEqual(["team-a:chat-a:open", "team-b:chat-b:open"]);
    // Another conversation of a team turns that team's window to it instead of adding one.
    open("chat-a2", "team-a");
    expect(shape()).toEqual(["team-a:chat-a2:open", "team-b:chat-b:open"]);
    // What it was opened with stays: where it is, and what the system calls it.
    expect(windows()[0]).toMatchObject({ key: "team:team-a", workspaceId: "ws", title: "Equipo A" });
    expect(asked()).toEqual(["float_open team:team-a", "float_open team:team-b", "float_open team:team-a"]);
    // The window is told which conversation to show, with where it is.
    expect(api.invoke.mock.calls[2][1]).toMatchObject({ key: "team:team-a", refId: "team:team-a|chat-a2|ws|team-a", title: "Equipo A", workspaceId: "ws" });
  });

  it("keeps a window's identity when its conversation changes", () => {
    const { open } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a");
    const key = windows()[0].key;
    open("chat-a2", "team-a");
    expect(windows()[0].key).toBe(key);
  });

  it("folds one to its chip by hiding its window, brings it back, and closes it", () => {
    const { open, minimize, restore, close } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a");
    open("chat-b", "team-b");
    const [a, b] = windows();
    api.invoke.mockClear();
    minimize(b.key);
    expect(shape()).toEqual(["team-a:chat-a:open", "team-b:chat-b:folded"]);
    restore(b.key);
    expect(shape()).toEqual(["team-a:chat-a:open", "team-b:chat-b:open"]);
    close(a.key);
    expect(shape()).toEqual(["team-b:chat-b:open"]);
    expect(asked()).toEqual(["float_hide team:team-b", "float_open team:team-b", "float_close team:team-a"]);
  });

  it("lights a folded window when its turn ends, until it is opened", () => {
    const { open, minimize, restore, markUnread } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a");
    const key = windows()[0].key;
    minimize(key);
    markUnread("chat-a", "done");
    markUnread("chat-of-nobody", "error");
    expect(shape()).toEqual(["team-a:chat-a:folded:done"]);
    restore(key);
    expect(shape()).toEqual(["team-a:chat-a:open"]);
  });

  it("counts a conversation as on screen only while something that is drawn shows it", () => {
    const drawn = { isConnected: true, getClientRects: () => [{}] } as unknown as HTMLElement;
    const folded = { isConnected: true, getClientRects: () => [] } as unknown as HTMLElement;
    // No document at all — a test, a worker — is nobody looking.
    expect(teamChatOnScreen("chat-a")).toBe(false);
    const document = { hidden: false };
    Object.assign(globalThis, { document });
    try {
      expect(teamChatOnScreen("chat-a")).toBe(false);
      const leave = showingTeamChat("chat-a", folded);
      expect(teamChatOnScreen("chat-a")).toBe(false);
      const leaveDrawn = showingTeamChat("chat-a", drawn);
      expect(teamChatOnScreen("chat-a")).toBe(true);
      document.hidden = true;
      expect(teamChatOnScreen("chat-a")).toBe(false);
      document.hidden = false;
      leaveDrawn();
      leave();
      expect(teamChatOnScreen("chat-a")).toBe(false);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it("turns the window of a deleted conversation to the next one, or closes it", () => {
    const { open, minimize, drop } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a");
    minimize(windows()[0].key);
    open("chat-b", "team-b");
    api.invoke.mockClear();
    drop("chat-a", "chat-a2");
    expect(useTeamChatWindowStore.getState().windows.map((w) => [w.chatId, w.minimized])).toEqual([["chat-a2", true], ["chat-b", false]]);
    // A folded one stays folded: nothing is brought forward for it.
    expect(asked()).toEqual([]);
    drop("chat-b");
    expect(useTeamChatWindowStore.getState().windows.map((w) => w.chatId)).toEqual(["chat-a2"]);
    expect(asked()).toEqual(["float_close team:team-b"]);
    // One no window shows changes nothing.
    const before = useTeamChatWindowStore.getState().windows;
    drop("unknown");
    expect(useTeamChatWindowStore.getState().windows).toBe(before);
  });

  it("gives each agent a window of its own beside the teams'", () => {
    const { open, openAgent } = useTeamChatWindowStore.getState();
    const kinds = () => windows().map((w) => `${w.kind}:${w.teamId}:${w.chatId}:${w.minimized ? "folded" : "open"}`);
    open("chat-a", "team-a");
    openAgent("task-1", "agent-x", "ws", "Dev");
    expect(kinds()).toEqual(["team:team-a:chat-a:open", "agent:agent-x:task-1:open"]);
    expect(windows()[1]).toMatchObject({ workspaceId: "ws", title: "Dev" });
    // Another conversation with the same agent turns its window; another agent gets its own.
    const key = windows()[1].key;
    openAgent("task-2", "agent-x", "ws");
    openAgent("task-3", "agent-y", "ws");
    expect(kinds()).toEqual(["team:team-a:chat-a:open", "agent:agent-x:task-2:open", "agent:agent-y:task-3:open"]);
    expect(windows()[1].key).toBe(key);
    // A team and an agent never share a window, whatever their ids.
    open("task-3", "agent-y");
    expect(windows().map((w) => w.kind)).toEqual(["team", "agent", "agent", "team"]);
  });

  it("keeps a window per conversation for an agent that is gone", () => {
    const { openAgent } = useTeamChatWindowStore.getState();
    openAgent("task-1", "", "ws");
    openAgent("task-2", "", "ws");
    expect(windows().map((w) => w.chatId)).toEqual(["task-1", "task-2"]);
    openAgent("task-1", "", "ws");
    expect(windows().map((w) => w.key)).toEqual(["agent:task-task-1", "agent:task-task-2"]);
  });

  it("lights and drops an agent's window by its conversation, as a team's", () => {
    const { openAgent, minimize, markUnread, drop } = useTeamChatWindowStore.getState();
    openAgent("task-1", "agent-x", "ws");
    minimize(windows()[0].key);
    markUnread("task-1", "error");
    expect(windows()[0].unread).toBe("error");
    drop("task-1", "task-0");
    expect(windows().map((w) => `${w.kind}:${w.chatId}:${w.unread}`)).toEqual(["agent:task-0:"]);
    drop("task-0");
    expect(windows()).toEqual([]);
  });

  it("does what a floating window, or an island, asks of it", () => {
    acceptFloatAction({ do: "open", kind: "team", chatId: "chat-a", owner: "team-a", workspaceId: "ws", title: "Equipo A" });
    acceptFloatAction({ do: "open", kind: "agent", chatId: "task-1", owner: "agent-x", workspaceId: "ws", title: "Dev" });
    expect(shape()).toEqual(["team-a:chat-a:open", "agent-x:task-1:open"]);
    // The window's own button folds it; its chip brings it back.
    acceptFloatAction({ do: "minimize", key: "team:team-a" });
    expect(shape()).toEqual(["team-a:chat-a:folded", "agent-x:task-1:open"]);
    acceptFloatAction({ do: "restore", key: "team:team-a" });
    acceptFloatAction({ do: "drop", chatId: "task-1" });
    acceptFloatAction({ do: "close", key: "team:team-a" });
    expect(windows()).toEqual([]);
  });
});
