import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opening windows. There is no limit on how many: the machine's memory is the only ceiling, and the
 * status bar shows what each window takes.
 */

const opened: string[] = [];
const openedWorkspaces: (string | null)[] = [];
const toasts: string[] = [];
const FOREIGN_WORKSPACE = "workspace-other";
const FOREIGN_CHAT_REF = "ws:workspace-other:conversation";
const CHAT_WINDOW_KIND = "chat";
const CHAT_TITLE = "Agenda";

vi.mock("../lib/tauri/windows", () => ({
  focusSatellite: async () => {},
  listSatellites: async () => [],
  openSatellite: async (_kind: string, refId: string, _title: string, workspaceId: string | null) => {
    opened.push(refId);
    openedWorkspaces.push(workspaceId);
    return `sat-app-${refId}`;
  },
}));
vi.mock("./toastStore", () => ({ pushErrorToast: (message: string) => toasts.push(message) }));
vi.mock("./workspaceStore", () => ({ useWorkspaceStore: { getState: () => ({ activeWorkspaceId: "ws-1" }) } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { useWindowStore } = await import("./windowStore");

const sat = (label: string, kind: "app" | "repo" | "quick" | "chat" | "float", ref_id: string) => ({ label, kind, ref_id, title: "" });

beforeEach(() => {
  opened.length = 0;
  openedWorkspaces.length = 0;
  toasts.length = 0;
});

describe("opening windows", () => {
  it("opens a workspace chat on its own workspace while the main window stays elsewhere", async () => {
    useWindowStore.setState({ satellites: [] });
    const openedChat = await useWindowStore.getState().detach(CHAT_WINDOW_KIND, FOREIGN_CHAT_REF, CHAT_TITLE);
    expect(openedChat).toBe(true);
    expect(openedWorkspaces).toEqual([FOREIGN_WORKSPACE]);
  });

  it("opens one more however many are already open", async () => {
    useWindowStore.setState({
      satellites: [
        ...Array.from({ length: 12 }, (_, i) => sat(`sat-app-${i}`, "app", `app-${i}`)),
        sat("sat-repo-p1", "repo", "p1"),
        sat("sat-chat-1", "chat", "panel:p1:conv-a"),
        sat("float-call", "float", "call:team-1"),
        sat("sat-quick-ask", "quick", "ask"),
      ],
    });
    expect(await useWindowStore.getState().detach("app", "agents", "Agents")).toBe(true);
    expect(await useWindowStore.getState().detach("repo", "p2", "Backend")).toBe(true);
    expect(opened).toEqual(["agents", "p2"]);
    expect(toasts).toEqual([]);
  });
});
