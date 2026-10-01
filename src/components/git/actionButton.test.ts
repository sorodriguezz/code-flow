import { describe, expect, it } from "vitest";
import { actionButtonClass } from "./actionButton";

/** Every icon button of the Changes screen is a 22px target, and its hover is spelled exactly once. */
describe("actionButtonClass", () => {
  const count = (classes: string, pattern: RegExp) => classes.split(/\s+/).filter((c) => pattern.test(c)).length;

  it("is a 22px square, not the size of its glyph", () => {
    const classes = actionButtonClass();
    expect(classes).toContain("h-[22px]");
    expect(classes).toContain("w-[22px]");
  });

  it("carries one hover tint — the stronger one on a row that is itself tinted", () => {
    expect(count(actionButtonClass(), /hover:bg-/)).toBe(1);
    expect(actionButtonClass()).toContain("enabled:hover:bg-[var(--cf-hover)]");
    expect(count(actionButtonClass("accent", { onRow: true }), /hover:bg-/)).toBe(1);
    expect(actionButtonClass("accent", { onRow: true })).toContain("enabled:hover:bg-[var(--cf-press)]");
  });

  it("carries one hover colour, the tone's — two would be settled by Tailwind's alphabet, not by the caller", () => {
    for (const tone of ["accent", "danger", "success"] as const) {
      const classes = actionButtonClass(tone);
      expect(count(classes, /hover:text-/)).toBe(1);
      expect(classes).toContain(`enabled:hover:text-[var(--cf-${tone})]`);
    }
  });

  it("keeps a blocked action's pointer events, so its click stops there instead of reaching the row", () => {
    expect(actionButtonClass()).not.toContain("pointer-events-none");
  });
});
