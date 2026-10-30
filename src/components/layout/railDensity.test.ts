import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every `cf-d-*` marker the rail and the sidebar add has a compact rule, and comfortable has none. */

const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
const marked = ["AppRail.tsx", "Sidebar.tsx"].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));

describe("rail and sidebar density markers", () => {
  const used = new Set(marked.flatMap((src) => src.match(/cf-d-[a-z0-9-]+/g) ?? []).filter((c) => !c.startsWith("cf-d-") || true));
  // Tokens (`--cf-d-*`) are not markers; the regex above only sees class-like uses in the sources.
  it("uses some markers", () => {
    expect(used.size).toBeGreaterThan(0);
  });

  for (const marker of used) {
    it(`${marker} has a compact-only rule`, () => {
      const rules = css.split("\n").filter((l) => new RegExp(`\\.${marker}\\b`).test(l));
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) expect(r.startsWith(':root[data-density="compact"] ')).toBe(true);
    });
  }

  it("adds no rule for these markers outside the compact scope", () => {
    for (const marker of used) {
      const bare = css.split("\n").filter((l) => new RegExp(`\\.${marker}\\b`).test(l) && !l.includes('data-density="compact"'));
      expect(bare).toEqual([]);
    }
  });
});
