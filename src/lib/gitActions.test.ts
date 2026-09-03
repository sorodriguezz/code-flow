import { describe, expect, it } from "vitest";
import { matchesCommit } from "./gitActions";
import type { CommitInfo } from "../types/domain";

function commit(over: Partial<CommitInfo> = {}): CommitInfo {
  return {
    id: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    summary: "fix: login redirect loop",
    author_name: "Sofía Ruiz",
    author_email: "sofia@example.com",
    timestamp: 0,
    parent_ids: [],
    refs: [],
    ...over,
  } as CommitInfo;
}

describe("matchesCommit", () => {
  it("matches everything on an empty query", () => {
    expect(matchesCommit(commit(), "")).toBe(true);
    expect(matchesCommit(commit(), "   ")).toBe(true);
  });

  it("matches the message, case-insensitively", () => {
    expect(matchesCommit(commit(), "LOGIN")).toBe(true);
    expect(matchesCommit(commit(), "logout")).toBe(false);
  });

  it("ignores accents in both directions", () => {
    expect(matchesCommit(commit(), "sofia")).toBe(true);
    expect(matchesCommit(commit({ author_name: "Sofia Ruiz" }), "sofía")).toBe(true);
  });

  it("matches the author's email", () => {
    expect(matchesCommit(commit(), "example.com")).toBe(true);
  });

  it("matches a hash prefix but not a fragment from the middle", () => {
    expect(matchesCommit(commit(), "a1b2")).toBe(true);
    // The tell that hashes are prefix-only: this substring is in the id, four characters in.
    expect(matchesCommit(commit(), "c3d4")).toBe(false);
  });

  it("treats several words as all-of-these, in any order", () => {
    expect(matchesCommit(commit(), "sofia login")).toBe(true);
    expect(matchesCommit(commit(), "login sofia")).toBe(true);
    expect(matchesCommit(commit(), "sofia logout")).toBe(false);
  });
});
