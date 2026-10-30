import { describe, expect, it } from "vitest";
import { activitySearchMatch, searchSnippet } from "./activitySearch";
import { mergeActivityEntries, type ActivityEntry } from "./activityEntries";
import type { Job } from "../state/jobsStore";
import { EMPTY_CHAT } from "../state/chatStore";

const conversation = (): ActivityEntry => mergeActivityEntries([], [{
  session_id: "thread", project_id: "p1", title: "Fix login", created_at: "2026-10-29", updated_at: "2026-10-29", turn_count: 2,
}])[0];

function job(id: string, result: string, meta: Record<string, unknown> = {}): Job {
  return { id, projectId: "p1", kind: "analyze-changes", label: "Analysis", status: "done", createdAt: 0,
    finishedAt: 1, result, error: null, meta };
}

describe("Inbox content search", () => {
  it("finds persisted answers after reopening, scoped to their repository", () => {
    const hit = { conversationId: "thread", projectId: "p1", snippet: "timeout in src/auth.ts" };
    expect(activitySearchMatch(conversation(), "timeout", [hit])).toBe(hit.snippet);
    expect(activitySearchMatch(conversation(), "timeout", [{ ...hit, projectId: "other" }])).toBeNull();
  });

  it("finds messages held in memory before history is refreshed", () => {
    const entry = conversation();
    if (entry.type !== "chat") throw new Error("expected chat");
    entry.live = { ...EMPTY_CHAT, messages: [{ role: "assistant", content: "ECONNREFUSED in src/db.ts" }] };
    expect(activitySearchMatch(entry, "ECONNREFUSED", [])).toContain("src/db.ts");
  });

  it("searches older grouped analysis results and mentioned filenames", () => {
    const entry = mergeActivityEntries([
      job("old", "Found a timeout in src/connection.ts"), job("new", "All done", { file: "migration.sql" }),
    ], [])[0];
    expect(activitySearchMatch(entry, "timeout", [])).toContain("connection.ts");
    expect(activitySearchMatch(entry, "migration.sql", [])).toContain("migration.sql");
  });

  it("keeps title matches and clearing search as ordinary rows", () => {
    expect(activitySearchMatch(conversation(), "LOGIN", [])).toBe("");
    expect(activitySearchMatch(conversation(), "  ", [])).toBe("");
    expect(activitySearchMatch(conversation(), "absent", [])).toBeNull();
  });

  it("matches Unicode and literal search characters in bounded excerpts", () => {
    const text = `${"á".repeat(200)}İ ACCIÓN api_key.ts 100% ${"ñ".repeat(300)}`;
    expect(searchSnippet(text, "acción")).toContain("ACCIÓN");
    expect(searchSnippet(text, "api_key.ts")).toContain("api_key.ts");
    expect(searchSnippet(text, "100%")).toContain("100%");
    expect(Array.from(searchSnippet(text, "acción")!).length).toBeLessThanOrEqual(182);
    expect(searchSnippet(text, "apiXkey.ts")).toBeNull();
  });
});
