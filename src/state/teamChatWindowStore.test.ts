import { beforeEach, describe, expect, it } from "vitest";
import { showingTeamChat, teamChatOnScreen, useTeamChatWindowStore } from "./teamChatWindowStore";

const windows = () => useTeamChatWindowStore.getState().windows;
const shape = () => windows().map((w) => `${w.teamId}:${w.chatId}:${w.minimized ? "folded" : "open"}${w.unread ? `:${w.unread}` : ""}`);

beforeEach(() => useTeamChatWindowStore.setState({ windows: [], rect: null, maximized: false }));

describe("team chat windows", () => {
  it("keeps one window per team and only one unfolded", () => {
    const { open } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a");
    open("chat-b", "team-b");
    expect(shape()).toEqual(["team-a:chat-a:folded", "team-b:chat-b:open"]);
    // Another conversation of a team turns that team's window to it instead of adding one.
    open("chat-a2", "team-a");
    expect(shape()).toEqual(["team-a:chat-a2:open", "team-b:chat-b:folded"]);
    expect(windows()[0].key).toBe(windows()[0].key);
  });

  it("keeps a window's identity when its conversation changes", () => {
    const { open } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a");
    const key = windows()[0].key;
    open("chat-a2", "team-a");
    expect(windows()[0].key).toBe(key);
  });

  it("folds, unfolds and closes", () => {
    const { open, minimize, restore, close } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a");
    open("chat-b", "team-b");
    const [a, b] = windows();
    minimize(b.key);
    expect(shape()).toEqual(["team-a:chat-a:folded", "team-b:chat-b:folded"]);
    restore(a.key);
    expect(shape()).toEqual(["team-a:chat-a:open", "team-b:chat-b:folded"]);
    close(a.key);
    expect(shape()).toEqual(["team-b:chat-b:folded"]);
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

  it("remembers where the window was left and whether it filled the view", () => {
    const { place, toggleMaximized } = useTeamChatWindowStore.getState();
    place({ x: 10, y: 20, w: 500, h: 400 });
    toggleMaximized();
    expect(useTeamChatWindowStore.getState().rect).toEqual({ x: 10, y: 20, w: 500, h: 400 });
    expect(useTeamChatWindowStore.getState().maximized).toBe(true);
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
    const { open, drop } = useTeamChatWindowStore.getState();
    open("chat-a", "team-a");
    open("chat-b", "team-b");
    drop("chat-a", "chat-a2");
    expect(useTeamChatWindowStore.getState().windows.map((w) => [w.chatId, w.minimized])).toEqual([["chat-a2", true], ["chat-b", false]]);
    drop("chat-b");
    expect(useTeamChatWindowStore.getState().windows.map((w) => w.chatId)).toEqual(["chat-a2"]);
    // One no window shows changes nothing.
    const before = useTeamChatWindowStore.getState().windows;
    drop("unknown");
    expect(useTeamChatWindowStore.getState().windows).toBe(before);
  });

  it("gives each agent a window of its own on the same shelf as the teams'", () => {
    const { open, openAgent } = useTeamChatWindowStore.getState();
    const kinds = () => windows().map((w) => `${w.kind}:${w.teamId}:${w.chatId}:${w.minimized ? "folded" : "open"}`);
    open("chat-a", "team-a");
    openAgent("task-1", "agent-x", "ws");
    expect(kinds()).toEqual(["team:team-a:chat-a:folded", "agent:agent-x:task-1:open"]);
    expect(windows()[1].workspaceId).toBe("ws");
    // Another conversation with the same agent turns its window; another agent gets its own.
    const key = windows()[1].key;
    openAgent("task-2", "agent-x", "ws");
    openAgent("task-3", "agent-y", "ws");
    expect(kinds()).toEqual(["team:team-a:chat-a:folded", "agent:agent-x:task-2:folded", "agent:agent-y:task-3:open"]);
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
    expect(windows().map((w) => `${w.chatId}:${w.minimized}`)).toEqual(["task-1:false", "task-2:true"]);
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
});
