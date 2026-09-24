import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestSummary } from "../types/domain";

/**
 * The assistant's navigation: one door (`open`), tabs per workspace, and a persistence that can
 * never replace what is on disk with the few tabs opened before it was read.
 *
 * Pinned because every failure here is one the user described as "it bugs out, information gets
 * lost, things overlap": a duplicate tab, a blank chat that multiplies, a restored strip that loses
 * its tabs to the first one opened this session.
 */

let settings: Record<string, string> = {};
let written: Record<string, string> = {};
let releaseReads: (() => void) | null = null;

function pr(id: number, title = `PR ${id}`): PullRequestSummary {
  return {
    id,
    title,
    description: "",
    status: "open",
    source_branch: `feature/${id}`,
    target_branch: "main",
    author: "ana",
    created_at: "2026-09-23T10:00:00Z",
    url: `https://git.example.com/acme/web/pull/${id}`,
    provider: "github",
  };
}

async function boot(opts: { holdReads?: boolean } = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  const gate = opts.holdReads ? new Promise<void>((resolve) => (releaseReads = resolve)) : Promise.resolve();
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: async (name: string, args: { key: string; value?: string }) => {
      if (name === "get_setting") {
        await gate;
        return settings[args.key] ?? null;
      }
      if (name === "set_setting") {
        written[args.key] = args.value ?? "";
        return undefined;
      }
      return null;
    },
  }));
  const workspace = await import("./workspaceStore");
  workspace.useWorkspaceStore.setState({
    activeWorkspaceId: "ws-1",
    activeProjectId: "p-1",
    projectsByWorkspace: {
      "ws-1": [{ id: "p-1", workspace_id: "ws-1", name: "web" } as never],
      "ws-2": [{ id: "p-2", workspace_id: "ws-2", name: "api" } as never],
    },
  });
  const ui = await import("./uiStore");
  const panel = await import("./aiPanelStore");
  return { panel, ui, workspace };
}

beforeEach(() => {
  settings = {};
  written = {};
  releaseReads = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("open", () => {
  it("focuses what is already open instead of duplicating it", async () => {
    const { panel } = await boot();
    const first = panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(42) });
    const second = panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(42, "renamed") });
    const s = panel.useAiPanelStore.getState();
    expect(first).toBe(second);
    expect(s.tabsByWorkspace["ws-1"]).toHaveLength(1);
    expect(s.activeByWorkspace["ws-1"]).toBe(first);
    // The newer snapshot wins: what the caller knows now is fresher than what the tab was opened with.
    const tab = s.tabsByWorkspace["ws-1"][0];
    expect(tab.kind === "pr" && tab.pr.title).toBe("renamed");
  });

  it("keeps one blank chat per repository rather than piling them up", async () => {
    const { panel } = await boot();
    const a = panel.useAiPanelStore.getState().open({ kind: "chat", projectId: "p-1" });
    const b = panel.useAiPanelStore.getState().open({ kind: "chat", projectId: "p-1" });
    expect(a).toBe(b);
    panel.useAiPanelStore.getState().markChatStarted(a);
    const c = panel.useAiPanelStore.getState().open({ kind: "chat", projectId: "p-1" });
    expect(c).not.toBe(a);
    expect(panel.useAiPanelStore.getState().tabsByWorkspace["ws-1"]).toHaveLength(2);
  });

  it("files a tab under its own project's workspace, not the one on screen", async () => {
    const { panel } = await boot();
    const key = panel.useAiPanelStore.getState().open({ kind: "analysis", projectId: "p-2" });
    const s = panel.useAiPanelStore.getState();
    expect(s.tabsByWorkspace["ws-2"]?.map((t) => t.key)).toEqual([key]);
    expect(s.tabsByWorkspace["ws-1"] ?? []).toHaveLength(0);
  });

  it("opens a finding in the document it belongs to", async () => {
    const { panel } = await boot();
    const key = panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(7), finding: "F-003" });
    const view = panel.useAiPanelStore.getState().view[key];
    expect(view.segment).toBe("findings");
    expect(view.expanded?.["F-003"]).toBe(true);
  });

  it("opens the panel when it focuses, and leaves it alone when it does not", async () => {
    const { panel, ui } = await boot();
    ui.useUiStore.setState({ aiPanelOpen: false });
    panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(1) }, { focus: false });
    expect(ui.useUiStore.getState().aiPanelOpen).toBe(false);
    panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(2) });
    expect(ui.useUiStore.getState().aiPanelOpen).toBe(true);
  });
});

