import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Bitbucket connection list and the two helpers around it. The list is what auto-linking and
 * the Pipelines tab read to know a workspace is connected, so a row that parses wrong is a
 * repository that silently never links.
 */

let saved: string | null = null;
const calls: { name: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    if (name === "get_setting") return Promise.resolve(saved);
    if (name === "set_setting") {
      saved = String(args.value);
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { bitbucketTokenPageUrl, loadBitbucketConnections, normalizeBitbucketWorkspace, saveBitbucketConnections } =
  await import("./bitbucketConnections");
const { useVcsConnectionsStore } = await import("../state/vcsConnectionsStore");

beforeEach(() => {
  saved = null;
  calls.length = 0;
});

describe("normalizeBitbucketWorkspace", () => {
  it("takes a slug, or the workspace out of any Bitbucket URL, in lower case", () => {
    expect(normalizeBitbucketWorkspace("example-workspace")).toBe("example-workspace");
    expect(normalizeBitbucketWorkspace("  Example-Workspace  ")).toBe("example-workspace");
    expect(normalizeBitbucketWorkspace("https://bitbucket.org/example-workspace/example-repo/src/main")).toBe(
      "example-workspace",
    );
    expect(normalizeBitbucketWorkspace("bitbucket.org/Example-Workspace/")).toBe("example-workspace");
    expect(normalizeBitbucketWorkspace("https://someone@bitbucket.org/example-workspace/example-repo.git")).toBe(
      "example-workspace",
    );
    expect(normalizeBitbucketWorkspace("/example-workspace/")).toBe("example-workspace");
    expect(normalizeBitbucketWorkspace("   ")).toBe("");
  });
});

describe("bitbucketTokenPageUrl", () => {
  it("sends an API token to Atlassian and an access token to the workspace's settings", () => {
    expect(bitbucketTokenPageUrl("api_token", "anything")).toBe("https://id.atlassian.com/manage-profile/security/api-tokens");
    expect(bitbucketTokenPageUrl("access_token", "Example-Workspace")).toBe(
      "https://bitbucket.org/example-workspace/workspace/settings/access-tokens",
    );
    expect(bitbucketTokenPageUrl("access_token", "")).toBe("https://bitbucket.org");
  });
});

describe("the connection list", () => {
  it("reads what was saved and drops what isn't a connection", async () => {
    saved = JSON.stringify([
      { workspace: "example-workspace", kind: "api_token", email: "dev@example.test", user: "Ana Example" },
      { workspace: "other-workspace", kind: "access_token", email: null, user: "" },
      { workspace: "", kind: "api_token" },
      { host: "not-a-workspace" },
      null,
      { workspace: "legacy-row" },
    ]);
    expect(await loadBitbucketConnections()).toEqual([
      { workspace: "example-workspace", kind: "api_token", email: "dev@example.test", user: "Ana Example" },
      { workspace: "other-workspace", kind: "access_token", email: null, user: "" },
      // A row with nothing but its workspace still counts; it reads as the default kind.
      { workspace: "legacy-row", kind: "api_token", email: null, user: "" },
    ]);
  });

  it("reads nothing out of a missing or broken setting", async () => {
    expect(await loadBitbucketConnections()).toEqual([]);
    saved = "{not json";
    expect(await loadBitbucketConnections()).toEqual([]);
    saved = JSON.stringify({ workspace: "not-a-list" });
    expect(await loadBitbucketConnections()).toEqual([]);
  });

  it("saves under the key the backend reads, and the Pipelines gate hears about it", async () => {
    await saveBitbucketConnections([{ workspace: "example-workspace", kind: "access_token", email: null, user: "" }]);
    const write = calls.find((call) => call.name === "set_setting");
    expect(write?.args.key).toBe("bitbucket_connections");
    expect(JSON.parse(String(write?.args.value))).toEqual([
      { workspace: "example-workspace", kind: "access_token", email: null, user: "" },
    ]);
    expect(useVcsConnectionsStore.getState().bitbucket).toEqual(["example-workspace"]);
    expect(useVcsConnectionsStore.getState().loaded).toBe(true);
  });
});
