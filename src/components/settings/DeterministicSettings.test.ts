import { describe, expect, it } from "vitest";
import { ruleEnabled } from "./DeterministicSettings";

const rule = (id: string, enabledByDefault: boolean) => ({
  id,
  title: id,
  severity: "Mayor",
  categories: [],
  paths: ["**/package.json"],
  levels: ["completo", "ultra"],
  enabledByDefault,
});

describe("a deterministic rule's switch", () => {
  it("reads like the backend decides it: master switch, then the override, then the default", () => {
    const cfg = { prescan: true, rules: true, ruleOverrides: { "R-0002": false } };
    expect(ruleEnabled(cfg, rule("R-0001", true))).toBe(true);
    expect(ruleEnabled(cfg, rule("R-0002", true))).toBe(false);
    expect(ruleEnabled(cfg, rule("R-0009", false))).toBe(false);
    expect(ruleEnabled({ ...cfg, ruleOverrides: { "R-0009": true } }, rule("R-0009", false))).toBe(true);
    expect(ruleEnabled({ ...cfg, rules: false }, rule("R-0001", true))).toBe(false);
  });
});
