import { describe, expect, it } from "vitest";
import { NOTICE_DEFAULTS, placementOf } from "./noticePositionStore";

describe("notice placement", () => {
  it("keeps the two kinds apart by default", () => {
    expect(placementOf(NOTICE_DEFAULTS.toasts)).toEqual({ edge: "bottom", align: "center" });
    expect(placementOf(NOTICE_DEFAULTS.popups)).toEqual({ edge: "bottom", align: "right" });
  });

  it("reads a spot as edge and alignment", () => {
    expect(placementOf("top-left")).toEqual({ edge: "top", align: "left" });
  });
});
