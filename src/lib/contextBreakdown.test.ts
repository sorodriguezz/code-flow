import { describe, expect, it } from "vitest";
import { parseContextBreakdown } from "./contextBreakdown";

describe("parseContextBreakdown", () => {
  it("reads a bulleted list with percentages", () => {
    const out = parseContextBreakdown(
      [
        "Context Usage",
        "model-x · 42k/200k tokens (21%)",
        "⛁ System prompt: 3.2k tokens (1.6%)",
        "⛁ System tools: 11.5k tokens (5.8%)",
        "⛁ Messages: 27.3k tokens (13.7%)",
        "⛶ Free space: 158k tokens (79%)",
      ].join("\n"),
    );
    expect(out?.categories.map((c) => [c.name, c.tokens])).toEqual([
      ["System prompt", 3200],
      ["System tools", 11500],
      ["Messages", 27300],
      ["Free space", 158000],
    ]);
    expect(out?.used).toBe(42000);
    expect(out?.categories[3].free).toBe(true);
    expect(out?.categories[0].percent).toBe(1.6);
  });

  it("reads a markdown table", () => {
    const out = parseContextBreakdown("| Category | Tokens |\n| System prompt | 3000 tokens |\n| Skills | 900 tokens |\n| Messages | 100 tokens |");
    expect(out?.categories).toHaveLength(3);
  });

  it("leaves an answer with fewer than three categories as text", () => {
    expect(parseContextBreakdown("Context Usage\nMessages: 10 tokens\nSkills: 3 tokens")).toBeNull();
    expect(parseContextBreakdown("hello")).toBeNull();
  });
});
