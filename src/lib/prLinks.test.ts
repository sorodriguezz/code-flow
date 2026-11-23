import { describe, expect, it } from "vitest";
import { looksLikePrLink, splitPrLinks } from "./prLinks";

describe("splitPrLinks", () => {
  const a = "https://github.com/acme/app/pull/42";
  const b = "https://dev.azure.com/org/proj/_git/repo/pullrequest/7";

  it("keeps a single link exactly as the one-link flow had it", () => {
    expect(splitPrLinks(`  ${a}  `)).toEqual([a]);
    expect(splitPrLinks("not a link")).toEqual(["not"]);
    expect(splitPrLinks("")).toEqual([]);
  });

  it("splits on newlines, spaces and commas, in order, each once", () => {
    expect(splitPrLinks(`${a}\n${b}`)).toEqual([a, b]);
    expect(splitPrLinks(`${a}, ${b},${a}`)).toEqual([a, b]);
    expect(splitPrLinks(`Revisa estos: <${a}> y (${b}).`)).toEqual([a, b]);
  });

  it("only offers what looks like a pull request", () => {
    expect(looksLikePrLink(a)).toBe(true);
    expect(looksLikePrLink(b)).toBe(true);
    expect(looksLikePrLink("https://gitlab.com/g/p/-/merge_requests/3")).toBe(true);
    expect(looksLikePrLink("https://github.com/acme/app")).toBe(false);
  });
});