describe("close and the tab cap", () => {
  it("lands on the neighbour when the tab on screen closes, and never closes the Inbox", async () => {
    const { panel } = await boot();
    const store = panel.useAiPanelStore.getState();
    const a = store.open({ kind: "pr", projectId: "p-1", pr: pr(1) });
    const b = store.open({ kind: "pr", projectId: "p-1", pr: pr(2) });
    panel.useAiPanelStore.getState().close(b);
    expect(panel.useAiPanelStore.getState().activeByWorkspace["ws-1"]).toBe(a);
    panel.useAiPanelStore.getState().close(a);
    expect(panel.useAiPanelStore.getState().activeByWorkspace["ws-1"]).toBe(panel.INBOX_KEY);
    panel.useAiPanelStore.getState().close(panel.INBOX_KEY);
    expect(panel.useAiPanelStore.getState().activeByWorkspace["ws-1"]).toBe(panel.INBOX_KEY);
  });

  it("drops the least recently used idle tab past the cap, but never one holding a draft", async () => {
    const { panel } = await boot();
    const keys: string[] = [];
    for (let id = 1; id <= panel.MAX_TABS; id++) {
      vi.advanceTimersByTime(10);
      keys.push(panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(id) }));
    }
    // The oldest has unsent text: it must survive; the next oldest goes instead.
    panel.useAiPanelStore.getState().setDraft(keys[0], "half a reply");
    vi.advanceTimersByTime(10);
    panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(99) });
    const open = panel.useAiPanelStore.getState().tabsByWorkspace["ws-1"].map((t) => t.key);
    expect(open).toHaveLength(panel.MAX_TABS);
    expect(open).toContain(keys[0]);
    expect(open).not.toContain(keys[1]);
  });
});

describe("unread", () => {
  it("is not filed for the tab on screen, and clears when its tab is opened", async () => {
    const { panel, ui } = await boot();
    ui.useUiStore.setState({ aiPanelOpen: true });
    const shown = panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(1) });
    panel.useAiPanelStore.getState().markUnread(shown, { status: "success", workspaceId: "ws-1" });
    expect(panel.useAiPanelStore.getState().unread[shown]).toBeUndefined();

    const elsewhere = panel.chatTabKey("conv-x");
    panel.useAiPanelStore.getState().markUnread(elsewhere, { status: "error", workspaceId: "ws-1" });
    expect(panel.useAiPanelStore.getState().unread[elsewhere]?.status).toBe("error");
    panel.useAiPanelStore.getState().open({ kind: "chat", projectId: "p-1", conversationId: "conv-x" });
    expect(panel.useAiPanelStore.getState().unread[elsewhere]).toBeUndefined();
  });
});

describe("persistence", () => {
  it("merges the saved tabs under the ones opened before the read landed, and writes both", async () => {
    settings["ai_panel_ws-1"] = JSON.stringify({
      tabs: [
        { kind: "pr", key: "pr:p-1:5", projectId: "p-1", prId: 5, pr: pr(5) },
        { kind: "analysis", key: "analysis:p-1", projectId: "p-1", jobId: null },
      ],
      active: "analysis:p-1",
      unread: {},
    });
    const { panel } = await boot({ holdReads: true });
    // Opened while the disk read is still pending — the moment the old stores lost their lists.
    const fresh = panel.useAiPanelStore.getState().open({ kind: "pr", projectId: "p-1", pr: pr(8) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(written["ai_panel_ws-1"]).toBeUndefined();

    releaseReads?.();
    await vi.advanceTimersByTimeAsync(1000);
    const saved = JSON.parse(written["ai_panel_ws-1"]) as { tabs: { key: string }[]; active: string };
    expect(saved.tabs.map((t) => t.key)).toEqual(["pr:p-1:5", "analysis:p-1", fresh]);
    // What was opened this session is what is on screen.
    expect(saved.active).toBe(fresh);
  });

  it("does not bring back a blank chat nobody wrote in", async () => {
    const { panel } = await boot();
    const blank = panel.useAiPanelStore.getState().open({ kind: "chat", projectId: "p-1" });
    await vi.advanceTimersByTimeAsync(1000);
    const saved = JSON.parse(written["ai_panel_ws-1"]) as { tabs: { key: string }[] };
    expect(saved.tabs.map((t) => t.key)).not.toContain(blank);
  });
});
