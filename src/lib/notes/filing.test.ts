import { describe, expect, it } from "vitest";
import { findMonthBook, meetingsHome, monthBookName, monthGroups } from "./filing";

const book = (id: string, name: string, parent_id: string | null = null, sort_order = 0) => ({ id, name, parent_id, sort_order });
const note = (id: string, book_id: string | null, created_at = "2026-11-18T12:00:00") => ({ id, book_id, created_at });

describe("where a dated note is filed", () => {
  it("names a month's book the way a person would", () => {
    expect(monthBookName(new Date(2026, 10, 25), "es")).toBe("Noviembre 2026");
    expect(monthBookName(new Date(2026, 9, 1), "en")).toBe("October 2026");
  });

  it("finds the month's book already there, in either language and any case", () => {
    const books = [book("m", "Reuniones"), book("oct", "octubre 2026", "m"), book("nov", "November 2026", "m"), book("other", "Noviembre 2026", "x")];
    expect(findMonthBook(books, "m", new Date(2026, 9, 3))?.id).toBe("oct");
    expect(findMonthBook(books, "m", new Date(2026, 10, 3))?.id).toBe("nov");
    expect(findMonthBook(books, "m", new Date(2026, 11, 3))).toBeUndefined();
  });

  it("sends new meetings to the book that already holds most of them, whatever it is called", () => {
    const books = [book("info", "Información general", null, 0), book("daily", "Daily Reuniones", null, 1), book("nov", "Noviembre 2026", "daily"), book("named", "Reuniones", null, 2)];
    const notes = [note("a", "info"), note("b", "nov"), note("c", "nov"), note("d", "daily"), note("e", "named")];
    expect(meetingsHome(books, notes, new Set(["a", "b", "c"]), "Reuniones")?.id).toBe("daily");
    // With no meeting anywhere, the book of that name; with neither, none: the caller makes it.
    expect(meetingsHome(books, notes, new Set(), "reuniones")?.id).toBe("named");
    expect(meetingsHome(books.slice(0, 3), notes, new Set(), "Reuniones")).toBeUndefined();
  });

  it("groups a book's loose notes by the month they were written, oldest first", () => {
    const notes = [note("n1", "b", "2026-11-02T09:00:00"), note("o1", "b", "2026-10-27T09:00:00"), note("n2", "b", "2026-11-20T09:00:00"), note("inside", "b-oct", "2026-10-01T09:00:00"), note("bad", "b", "nunca")];
    expect(monthGroups(notes, "b", "es").map((group) => [group.name, group.noteIds])).toEqual([
      ["Octubre 2026", ["o1"]],
      ["Noviembre 2026", ["n1", "n2"]],
    ]);
  });
});
