import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Traces are read one turn at a time, when their disclosure is opened: a light transcript marks the
 * turns that have one, and `loadTurnTrace` fetches each once, shared and cached.
 */

let calls: string[] = [];
let stored: Record<string, string | null> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    if (name !== "get_turn_trace") return null;
    calls.push(String(args.id));
    return stored[String(args.id)] ?? null;
  },
}));

const { clearTurnTraceCache, loadTurnTrace, peekTurnTrace, traceIdOf } = await import("./turnTrace");

const raw = (lines: string[]) => JSON.stringify(lines.map((line) => ({ stream: "stdout", line })));

beforeEach(() => {
  calls = [];
  stored = {};
  clearTurnTraceCache();
});

describe("traceIdOf", () => {
  it("names a turn whose trace exists but was not sent, and nothing else", () => {
    expect(traceIdOf("", "row-1")).toBe("row-1");
    expect(traceIdOf(null, "row-1")).toBeUndefined();
    expect(traceIdOf(raw(["whole"]), "row-1")).toBeUndefined();
    expect(traceIdOf("", "")).toBeUndefined();
  });
});

describe("loadTurnTrace", () => {
  it("fetches a trace once and serves it from the cache after", async () => {
    stored["row-1"] = raw(["Read src/app.ts", "Edit src/app.ts"]);
    const [a, b] = await Promise.all([loadTurnTrace("row-1"), loadTurnTrace("row-1")]);
    expect(a?.map((line) => line.text)).toEqual(["Read src/app.ts", "Edit src/app.ts"]);
    expect(b).toBe(a);
    expect(await loadTurnTrace("row-1")).toBe(a);
    expect(calls).toEqual(["row-1"]);
    expect(peekTurnTrace("row-1")).toBe(a);
  });

  it("remembers a turn with nothing printable as null, not as unknown", async () => {
    stored["row-2"] = raw(['{"type":"result","result":"ok"}']);
    expect(await loadTurnTrace("row-2")).toBeNull();
    expect(peekTurnTrace("row-2")).toBeNull();
    expect(peekTurnTrace("never-asked")).toBeUndefined();
  });

  it("keeps only the most recent traces", async () => {
    for (let i = 0; i < 30; i++) {
      stored[`row-${i}`] = raw([`line ${i}`]);
      await loadTurnTrace(`row-${i}`);
    }
    expect(peekTurnTrace("row-0")).toBeUndefined();
    expect(peekTurnTrace("row-29")?.[0].text).toBe("line 29");
  });
});
