import { describe, expect, it, vi } from "vitest";
import {
  isCancelled,
  keepBothName,
  resolveTransfers,
  TRANSFER_CANCELLED,
  type ConflictQuestions,
  type TransferItem,
} from "./transfers";

/**
 * What a transfer does when its destination is taken. The cases worth pinning are the ones a
 * dialog hides: which items were asked about at all, that one answer covers a batch only when the
 * user said so, that backing out of any question calls the whole thing off, and that "keep both"
 * lands on a name nothing already has — the check that stops it replacing a copy made last week.
 */

const join = (dir: string, name: string) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

const item = (name: string, isDir = false, dir = "/srv"): TransferItem => ({
  source: `/local/${name}`,
  name,
  isDir,
  dir,
});

/** A far side holding exactly `present`. */
const existsIn = (present: string[]) => vi.fn(async (paths: string[]) => paths.map((path) => present.includes(path)));

const never: ConflictQuestions = {
  all: async () => {
    throw new Error("nothing collides, so nothing is asked");
  },
  one: async () => {
    throw new Error("nothing collides, so nothing is asked");
  },
};

describe("keepBothName", () => {
  it("numbers a file before its extension, so the copy opens with the same program", () => {
    expect(keepBothName("report.pdf", 1, false)).toBe("report (1).pdf");
    expect(keepBothName("report.final.pdf", 2, false)).toBe("report.final (2).pdf");
  });

  it("treats .tar.gz as one extension", () => {
    expect(keepBothName("backup.tar.gz", 1, false)).toBe("backup (1).tar.gz");
  });

  it("gives a folder, a dot-file and a bare name no extension to preserve", () => {
    expect(keepBothName("photos.2024", 1, true)).toBe("photos.2024 (1)");
    expect(keepBothName(".env", 1, false)).toBe(".env (1)");
    expect(keepBothName("Makefile", 3, false)).toBe("Makefile (3)");
  });
});

describe("resolveTransfers", () => {
  it("asks nothing and moves everything when no destination is taken", async () => {
    const resolved = await resolveTransfers([item("a.txt"), item("b.txt")], existsIn([]), never, join);
    expect(resolved?.map((entry) => entry.dest)).toEqual(["/srv/a.txt", "/srv/b.txt"]);
  });

  it("asks about the one collision, by name, and skipping leaves the rest to go", async () => {
    const one = vi.fn(async (_item: TransferItem) => "skip" as const);
    const resolved = await resolveTransfers(
      [item("a.txt"), item("b.txt")],
      existsIn(["/srv/b.txt"]),
      { ...never, one },
      join,
    );
    expect(one).toHaveBeenCalledTimes(1);
    expect(one.mock.calls[0][0].name).toBe("b.txt");
    expect(resolved?.map((entry) => entry.dest)).toEqual(["/srv/a.txt"]);
  });

  it("replacing keeps the original destination", async () => {
    const resolved = await resolveTransfers(
      [item("a.txt")],
      existsIn(["/srv/a.txt"]),
      { ...never, one: async () => "replace" },
      join,
    );
    expect(resolved?.map((entry) => entry.dest)).toEqual(["/srv/a.txt"]);
  });

  it("keeping both lands on the first numbered name nothing has — never on last week's copy", async () => {
    const resolved = await resolveTransfers(
      [item("a.txt")],
      existsIn(["/srv/a.txt", "/srv/a (1).txt"]),
      { ...never, one: async () => "keep" },
      join,
    );
    expect(resolved?.[0].dest).toBe("/srv/a (2).txt");
    expect(resolved?.[0].name).toBe("a (2).txt");
  });

  it("one answer covers a batch of collisions when the user gives one", async () => {
    const all = vi.fn(async (_names: string[]) => "replace" as const);
    const one = vi.fn(async (_item: TransferItem) => "skip" as const);
    const resolved = await resolveTransfers(
      [item("a.txt"), item("b.txt"), item("c.txt")],
      existsIn(["/srv/a.txt", "/srv/c.txt"]),
      { all, one },
      join,
    );
    expect(all).toHaveBeenCalledWith(["a.txt", "c.txt"]);
    expect(one).not.toHaveBeenCalled();
    expect(resolved?.map((entry) => entry.dest)).toEqual(["/srv/a.txt", "/srv/b.txt", "/srv/c.txt"]);
  });

  it("deciding one by one asks about each collision in order", async () => {
    const answers = ["keep", "skip"] as const;
    const one = vi.fn(async (_item: TransferItem) => answers[one.mock.calls.length - 1]);
    const resolved = await resolveTransfers(
      [item("a.txt"), item("b.txt"), item("c.txt")],
      existsIn(["/srv/a.txt", "/srv/c.txt"]),
      { all: async () => "each", one },
      join,
    );
    expect(one.mock.calls.map((call) => call[0].name)).toEqual(["a.txt", "c.txt"]);
    expect(resolved?.map((entry) => entry.dest)).toEqual(["/srv/a (1).txt", "/srv/b.txt"]);
  });

  it("backing out of any question calls the whole transfer off", async () => {
    expect(
      await resolveTransfers([item("a.txt")], existsIn(["/srv/a.txt"]), { ...never, one: async () => null }, join),
    ).toBeNull();
    expect(
      await resolveTransfers(
        [item("a.txt"), item("b.txt")],
        existsIn(["/srv/a.txt", "/srv/b.txt"]),
        { all: async () => null, one: never.one },
        join,
      ),
    ).toBeNull();
  });

  it("two kept items with the same name do not both claim the same copy name", async () => {
    const resolved = await resolveTransfers(
      [item("a.txt", false, "/srv"), { ...item("a.txt", false, "/srv"), source: "/other/a.txt" }],
      existsIn(["/srv/a.txt"]),
      { all: async () => "keep", one: never.one },
      join,
    );
    expect(resolved?.map((entry) => entry.dest)).toEqual(["/srv/a (1).txt", "/srv/a (2).txt"]);
  });

  it("a folder kept twice is numbered like a folder", async () => {
    const resolved = await resolveTransfers(
      [item("photos", true)],
      existsIn(["/srv/photos"]),
      { ...never, one: async () => "keep" },
      join,
    );
    expect(resolved?.[0].dest).toBe("/srv/photos (1)");
  });
});

describe("isCancelled", () => {
  it("recognises the backend's cancel however it was wrapped", () => {
    expect(isCancelled(TRANSFER_CANCELLED)).toBe(true);
    expect(isCancelled(new Error(TRANSFER_CANCELLED))).toBe(true);
    expect(isCancelled("Couldn't write a.txt: broken pipe")).toBe(false);
  });
});
