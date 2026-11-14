import { describe, expect, it } from "vitest";
import { engineName, hueOf, initials, interleave } from "./sharedChat";
import type { CollabMessage } from "./tauri/collabCommands";

const other = (seq: number, at: string): CollabMessage => ({
  seq,
  id: `m${seq}`,
  personId: "b",
  kind: "user",
  body: { nick: "Dev B", text: `t${seq}` },
  createdAt: at,
});

describe("interleave", () => {
  it("slots the others' turns between own messages by time", () => {
    const own = [
      { id: "a1", createdAt: "2026-11-13T10:00:00Z" },
      { id: "a2", createdAt: "2026-11-13T10:05:00Z" },
    ];
    const rows = interleave(own, [other(2, "2026-11-13T10:03:00Z"), other(1, "2026-11-13T09:59:00Z"), other(3, "2026-11-13T10:09:00Z")]);
    expect(rows.map((r) => (r.kind === "own" ? r.message.id : `o${r.message.seq}`))).toEqual(["o1", "a1", "o2", "a2", "o3"]);
  });

  it("treats an own message without a time as now", () => {
    const now = Date.parse("2026-11-13T10:10:00Z");
    const own: { id: string; createdAt?: string }[] = [{ id: "pending" }];
    const rows = interleave(own, [other(1, "2026-11-13T10:00:00Z"), other(2, "2026-11-13T10:20:00Z")], now);
    expect(rows.map((r) => (r.kind === "own" ? "own" : r.message.seq))).toEqual([1, "own", 2]);
  });

  it("keeps the own index so actions can be found", () => {
    const rows = interleave([{ id: "x", createdAt: "2026-11-13T10:00:00Z" }], []);
    expect(rows).toEqual([{ kind: "own", message: { id: "x", createdAt: "2026-11-13T10:00:00Z" }, index: 0 }]);
  });
});

describe("names and marks", () => {
  it("says engines the way people do", () => {
    expect(engineName("codex")).toBe("Codex");
    expect(engineName("CLAUDE")).toBe("Claude");
    expect(engineName("mistral")).toBe("Mistral");
    expect(engineName("")).toBe("su agente");
  });

  it("makes initials and a stable hue", () => {
    expect(initials("Dev B")).toBe("DB");
    expect(initials("sebas")).toBe("SE");
    expect(initials("  ")).toBe("?");
    expect(hueOf("p1")).toBe(hueOf("p1"));
    expect(hueOf("p1")).toBeGreaterThanOrEqual(0);
  });
});
