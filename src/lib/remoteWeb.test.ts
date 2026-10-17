import { describe, expect, it } from "vitest";
import { commitWebUrl, preferredRemoteUrl, remoteWeb } from "./remoteWeb";

describe("remoteWeb", () => {
  it("reads every common clone URL shape", () => {
    expect(remoteWeb("git@github.com:acme/app.git")).toEqual({ host: "github", base: "https://github.com/acme/app" });
    expect(remoteWeb("https://github.com/acme/app")?.base).toBe("https://github.com/acme/app");
    expect(remoteWeb("ssh://git@gitlab.example.com:2222/group/sub/app.git")).toEqual({
      host: "gitlab",
      base: "https://gitlab.example.com/group/sub/app",
    });
    expect(remoteWeb("https://user@bitbucket.org/team/app.git")?.host).toBe("bitbucket");
    expect(remoteWeb("not a url")).toBeNull();
  });

  it("knows Azure DevOps' three forms", () => {
    expect(remoteWeb("git@ssh.dev.azure.com:v3/org/Proj/repo")?.base).toBe("https://dev.azure.com/org/Proj/_git/repo");
    expect(remoteWeb("https://org@dev.azure.com/org/Proj/_git/repo")?.base).toBe("https://dev.azure.com/org/Proj/_git/repo");
    expect(remoteWeb("https://org.visualstudio.com/Proj/_git/repo")?.base).toBe("https://org.visualstudio.com/Proj/_git/repo");
  });

  it("builds each host's commit page", () => {
    expect(commitWebUrl("git@github.com:acme/app.git", "abc")).toBe("https://github.com/acme/app/commit/abc");
    expect(commitWebUrl("https://gitlab.com/acme/app.git", "abc")).toBe("https://gitlab.com/acme/app/-/commit/abc");
    expect(commitWebUrl("git@bitbucket.org:team/app.git", "abc")).toBe("https://bitbucket.org/team/app/commits/abc");
    expect(preferredRemoteUrl([{ name: "fork", url: "a" }, { name: "origin", url: "b" }])).toBe("b");
    expect(preferredRemoteUrl([])).toBeNull();
  });
});
