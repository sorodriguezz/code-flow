import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Remote workspace's session handling, against a fake backend.
 *
 * What these hold down: a workspace switch keeps shells running and brings them back (it used to
 * kill a long build because somebody glanced at another workspace); a shell whose workspace is
 * deleted is ended rather than left running with nothing to reach it; Reconnect keeps the tab and
 * only drops the old pty once the new one exists; a saved password is only typed past a "this is
 * not a password prompt" refusal when the user says so; and a first connection to an unknown host
 * opens the trust dialog on the machine `ssh` named.
 */

const calls: { name: string; args: Record<string, unknown> }[] = [];
let answers: Record<string, (args: Record<string, unknown>) => unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (answer) {
      try {
        return Promise.resolve(answer(args));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    switch (name) {
      case "remote_load_tree":
        return Promise.resolve({ hosts: [], groups: [], snippets: [] });
      case "remote_list_forwards":
      case "remote_host_holds":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { useRemoteStore, offerHostKeyTrust } = await import("./remoteStore");
const { useHostKeyStore } = await import("./hostKeyStore");
const { useConfirmStore } = await import("./confirmStore");
const { useWorkspaceStore } = await import("./workspaceStore");
const { HOST_KEY_UNKNOWN } = await import("../lib/hostKey");
const { NOT_ASKING } = await import("../lib/remote/transfers");

const HOST = {
  id: "h1",
  workspace_id: "w1",
  name: "web-01",
  group_name: "",
  spec: JSON.stringify({ host: "web-01.example.com", port: 2222, user: "deploy", auth: "password" }),
  color: "",
  sort_order: 0,
  created_at: "",
  updated_at: "",
};

const session = (id: string, workspaceId: string, sessionId = `pty-${id}`) => ({
  id,
  kind: "session" as const,
  hostId: "h1",
  name: "web-01",
  sessionId,
  exited: false,
  workspaceId,
});

const named = (name: string) => calls.filter((call) => call.name === name);

beforeEach(() => {
  calls.length = 0;
  answers = {};
  useHostKeyStore.getState().close();
  useRemoteStore.setState({
    workspaceId: "w1",
    loading: false,
    hosts: [HOST],
    tabs: [],
    background: [],
    activeTabId: null,
    connectionEpoch: {},
    holds: {},
  });
});

describe("switching workspace", () => {
  it("keeps the shells running and brings them back on return", async () => {
    useRemoteStore.setState({ tabs: [session("t1", "w1")], activeTabId: "t1" });

    await useRemoteStore.getState().setWorkspace("w2");
    expect(named("close_terminal")).toEqual([]);
    expect(useRemoteStore.getState().tabs).toEqual([]);
    expect(useRemoteStore.getState().background.map((tab) => tab.id)).toEqual(["t1"]);

    await useRemoteStore.getState().setWorkspace("w1");
    expect(useRemoteStore.getState().tabs.map((tab) => tab.id)).toEqual(["t1"]);
    expect(useRemoteStore.getState().activeTabId).toBe("t1");
    expect(useRemoteStore.getState().background).toEqual([]);
    expect(named("close_terminal")).toEqual([]);
  });

  it("marks a kept shell as ended when it ends while nobody is looking", () => {
    useRemoteStore.setState({ background: [session("t1", "w2")] });
    useRemoteStore.getState().markExited("pty-t1");
    expect(useRemoteStore.getState().background[0].exited).toBe(true);
  });

  it("ends the kept shells of a workspace that was deleted", () => {
    useRemoteStore.setState({ background: [session("t1", "w2"), session("t2", "w3")] });
    useWorkspaceStore.setState({ workspaces: [{ id: "w1" }, { id: "w3" }] as never });
    expect(named("close_terminal").map((call) => call.args.id)).toEqual(["pty-t1"]);
    expect(useRemoteStore.getState().background.map((tab) => tab.id)).toEqual(["t2"]);
  });
});

describe("reconnect", () => {
  it("opens a new shell in the same tab, and only then lets the old pty go", async () => {
    useRemoteStore.setState({ tabs: [{ ...session("t1", "w1"), exited: true }], activeTabId: "t1" });
    answers.remote_open_session = () => "pty-new";

    await useRemoteStore.getState().reconnect("t1");
    const [tab] = useRemoteStore.getState().tabs;
    expect(tab).toMatchObject({ id: "t1", sessionId: "pty-new", exited: false });
    const order = calls.map((call) => call.name);
    expect(order.indexOf("remote_open_session")).toBeLessThan(order.indexOf("close_terminal"));
  });

  it("leaves the tab as it was when the new session cannot open", async () => {
    useRemoteStore.setState({ tabs: [{ ...session("t1", "w1"), exited: true }], activeTabId: "t1" });
    answers.remote_open_session = () => {
      throw "host down";
    };
    await useRemoteStore.getState().reconnect("t1");
    expect(useRemoteStore.getState().tabs[0]).toMatchObject({ sessionId: "pty-t1", exited: true });
    expect(named("close_terminal")).toEqual([]);
  });
});

describe("typing the saved password", () => {
  it("asks before typing into something that is not a password prompt, and forces only on yes", async () => {
    useRemoteStore.setState({ tabs: [session("t1", "w1")], activeTabId: "t1" });
    answers.remote_type_password = (args) => {
      if (!args.force) throw NOT_ASKING;
      return null;
    };

    const typing = useRemoteStore.getState().typePassword("t1");
    await vi.waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
    useConfirmStore.getState().respond(true);
    await typing;

    expect(named("remote_type_password").map((call) => call.args.force)).toEqual([false, true]);
    expect(named("remote_type_password")[0].args).toMatchObject({ hostId: "h1", sessionId: "pty-t1" });
  });

  it("types nothing when the user says no", async () => {
    useRemoteStore.setState({ tabs: [session("t1", "w1")], activeTabId: "t1" });
    answers.remote_type_password = () => {
      throw NOT_ASKING;
    };
    const typing = useRemoteStore.getState().typePassword("t1");
    await vi.waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
    useConfirmStore.getState().respond(false);
    await typing;
    expect(named("remote_type_password")).toHaveLength(1);
  });
});

describe("saving a host", () => {
  it("tells open browsers to list again only when the edit changed how the host is reached", async () => {
    answers.remote_update_host = () => false;
    await useRemoteStore.getState().saveHost(HOST, JSON.parse(HOST.spec));
    expect(useRemoteStore.getState().connectionEpoch.h1).toBeUndefined();

    answers.remote_update_host = () => true;
    await useRemoteStore.getState().saveHost(HOST, JSON.parse(HOST.spec));
    expect(useRemoteStore.getState().connectionEpoch.h1).toBe(1);
  });
});

describe("an unknown host key", () => {
  const unknown = (named: string) => `${HOST_KEY_UNKNOWN}: ${named} isn't in your known_hosts file.`;

  it("opens the trust dialog on the machine ssh named, and retries once it is trusted", () => {
    const retry = vi.fn();
    expect(offerHostKeyTrust(unknown("[web-01.example.com]:2222"), "h1", retry)).toBe(true);
    expect(useHostKeyStore.getState().target).toEqual({ host: "web-01.example.com", port: 2222, user: "deploy" });
    useHostKeyStore.getState().onTrusted?.();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("asks about a screen's tunnel as ~/.ssh/config reaches the host, not with the screen's port and user", () => {
    expect(offerHostKeyTrust(`${HOST_KEY_UNKNOWN}: isn't named`, "h1", () => {}, true)).toBe(true);
    expect(useHostKeyStore.getState().target).toEqual({ host: "web-01.example.com", port: 0, user: "" });
  });

  it("offers nothing for any other failure", () => {
    expect(offerHostKeyTrust("Permission denied (publickey).", "h1", () => {})).toBe(false);
    expect(useHostKeyStore.getState().target).toBeNull();
  });
});
