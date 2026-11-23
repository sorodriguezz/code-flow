import { describe, expect, it } from "vitest";
import {
  displayRemote,
  repositoryIncluded,
  toggleRepository,
  type BackupInclude,
} from "./backupCommands";

const all: BackupInclude = {
  credentials: true,
  apiClient: true,
  databases: true,
  remote: true,
  authored: true,
  notes: true,
  diagrams: true,
  docVersions: true,
  vault: true,
  requestHistory: true,
  conversations: true,
  reviews: true,
  agentWork: true,
  cookies: true,
  aiLearning: true,
  repositories: true,
  excludedRepositories: [],
};

describe("repository folder selection", () => {
  it("includes every folder by default, so a new project is backed up too", () => {
    expect(repositoryIncluded(all, "p1")).toBe(true);
    expect(repositoryIncluded({ ...all, repositories: false }, "p1")).toBe(false);
  });

  it("leaves one folder out and brings it back", () => {
    const ids = ["p1", "p2"];
    const without = toggleRepository(all, "p1", false, ids);
    expect(without.excludedRepositories).toEqual(["p1"]);
    expect(repositoryIncluded(without, "p1")).toBe(false);
    expect(repositoryIncluded(without, "p2")).toBe(true);
    expect(toggleRepository(without, "p1", true, ids).excludedRepositories).toEqual([]);
  });

  it("ticking one folder while the section is off turns it on with only that folder", () => {
    const off = { ...all, repositories: false };
    const one = toggleRepository(off, "p2", true, ["p1", "p2", "p3"]);
    expect(one.repositories).toBe(true);
    expect(one.excludedRepositories).toEqual(["p1", "p3"]);
    expect(toggleRepository(off, "p2", false, ["p1", "p2"])).toBe(off);
  });

  it("drops ids of projects that no longer exist", () => {
    const stale = { ...all, excludedRepositories: ["gone", "p1"] };
    expect(toggleRepository(stale, "p2", false, ["p1", "p2"]).excludedRepositories).toEqual(["p1", "p2"]);
  });

  it("reads a selection saved before the per-folder choice existed", () => {
    const legacy = { ...all } as Partial<BackupInclude>;
    delete legacy.excludedRepositories;
    expect(repositoryIncluded(legacy as BackupInclude, "p1")).toBe(true);
  });
});

describe("displayRemote", () => {
  it("hides credentials written into a remote URL", () => {
    expect(displayRemote("https://user:token@github.com/team/repo.git")).toBe("https://github.com/team/repo.git");
    expect(displayRemote("git@github.com:team/repo.git")).toBe("git@github.com:team/repo.git");
  });
});
