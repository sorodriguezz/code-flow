import { describe, expect, it } from "vitest";
import { buttonClass, iconButtonClass } from "./Button";
import { densityMark, fieldClass, menuItemClass, rowClass } from "./recipes";

describe("density markers", () => {
  it("marks a recipe whose height the call site left alone", () => {
    expect(buttonClass({ size: "md" })).toContain("cf-d-btn-md");
    expect(iconButtonClass({ size: "sm" })).toContain("cf-d-ibtn-sm");
    expect(fieldClass({ size: "sm" })).toContain("cf-d-fld-sm");
    expect(menuItemClass()).toContain("cf-d-menu");
  });

  it("leaves a call site's own height alone", () => {
    expect(buttonClass({ size: "sm", className: "h-[22px] px-1.5" })).not.toContain("cf-d-btn");
    expect(fieldClass({ className: "h-auto resize-y" })).not.toContain("cf-d-fld");
    expect(iconButtonClass({ className: "w-9" })).not.toContain("cf-d-ibtn");
    expect(densityMark("m", "min-h-8")).toBe("m");
  });

  it("never drops the recipe's own utilities", () => {
    expect(buttonClass({ size: "md" })).toContain(" h-7 ");
    expect(rowClass(false, "h-[30px]")).toContain("h-[30px]");
  });

  it("marks rows by the height they were given and only those", () => {
    expect(rowClass(false, "h-7")).toContain("cf-d-row-28");
    expect(rowClass(false, "h-[30px] pr-1")).toContain("cf-d-row-30");
    expect(rowClass(false, "mt-1.5 h-8 cursor-pointer")).toContain("cf-d-row-32");
    expect(rowClass(false, "min-h-11 py-1.5")).not.toContain("cf-d-row");
  });
});
