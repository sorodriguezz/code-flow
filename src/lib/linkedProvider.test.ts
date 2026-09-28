import { describe, expect, it, vi } from "vitest";
import { linkedHost, linkedProvider } from "./linkedProvider";
import type { Project } from "../types/domain";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { isLinkedHostConnected, pipelinesAvailable } = await import("../state/vcsConnectionsStore");

/**
 * The frontend's copy of `linked_repo`'s precedence. If it disagreed with the Rust, the Pipelines
 * tab would offer one host while its requests went to another — so the order, and each provider's
 * rule for what counts as linked, is pinned here the way `a_bitbucket_link_ranks_after_gitlab_and_
 * before_azure` pins it on the other side.
 */

function project(columns: Partial<Project>): Project {
  return {
    id: "p",
    workspace_id: "w",
    name: "example-repo",
    local_path: "/tmp/example-repo",
    remote_url: null,
    color: "#fff",
    icon: "folder",
    ado_org: null,
    ado_project: null,
    ado_repo_id: null,
    github_owner: null,
    github_repo: null,
    github_host: null,
    gitlab_project: null,
    gitlab_host: null,
    sort_order: 0,
    created_at: "",
    bitbucket_workspace: null,
    bitbucket_repo: null,
    ...columns,
  };
}

const bitbucket = { bitbucket_workspace: "example-workspace", bitbucket_repo: "example-repo" };
const azure = { ado_org: "example-org", ado_project: "p", ado_repo_id: "r" };

describe("linkedProvider", () => {
  it("ranks Bitbucket after GitHub and GitLab and before Azure", () => {
    expect(linkedProvider(project(bitbucket))).toBe("bitbucket");
    expect(linkedProvider(project({ ...bitbucket, ...azure }))).toBe("bitbucket");
    expect(linkedProvider(project({ ...bitbucket, gitlab_project: "group/app" }))).toBe("gitlab");
    expect(linkedProvider(project({ ...bitbucket, github_owner: "o", github_repo: "r" }))).toBe("github");
  });

  it("needs both halves of a Bitbucket link", () => {
    expect(linkedProvider(project({ bitbucket_workspace: "example-workspace" }))).toBeNull();
    expect(linkedProvider(project({ bitbucket_workspace: "example-workspace", bitbucket_repo: "  " }))).toBeNull();
    expect(linkedProvider(project({ bitbucket_workspace: " ", bitbucket_repo: "example-repo", ...azure }))).toBe("azure");
  });

  it("names the workspace as the Bitbucket host a connection is for", () => {
    expect(linkedHost(project(bitbucket))).toBe("example-workspace");
  });
});

describe("the Pipelines gate", () => {
  const connections = { ado: [], github: [], gitlab: [], bitbucket: ["Example-Workspace"], loaded: true };

  it("opens for a Bitbucket repository whose workspace is connected, whatever the case", () => {
    expect(isLinkedHostConnected(project(bitbucket), connections)).toBe(true);
    expect(pipelinesAvailable(project(bitbucket), connections)).toBe(true);
    expect(
      pipelinesAvailable(project({ bitbucket_workspace: "other-workspace", bitbucket_repo: "x" }), connections),
    ).toBe(false);
    expect(pipelinesAvailable(project(bitbucket), { ...connections, loaded: false })).toBe(false);
  });
});
