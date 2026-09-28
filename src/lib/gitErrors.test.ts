import { describe, expect, it } from "vitest";
import {
  describeGitError,
  GIT_ERROR,
  isValidRemoteName,
  looksLikeGitUrl,
  remoteFailure,
  stoppedOperation,
  tagTail,
  type Translate,
} from "./gitErrors";

/** Echoes the key and its params, so an assertion names the sentence rather than its wording. */
const t: Translate = (key, params) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

describe("describeGitError", () => {
  it("keeps the refusals the store already translated", () => {
    expect(describeGitError("BRANCH_LOCKED: main", t)).toBe("branch.lockedBlocked(name=main)");
    expect(describeGitError("NO_UPSTREAM: feature/x", t)).toBe("branch.noUpstream(name=feature/x)");
    expect(describeGitError("HUNK_STALE: src/a.ts", t)).toBe("peek.stale");
  });

  it("says which files a merge would overwrite, and falls back when none were named", () => {
    expect(describeGitError("MERGE_BLOCKED: a.txt, my notes.md", t)).toBe(
      "gitError.mergeBlockedFiles(files=a.txt, my notes.md)",
    );
    expect(describeGitError("MERGE_BLOCKED: 1.txt, 2.txt, 3.txt, 4.txt", t)).toBe(
      "gitError.mergeBlockedFiles(files=1.txt, 2.txt, 3.txt…)",
    );
    expect(describeGitError("MERGE_BLOCKED: ", t)).toBe("gitError.mergeBlocked");
  });

  it("names the operation that is in the way or that stopped", () => {
    expect(describeGitError("OPERATION_IN_PROGRESS: cherry_pick", t)).toBe(
      "gitError.inProgress(operation=operation.cherry_pick)",
    );
    expect(describeGitError("OPERATION_CONFLICTS: rebase", t)).toBe(
      "conflicts.stoppedToast(operation=operation.rebase)",
    );
  });

  it("turns each classified remote failure into its own sentence", () => {
    const raw = "GIT_REMOTE: ssh_key\ngit fetch failed: git@example.com: Permission denied (publickey).";
    expect(describeGitError(raw, t)).toBe("gitError.remote.ssh_key");
    expect(describeGitError("GIT_REMOTE: network\ngit pull failed: Could not resolve host", t)).toBe(
      "gitError.remote.network",
    );
  });

  it("maps the store-level refusals", () => {
    expect(describeGitError("MERGE_STAGED: a.txt", t)).toBe("gitError.mergeStaged");
    expect(describeGitError("UNRESOLVED_CONFLICTS: resolve the conflicts first", t)).toBe("gitError.unresolved");
    expect(describeGitError("IDENTITY_MISSING: config value 'user.name' was not found", t)).toBe(
      "gitError.identityMissing",
    );
    expect(describeGitError("NO_REMOTE: this repository has no remote", t)).toBe("gitError.noRemote");
  });

  it("shows git's own text when nothing is recognised, without a leftover tag", () => {
    expect(describeGitError("git push failed: remote: hook declined", t)).toBe("git push failed: remote: hook declined");
    expect(describeGitError("CHECKOUT_CONFLICT: 1 conflict prevents checkout", t)).toBe(
      "1 conflict prevents checkout",
    );
    expect(describeGitError("PULL_DIVERGED: git pull failed: fatal: Need to specify", t)).toBe(
      "git pull failed: fatal: Need to specify",
    );
    // An unknown code is not a sentence of ours to pick.
    expect(describeGitError("GIT_REMOTE: something_new\ngit fetch failed: boom", t)).toBe(
      "something_new\ngit fetch failed: boom",
    );
  });
});

describe("tag readers", () => {
  it("read the tail up to the end of its line", () => {
    expect(tagTail("GIT_REMOTE: timeout\ngit fetch failed", GIT_ERROR.remoteFailure)).toBe("timeout");
    expect(tagTail("plain error", GIT_ERROR.remoteFailure)).toBeNull();
    expect(remoteFailure("GIT_REMOTE: auth_required\n…")).toBe("auth_required");
    expect(remoteFailure("GIT_REMOTE: made_up\n…")).toBeNull();
  });

  it("know an operation that stopped on conflicts from an ordinary failure", () => {
    expect(stoppedOperation("OPERATION_CONFLICTS: revert")).toBe("revert");
    expect(stoppedOperation("OPERATION_CONFLICTS: bisect")).toBeNull();
    expect(stoppedOperation("git pull failed: boom")).toBeNull();
  });
});

describe("remote form checks", () => {
  it("accept the URL shapes git takes and refuse obvious non-URLs", () => {
    for (const url of [
      "https://example.com/owner/repo.git",
      "ssh://git@example.com:22/owner/repo.git",
      "git@example.com:owner/repo.git",
      "/srv/git/repo.git",
      "../sibling.git",
    ]) {
      expect(looksLikeGitUrl(url), url).toBe(true);
    }
    for (const url of ["", "   ", "not a url", "example.com/owner repo"]) {
      expect(looksLikeGitUrl(url), url).toBe(false);
    }
  });

  it("accept remote names git would", () => {
    expect(isValidRemoteName("origin")).toBe(true);
    expect(isValidRemoteName("my-fork_2.backup")).toBe(true);
    expect(isValidRemoteName("my remote")).toBe(false);
    expect(isValidRemoteName("-dash")).toBe(false);
    expect(isValidRemoteName("a..b")).toBe(false);
    expect(isValidRemoteName("x.lock")).toBe(false);
  });
});

describe("the newer git features' refusals", () => {
  it("each have their sentence", () => {
    expect(describeGitError("LINES_STALE: a.txt", t)).toBe("lines.stale");
    expect(describeGitError("LINES_UNSUPPORTED: lfs", t)).toBe("lines.unsupported");
    expect(describeGitError("HOOK_FAILED: lint failed", t)).toBe("commitOutput.hookTitle");
    expect(describeGitError("COMMIT_FAILED: error: gpg failed to sign the data", t)).toBe("commitOutput.commitTitle");
    expect(describeGitError("UNDO_STALE: HEAD moved", t)).toBe("undo.stale");
    expect(describeGitError("WORKTREE_DIRTY: /w/x", t)).toBe("worktrees.dirty");
    expect(describeGitError("BISECT_ACTIVE: bisect", t)).toBe("bisect.activeBlocks");
    expect(describeGitError("CONFLICT_GONE: a.txt", t)).toBe("conflictEditor.gone");
  });

  it("keeps a hook's whole output after its tag", async () => {
    const { tagBody } = await import("./gitErrors");
    expect(tagBody("HOOK_FAILED: line one\nline two", GIT_ERROR.hookFailed)).toBe("line one\nline two");
    expect(tagBody("something else", GIT_ERROR.hookFailed)).toBeNull();
  });
});
