import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SatelliteInfo } from "./tauri/windows";

const FIXTURE = vi.hoisted(() => ({
  workspaceId: "workspace-other",
  conversationId: "conversation-created",
  title: "Agenda",
  label: "satellite-agenda",
  refId: "ws:workspace-other:conversation-created",
  malformedRef: "ws:missing-conversation",
  repositoryRef: "panel:repository:conversation",
  appRef: "notes",
  errorMessage: "Could not create conversation",
  empty: "",
  noCalls: 0,
  oneCall: 1,
}));
const mocks = vi.hoisted(() => ({
  satellites: [] as SatelliteInfo[],
  create: vi.fn(),
  load: vi.fn(),
  open: vi.fn(),
  loadList: vi.fn(),
  detach: vi.fn(),
  focus: vi.fn(),
}));

vi.mock("./tauri/chatCommands", () => ({ chatCreateWorkspaceConversation: mocks.create }));
vi.mock("../state/aiPanelStore", () => ({
  useAiPanelStore: { getState: () => ({ load: mocks.load, open: mocks.open }) },
}));
vi.mock("../state/workspaceChatStore", () => ({
  useWorkspaceChatStore: { getState: () => ({ loadList: mocks.loadList }) },
}));
vi.mock("../state/windowStore", () => ({
  useWindowStore: { getState: () => ({ satellites: mocks.satellites, detach: mocks.detach, focus: mocks.focus }) },
}));

const { openWorkspaceChatIsland, workspaceChatIslands } = await import("./workspaceChatIslands");
const WORKSPACE_CHAT_KIND = "wsChat";
const CHAT_WINDOW_KIND = "chat";
const APP_WINDOW_KIND = "app";
const BACKGROUND_TAB = { focus: false };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.satellites = [];
  mocks.create.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue(undefined);
  mocks.loadList.mockResolvedValue(undefined);
  mocks.detach.mockResolvedValue(true);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(FIXTURE.conversationId as ReturnType<typeof crypto.randomUUID>);
});

describe("workspace chat islands", () => {
  it("persists a new chat before opening its window and keeps its tab in the destination workspace", async () => {
    const opened = await openWorkspaceChatIsland(FIXTURE.workspaceId, FIXTURE.title);
    expect(opened).toBe(true);
    expect(mocks.load).toHaveBeenCalledWith(FIXTURE.workspaceId);
    expect(mocks.create).toHaveBeenCalledWith({
      workspaceId: FIXTURE.workspaceId,
      conversationId: FIXTURE.conversationId,
      provider: FIXTURE.empty,
      model: FIXTURE.empty,
    });
    expect(mocks.open).toHaveBeenCalledWith({
      kind: WORKSPACE_CHAT_KIND,
      workspaceId: FIXTURE.workspaceId,
      conversationId: FIXTURE.conversationId,
    }, BACKGROUND_TAB);
    expect(mocks.loadList).toHaveBeenCalledWith(FIXTURE.workspaceId);
    expect(mocks.detach).toHaveBeenCalledWith(CHAT_WINDOW_KIND, FIXTURE.refId, FIXTURE.title);
    const createdAt = mocks.create.mock.invocationCallOrder[FIXTURE.noCalls];
    const detachedAt = mocks.detach.mock.invocationCallOrder[FIXTURE.noCalls];
    expect(createdAt).toBeLessThan(detachedAt);
  });

  it("focuses an already open chat without creating another conversation", async () => {
    mocks.satellites = [{ kind: CHAT_WINDOW_KIND, ref_id: FIXTURE.refId, label: FIXTURE.label }];
    await openWorkspaceChatIsland(FIXTURE.workspaceId, FIXTURE.title);
    expect(mocks.focus).toHaveBeenCalledWith(FIXTURE.label);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("opens only once when the menu action is requested twice while the window is being prepared", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.load.mockReturnValue(gate);
    const first = openWorkspaceChatIsland(FIXTURE.workspaceId, FIXTURE.title);
    const second = openWorkspaceChatIsland(FIXTURE.workspaceId, FIXTURE.title);
    release?.();
    await Promise.all([first, second]);
    expect(mocks.create).toHaveBeenCalledTimes(FIXTURE.oneCall);
    expect(mocks.detach).toHaveBeenCalledTimes(FIXTURE.oneCall);
  });

  it("does not open a window on a failed save and permits retrying", async () => {
    const failure = new Error(FIXTURE.errorMessage);
    mocks.create.mockRejectedValueOnce(failure);
    const failedOpen = openWorkspaceChatIsland(FIXTURE.workspaceId, FIXTURE.title);
    await expect(failedOpen).rejects.toThrow(FIXTURE.errorMessage);
    expect(mocks.detach).not.toHaveBeenCalled();
    const retriedOpen = await openWorkspaceChatIsland(FIXTURE.workspaceId, FIXTURE.title);
    expect(retriedOpen).toBe(true);
  });

  it("lists workspace chats across workspaces and ignores other windows and invalid references", () => {
    const satellites: SatelliteInfo[] = [
      { kind: CHAT_WINDOW_KIND, ref_id: FIXTURE.refId, label: FIXTURE.label },
      { kind: CHAT_WINDOW_KIND, ref_id: FIXTURE.repositoryRef, label: FIXTURE.repositoryRef },
      { kind: CHAT_WINDOW_KIND, ref_id: FIXTURE.malformedRef, label: FIXTURE.malformedRef },
      { kind: APP_WINDOW_KIND, ref_id: FIXTURE.appRef, label: FIXTURE.appRef },
    ];
    const islands = workspaceChatIslands(satellites);
    expect(islands).toEqual([{
      ...satellites[FIXTURE.noCalls],
      workspaceId: FIXTURE.workspaceId,
      conversationId: FIXTURE.conversationId,
    }]);
  });
});
