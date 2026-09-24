import { describe, expect, it } from "vitest";
import { mergeActivityEntries } from "./activityEntries";
import type { Job } from "../state/jobsStore";

/**
 * The Inbox can list a whole workspace, so rows group per repository: two repositories' "#42" are
 * two pull requests, and each repository's analyses are its own row.
 */

function job(partial: Partial<Job> & Pick<Job, "id" | "projectId" | "kind">): Job {
  return {
    label: partial.id,
    status: "done",
    createdAt: 0,
    finishedAt: 0,
    result: "",
    error: null,
    meta: {},
    ...partial,
  };
}

describe("mergeActivityEntries", () => {
  it("keeps the same PR number of two repositories apart", () => {
    const entries = mergeActivityEntries(
      [
        job({ id: "a1", projectId: "web", kind: "pr-review", meta: { prId: 42 }, createdAt: 3 }),
        job({ id: "a2", projectId: "web", kind: "pr-review", meta: { prId: 42 }, createdAt: 2 }),
        job({ id: "b1", projectId: "api", kind: "pr-review", meta: { prId: 42 }, createdAt: 1 }),
      ],
      [],
    );
    const rows = entries.flatMap((e) => (e.type === "job" ? [e.runs.map((r) => r.id)] : []));
    expect(rows).toEqual([["a1", "a2"], ["b1"]]);
  });

  it("gives each repository its own analysis row", () => {
    const entries = mergeActivityEntries(
      [
        job({ id: "w1", projectId: "web", kind: "analyze-changes", createdAt: 2 }),
        job({ id: "p1", projectId: "api", kind: "analyze-changes", createdAt: 1 }),
      ],
      [],
    );
    expect(entries).toHaveLength(2);
  });
});
