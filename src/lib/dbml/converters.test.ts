import { describe, expect, it } from "vitest";
import { CONVERSION_KINDS, CONVERSION_TARGETS } from "./converters";

/**
 * The one thing the grouped target bar can quietly get wrong.
 *
 * `DbmlConvertPanel` draws a track per entry in `CONVERSION_KINDS` and fills it with the targets of
 * that kind. A target whose kind is not in that list is not an error anywhere — it simply stops
 * being offered, and the only way to find out is to go looking for Prisma and not find it.
 */
describe("the code targets and their groups", () => {
  it("offers every target under exactly one group", () => {
    const drawn = CONVERSION_KINDS.flatMap((kind) =>
      CONVERSION_TARGETS.filter((target) => target.kind === kind).map((target) => target.id),
    );
    expect([...drawn].sort()).toEqual([...CONVERSION_TARGETS.map((t) => t.id)].sort());
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it("has no empty group", () => {
    // An empty track would draw its uppercase label with nothing under it.
    for (const kind of CONVERSION_KINDS) {
      expect(CONVERSION_TARGETS.some((target) => target.kind === kind)).toBe(true);
    }
  });
});
