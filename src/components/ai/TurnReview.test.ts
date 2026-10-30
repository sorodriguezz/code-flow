import { describe, expect, it } from "vitest";
import type { TurnFile } from "../../lib/tauri/commands";
import { sameFileAsRead } from "./TurnReview";

const file = (patch: Partial<TurnFile> = {}): TurnFile => ({ before: "a\n", after: "b\n", binary: false, revision: "r1", ...patch });

describe("sameFileAsRead", () => {
  it("accepts the file as it was read", () => {
    expect(sameFileAsRead(file(), file())).toBe(true);
  });

  it("refuses a file edited since — by a later turn or by hand", () => {
    expect(sameFileAsRead(file(), file({ revision: "r2", after: "b\nc\n" }))).toBe(false);
    expect(sameFileAsRead(file(), file({ after: "x\n" }))).toBe(false);
  });

  it("refuses when the file cannot be read again", () => {
    expect(sameFileAsRead(file(), null)).toBe(false);
    expect(sameFileAsRead(file(), file({ binary: true }))).toBe(false);
  });
});
