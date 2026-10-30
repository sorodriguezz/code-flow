import { describe, expect, it } from "vitest";
import { ScrollLedger, ScrollMemory, scrollKey } from "./useScrollMemory";

const el = (top = 0, left = 0, isConnected = true) => ({ scrollTop: top, scrollLeft: left, isConnected });

describe("scrollKey", () => {
  it("separates workspaces, views and sub-keys", () => {
    expect(scrollKey("w1", "graph", "log")).toBe("w1:graph:log");
    expect(scrollKey(null, "notes")).toBe("-:notes:");
    expect(scrollKey("w1", "db")).not.toBe(scrollKey("w2", "db"));
  });
});

describe("ScrollMemory", () => {
  it("caps its size, dropping the least recently used", () => {
    const m = new ScrollMemory(3);
    m.set("a", { top: 1, left: 0 });
    m.set("b", { top: 2, left: 0 });
    m.set("c", { top: 3, left: 0 });
    m.get("a");
    m.set("d", { top: 4, left: 0 });
    expect(m.size).toBe(3);
    expect(m.get("b")).toBeUndefined();
    expect(m.get("a")?.top).toBe(1);
  });

  it("does not spend the cap on the top of a list", () => {
    const m = new ScrollMemory(3);
    m.set("a", { top: 5, left: 0 });
    m.set("a", { top: 0, left: 0 });
    expect(m.get("a")).toBeUndefined();
  });
});

describe("ScrollLedger", () => {
  it("restores positions recorded in the same scope", () => {
    const l = new ScrollLedger<ReturnType<typeof el>>();
    const a = el(120, 4);
    l.record(a, "w1:r1");
    a.scrollTop = 0;
    a.scrollLeft = 0;
    expect(l.restore("w1:r1")).toBe(1);
    expect(a.scrollTop).toBe(120);
    expect(a.scrollLeft).toBe(4);
  });

  it("never applies another workspace's or repository's offsets, and forgets them", () => {
    const l = new ScrollLedger<ReturnType<typeof el>>();
    const a = el(50);
    l.record(a, "w1:r1");
    a.scrollTop = 0;
    expect(l.restore("w2:r1")).toBe(0);
    expect(a.scrollTop).toBe(0);
    expect(l.size).toBe(0);
  });

  it("drops removed elements and caps its size", () => {
    const l = new ScrollLedger<ReturnType<typeof el>>(2);
    const gone = el(10);
    l.record(gone, "s");
    gone.isConnected = false;
    expect(l.restore("s")).toBe(0);
    l.record(el(1), "s");
    l.record(el(2), "s");
    l.record(el(3), "s");
    expect(l.size).toBe(2);
  });

  it("forgets an element that returned to the top", () => {
    const l = new ScrollLedger<ReturnType<typeof el>>();
    const a = el(30);
    l.record(a, "s");
    a.scrollTop = 0;
    l.record(a, "s");
    expect(l.size).toBe(0);
  });
});
