import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.fn();
const setSetting = vi.fn();
vi.mock("./tauri/commands", () => ({
  getSetting: (k: string) => getSetting(k),
  setSetting: (k: string, v: string) => setSetting(k, v),
}));

import {
  lastOpenedNow,
  mergeLastOpened,
  parseLastOpened,
  recordProjectOpened,
  resetLastOpenedForTests,
  sortByLastOpened,
} from "./projectLastOpened";

const rows = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("sortByLastOpened", () => {
  it("puts the most recent first and keeps sidebar order for never-opened ones", () => {
    expect(sortByLastOpened(rows, { c: 5, b: 9 }).map((r) => r.id)).toEqual(["b", "c", "a", "d"]);
  });
  it("sends the current repository last", () => {
    expect(sortByLastOpened(rows, { c: 5, b: 9 }, "b").map((r) => r.id)).toEqual(["c", "a", "d", "b"]);
  });
});

describe("parse and merge", () => {
  it("survives garbage", () => {
    expect(parseLastOpened("nope")).toEqual({});
    expect(parseLastOpened("[1]")).toEqual({});
    expect(parseLastOpened('{"a":3,"b":"x","c":-1}')).toEqual({ a: 3 });
  });
  it("keeps the newer stamp and caps to the most recent", () => {
    expect(mergeLastOpened({ a: 5, b: 1 }, { a: 2, c: 9 }, 2)).toEqual({ c: 9, a: 5 });
  });
});

describe("recordProjectOpened", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSetting.mockReset();
    setSetting.mockReset();
    resetLastOpenedForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("writes once, debounced, merged with what was stored — and only after the read", async () => {
    getSetting.mockResolvedValue('{"old":1}');
    recordProjectOpened("a", 10);
    recordProjectOpened("b", 20);
    expect(setSetting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(JSON.parse(setSetting.mock.calls[0][1])).toEqual({ old: 1, a: 10, b: 20 });
    expect(lastOpenedNow()).toEqual({ old: 1, a: 10, b: 20 });
  });
});
