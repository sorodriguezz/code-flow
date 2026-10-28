import { describe, expect, it } from "vitest";
import { diskIsTight, reclaimable, shares, visibleCategories, type StorageUsage } from "./storageView";

const usage = (free: number, total: number): StorageUsage => ({
  free_bytes: free,
  total_bytes: total,
  categories: [
    { id: "models", path: "/m", bytes: 6_000, files: 2, clearable: false },
    { id: "cache", path: "/c", bytes: 3_000, files: 9, clearable: true },
    { id: "logs", path: "/l", bytes: 1_000, files: 2, clearable: true },
    { id: "empty", path: "/e", bytes: 0, files: 0, clearable: false },
  ],
});

describe("storageView", () => {
  it("lists only places that hold something, biggest first", () => {
    expect(visibleCategories(usage(1, 1)).map((c) => c.id)).toEqual(["models", "cache", "logs"]);
  });

  it("gives each place its share, never less than a sliver", () => {
    expect(shares(visibleCategories(usage(1, 1)))).toEqual([60, 30, 10]);
    expect(shares([{ id: "a", path: "", bytes: 1, files: 1, clearable: false }, { id: "b", path: "", bytes: 1_000_000, files: 1, clearable: false }])).toEqual([1, 100]);
    expect(shares([])).toEqual([]);
  });

  it("calls the disk tight under 5 GB or 5 %, and says nothing when it cannot tell", () => {
    const gb = 1024 ** 3;
    expect(diskIsTight(usage(2 * gb, 500 * gb))).toBe(true);
    expect(diskIsTight(usage(20 * gb, 500 * gb))).toBe(true);
    expect(diskIsTight(usage(100 * gb, 500 * gb))).toBe(false);
    expect(diskIsTight(usage(0, 0))).toBe(false);
  });

  it("counts only what can be given back", () => {
    expect(reclaimable(usage(1, 1))).toBe(4_000);
  });
});
