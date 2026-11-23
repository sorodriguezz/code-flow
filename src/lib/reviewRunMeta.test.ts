import { describe, expect, it } from "vitest";
import { runShaping } from "./reviewRunMeta";

describe("runShaping", () => {
  it("reads the calibration and the rules a run froze", () => {
    const meta = {
      calibration: {
        minConfidence: 85,
        heldBack: 2,
        categories: [{ categoria: "missing-validation", slug: "missing-validation", dismissed: 3, total: 4, motivo: null }],
      },
      rules: [
        { id: "R-0002", severity: "Mayor", status: "facts" },
        { id: "R-0004", severity: "Info", status: "not_evaluated", reason: "sin red" },
        { id: "R-9", status: "weird" },
      ],
    };
    expect(runShaping(meta)).toEqual({
      calibration: { minConfidence: 85, categories: ["missing-validation"], heldBack: 2 },
      rules: [
        { id: "R-0002", status: "facts", reason: null },
        { id: "R-0004", status: "not_evaluated", reason: "sin red" },
      ],
    });
  });

  it("is empty for a run saved before either was kept", () => {
    expect(runShaping({ level: "completo" })).toEqual({ calibration: null, rules: [] });
    expect(runShaping(null)).toEqual({ calibration: null, rules: [] });
    expect(runShaping({ calibration: { minConfidence: 85, categories: [] } }).calibration).toBeNull();
  });
});
