import { describe, expect, it } from "vitest";
import {
  entryPr,
  entryTitle,
  isWorkspaceChat,
  mergeActivityEntries,
  WORKSPACE_CHAT_PROJECT,
} from "./activityEntries";
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

/**
 * A chat of the workspace itself carries no repository, and that absence is what the Inbox reads to
 * tell it apart from a repository's chat — it used to be listed nowhere at all, so a conversation
 * somebody spent a day in left no trace in the panel that is meant to be the history of everything.
 */
describe("a workspace chat among the entries", () => {
  const conv = {
    session_id: "ws-1",
    project_id: WORKSPACE_CHAT_PROJECT,
    title: "Arquitectura del motor",
    created_at: "2026-10-19T09:00:00Z",
    updated_at: "2026-10-19T18:50:00Z",
    turn_count: 0,
  };

  it("is recognised by the absence of a repository", () => {
    const [entry] = mergeActivityEntries([], [conv]);
    expect(isWorkspaceChat(entry)).toBe(true);
    expect(entryTitle(entry)).toBe("Arquitectura del motor");
  });

  it("is not a repository chat", () => {
    const [entry] = mergeActivityEntries([], [{ ...conv, project_id: "p1" }]);
    expect(isWorkspaceChat(entry)).toBe(false);
  });

  it("sorts among the rest by when it was last touched", () => {
    const older = { ...conv, session_id: "p-1", project_id: "p1", updated_at: "2026-10-19T10:00:00Z" };
    const entries = mergeActivityEntries([], [older, conv]);
    expect(entries.map((entry) => (entry.type === "chat" ? entry.conv.session_id : ""))).toEqual(["ws-1", "p-1"]);
  });
});

describe("a PR row's parts", () => {
  const meta = { prId: 94025, prTitle: "fix(planificacion): avisa de traslados", repoLabel: "Org/Transporte.Web" };
  const review = job({ id: "r", projectId: "p", kind: "pr-review", label: "#94025 Org/Transporte.Web · fix(planificacion): avisa de traslados", meta });

  it("splits the number, a plain title, the repository and the review", () => {
    expect(entryPr({ type: "job", job: review, runs: [review] })).toEqual({
      id: "94025",
      title: "Avisa de traslados",
      repo: "Org/Transporte.Web",
      state: "reviewed",
    });
  });

  it("reads the newest decision, and keeps a name the user gave the row", () => {
    const approve = job({ id: "a", projectId: "p", kind: "pr-action", label: "#94025 x · Aprobado", meta: { ...meta, action: "approve" } });
    expect(entryPr({ type: "job", job: approve, runs: [approve, review] })?.state).toBe("approved");
    const renamed = { ...review, label: "Revisión del aviso" };
    expect(entryPr({ type: "job", job: renamed, runs: [renamed] })?.title).toBe("Revisión del aviso");
  });

  it("is nothing for a row that is not a PR", () => {
    const analysis = job({ id: "x", projectId: "p", kind: "analyze-changes" });
    expect(entryPr({ type: "job", job: analysis, runs: [analysis] })).toBeNull();
  });
});
