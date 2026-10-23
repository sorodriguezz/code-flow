import { describe, expect, it } from "vitest";
import { elapsed } from "./EnginesActivity";

describe("how long a server has run", () => {
  it("reads in the largest unit that says it", () => {
    expect(elapsed(40)).toBe("40 s");
    expect(elapsed(12 * 60 + 5)).toBe("12 min");
    expect(elapsed(65 * 60)).toBe("1 h 5 min");
    expect(elapsed(-3)).toBe("0 s");
  });
});
