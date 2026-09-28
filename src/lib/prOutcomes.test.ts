import { describe, expect, it } from "vitest";
import { parseMergeRefusal, tallyPublish } from "./prOutcomes";
import type { PublishOutcome } from "../types/domain";

describe("parseMergeRefusal", () => {
  it("reads the kind and keeps the host's words", () => {
    expect(parseMergeRefusal("MERGE_BLOCKED::conflicts::Pull Request is not mergeable")).toEqual({
      kind: "conflicts",
      message: "Pull Request is not mergeable",
    });
    // A message with its own "::" stays whole.
    expect(parseMergeRefusal(new Error("MERGE_BLOCKED::checks::ci::build failed"))?.message).toBe("ci::build failed");
  });

  it("reads an unknown kind as 'other' rather than dropping the refusal", () => {
    expect(parseMergeRefusal("MERGE_BLOCKED::weird::no")?.kind).toBe("other");
  });

  it("is not a refusal when the marker isn't there", () => {
    expect(parseMergeRefusal("couldn't reach GitHub: timed out")).toBeNull();
  });
});

describe("tallyPublish", () => {
  const outcome = (items: PublishOutcome["items"], summaryError: string | null = null): PublishOutcome => ({
    items,
    summary_posted: summaryError ? false : null,
    summary_error: summaryError,
  });

  it("counts a partial publish as what it is", () => {
    const tally = tallyPublish(
      outcome([
        { id: "F-001", status: "opened", error: null },
        { id: "F-002", status: "fallback", error: null },
        { id: "F-003", status: "failed", error: "GitHub returned 500" },
        { id: "F-004", status: "replied", error: null },
        { id: "F-005", status: "skipped", error: null },
      ]),
    );
    expect(tally).toMatchObject({ opened: 2, fallback: 1, followedUp: 1, skipped: 1, failed: 1 });
    expect(tally.firstError).toBe("GitHub returned 500");
    expect(tally.landedIds).toEqual(["F-001", "F-002", "F-004"]);
    expect(tally.failedIds).toEqual(["F-003"]);
  });

  /** A reply that landed on a thread the host wouldn't close is on the pull request: landed, with a
   * warning — not a failure that invites posting it again. */
  it("keeps a landed reply's close failure as a warning", () => {
    const tally = tallyPublish(outcome([{ id: "F-001", status: "replied", error: "GitHub GraphQL: forbidden" }]));
    expect(tally.failed).toBe(0);
    expect(tally.warning).toBe("GitHub GraphQL: forbidden");
    expect(tally.landedIds).toEqual(["F-001"]);
  });

  it("counts a summary that failed", () => {
    const tally = tallyPublish(outcome([], "timeout"));
    expect(tally.failed).toBe(1);
    expect(tally.firstError).toBe("timeout");
  });
});
