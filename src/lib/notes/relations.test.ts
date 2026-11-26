import { describe, expect, it } from "vitest";
import { linkCandidates, mergeGraphEdges, pairKey, relationRole, relationSummary, relationWhy } from "./relations";
import { translations, type TranslationKey } from "../i18n/translations";
import type { NoteRelation } from "../../types/notes";

const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  (translations.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ""));

const relation = (patch: Partial<NoteRelation>): NoteRelation => ({
  id: "b", title: "Outbox plan", bookId: "", when: "2026-11-10T10:00:00+00:00", meeting: false, direction: "earlier",
  kind: "related", reason: "", shared: [], resolved: [], pending: [], origin: "auto", ...patch,
});

describe("related notes", () => {
  it("reads a pair from the note being looked at", () => {
    expect(relationRole(relation({ kind: "continues", direction: "earlier" }))).toBe("continuesFrom");
    expect(relationRole(relation({ kind: "continues", direction: "later" }))).toBe("continuedIn");
    // Being before or after only matters when one follows the other.
    expect(relationRole(relation({ kind: "related", direction: "later" }))).toBe("related");
  });

  it("says why in a line: the model's reason, else the words they share", () => {
    expect(relationWhy(relation({ reason: " Follows the outbox. ", shared: ["outbox"] }), t)).toBe("Follows the outbox.");
    expect(relationWhy(relation({ shared: ["outbox", "events"] }), t)).toContain("outbox, events");
    expect(relationWhy(relation({}), t)).toBe("");
  });

  it("puts what was settled and what is open in the summary", () => {
    const text = relationSummary(relation({ kind: "continues", reason: "Follows the outbox.", resolved: ["Table created"], pending: ["Schema name"] }), t);
    expect(text.split("\n")).toHaveLength(4);
    expect(text).toContain("Outbox plan");
    expect(text).toContain("Table created");
    expect(text).toContain("Schema name");
  });

  it("draws a related pair once, and as the link it already is", () => {
    const merged = mergeGraphEdges([["a", "b"]], [["b", "a", "continues"], ["c", "a", "related"], ["c", "c", "related"]]);
    expect(merged.edges).toEqual([["a", "b"], ["c", "a"]]);
    expect([...merged.related]).toEqual([pairKey("a", "c")]);
    expect(mergeGraphEdges([["a", "b"]]).related.size).toBe(0);
  });

  it("offers notes to link by title, without itself or the ones already related", () => {
    const notes = [
      { id: "a", title: "Migración a Postgres", updated_at: "2026-11-01" },
      { id: "b", title: "Outbox", updated_at: "2026-11-03" },
      { id: "c", title: "Postgres: réplicas", updated_at: "2026-11-02" },
    ];
    expect(linkCandidates(notes, "postgres", new Set(["a"])).map((n) => n.id)).toEqual(["c"]);
    expect(linkCandidates(notes, "MIGRACION", new Set()).map((n) => n.id)).toEqual(["a"]);
    // Nothing typed: the most recently touched first.
    expect(linkCandidates(notes, "", new Set(["b"]), 1).map((n) => n.id)).toEqual(["c"]);
  });
});
