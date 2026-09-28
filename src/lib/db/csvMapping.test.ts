import { describe, expect, it } from "vitest";
import { autoMapColumns, normalizeColumnName } from "./csvMapping";

describe("autoMapColumns", () => {
  const table = ["id", "customer_id", "total", "created_at"];

  it("matches a header by name, however it is spelled", () => {
    expect(autoMapColumns(["ID", "Customer ID", "Created-At", "notes"], 4, table, true)).toEqual([
      "id",
      "customer_id",
      "created_at",
      null,
    ]);
  });

  it("maps by position when the file has no header", () => {
    expect(autoMapColumns(["7", "3", "9.50"], 3, table, false)).toEqual(["id", "customer_id", "total"]);
    // A file wider than the table leaves the extra columns out.
    expect(autoMapColumns(["1", "2", "3", "4", "5"], 5, table, false)).toEqual([...table, null]);
  });

  it("never offers one table column twice", () => {
    expect(autoMapColumns(["id", "ID"], 2, table, true)).toEqual(["id", null]);
  });
});

describe("normalizeColumnName", () => {
  it("drops case and the separators people vary", () => {
    expect(normalizeColumnName(" Order_Line-Item ")).toBe("orderlineitem");
  });
});
