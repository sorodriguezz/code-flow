import { describe, expect, it } from "vitest";
import { authorHue, initials } from "./authorMark";
import { ago } from "./relativeAgo";

describe("author mark", () => {
  it("takes two initials, from the e-mail when there is no name", () => {
    expect(initials("Ana María López")).toBe("AM");
    expect(initials("dependabot[bot]")).toBe("DE");
    expect(initials("", "jose.perez@example.com")).toBe("JP");
    expect(initials("")).toBe("?");
  });

  it("keeps one colour per person", () => {
    expect(authorHue("Ana", "ANA@example.com")).toBe(authorHue("Ana L.", "ana@example.com"));
    expect(authorHue("a", "a@example.com")).toBeGreaterThanOrEqual(0);
  });
});

describe("ago", () => {
  const now = Date.UTC(2026, 9, 17, 12);
  it("is relative for a week and a date after", () => {
    expect(ago(now / 1000 - 7200, "en", now)).toBe("2 hours ago");
    expect(ago(now / 1000 - 30 * 86400, "en", now)).toMatch(/Sep/);
  });
});
