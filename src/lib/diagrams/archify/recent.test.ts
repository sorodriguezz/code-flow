import { describe, expect, it } from "vitest";
import { recentTopics, rememberTopic } from "./recent";

function fake() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe("recent topics", () => {
  it("keeps the latest first, once each, per repository and type", () => {
    const store = fake();
    rememberTopic("p1", "sequence", "POST /orders", store);
    rememberTopic("p1", "sequence", "GET /users", store);
    rememberTopic("p1", "sequence", "POST /orders", store);
    rememberTopic("p1", "lifecycle", "OrderStatus", store);
    rememberTopic("p2", "sequence", "POST /elsewhere", store);
    expect(recentTopics("p1", "sequence", store)).toEqual(["POST /orders", "GET /users"]);
    expect(recentTopics("p1", "lifecycle", store)).toEqual(["OrderStatus"]);
    expect(recentTopics("p2", "sequence", store)).toEqual(["POST /elsewhere"]);
    expect(recentTopics("p3", "sequence", store)).toEqual([]);
  });

  it("keeps five, and never an empty subject", () => {
    const store = fake();
    for (let n = 1; n <= 8; n++) rememberTopic("p", "workflow", `process ${n}`, store);
    rememberTopic("p", "workflow", "   ", store);
    expect(recentTopics("p", "workflow", store)).toEqual(["process 8", "process 7", "process 6", "process 5", "process 4"]);
  });

  it("survives a store that is missing, broken or full", () => {
    expect(recentTopics("p", "sequence", null)).toEqual([]);
    expect(() => rememberTopic("p", "sequence", "x", null)).not.toThrow();
    const broken = { getItem: () => "{not json", setItem: () => {} };
    expect(recentTopics("p", "sequence", broken)).toEqual([]);
    const full = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(() => rememberTopic("p", "sequence", "x", full)).not.toThrow();
  });
});
