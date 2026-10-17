import { describe, expect, it } from "vitest";
import { normalizePath, pathToAccessor, pathToJsonPath, queryJsonPath, selectJsonPath } from "./jsonPath";
import { jsonValueAt } from "./jsonAt";

const store = {
  data: [
    { id: 1, name: "a", price: 5, tags: ["x"] },
    { id: 2, name: "b", price: 15 },
    { id: 3, name: "c", price: 8, tags: [] },
  ],
  meta: { total: 3, "first name": "Ana" },
};

describe("jsonPath", () => {
  it("walks children, indexes and wildcards", () => {
    expect(selectJsonPath(store, "$.meta.total")).toBe(3);
    expect(selectJsonPath(store, "$.data[-1].id")).toBe(3);
    expect(queryJsonPath(store, "$.data[*].id")).toEqual([1, 2, 3]);
    expect(selectJsonPath(store, "$['meta']['first name']")).toBe("Ana");
    expect(selectJsonPath(store, "$.data.length")).toBe(3);
  });

  it("reads jq-style paths", () => {
    expect(normalizePath(".data[].id")).toBe("$.data[*].id");
    expect(queryJsonPath(store, ".data[].name")).toEqual(["a", "b", "c"]);
    expect(selectJsonPath(store, "meta.total")).toBe(3);
  });

  it("descends, slices and unions", () => {
    expect(queryJsonPath(store, "$..price")).toEqual([5, 15, 8]);
    expect(queryJsonPath(store, "$.data[0:2].id")).toEqual([1, 2]);
    expect(queryJsonPath(store, "$.data[::2].id")).toEqual([1, 3]);
    expect(queryJsonPath(store, "$.data[0,2].name")).toEqual(["a", "c"]);
  });

  it("filters", () => {
    expect(queryJsonPath(store, "$.data[?(@.price < 10)].id")).toEqual([1, 3]);
    expect(queryJsonPath(store, "$.data[?(@.price > 4 && @.tags)].id")).toEqual([1, 3]);
    expect(queryJsonPath(store, "$.data[?(@.name == 'b')].price")).toEqual([15]);
    expect(queryJsonPath(store, "$.data[?(@.name =~ /^[ab]$/)].id")).toEqual([1, 2]);
    expect(queryJsonPath(store, "$.data[?(!@.tags)].id")).toEqual([2]);
  });

  it("explains a malformed path", () => {
    expect(() => queryJsonPath(store, "$.data[?(@.price <)]")).toThrow();
    expect(() => queryJsonPath(store, "$.data[")).toThrow();
  });

  it("writes paths back out", () => {
    expect(pathToJsonPath(["data", 0, "first name"])).toBe("$.data[0]['first name']");
    expect(pathToAccessor(["data", 0, "first name"])).toBe('.data[0]["first name"]');
  });
});

describe("jsonValueAt", () => {
  const text = JSON.stringify({ user: { id: 42, roles: ["admin", "dev"] }, ok: true }, null, 2);

  it("finds the value under the caret, and a key means its value", () => {
    expect(jsonValueAt(text, text.indexOf("42"))).toMatchObject({ path: ["user", "id"], value: 42 });
    expect(jsonValueAt(text, text.indexOf('"id"') + 1)).toMatchObject({ path: ["user", "id"], value: 42 });
    expect(jsonValueAt(text, text.indexOf('"dev"') + 2)).toMatchObject({ path: ["user", "roles", 1], value: "dev" });
    expect(jsonValueAt(text, text.indexOf("true"))).toMatchObject({ path: ["ok"], value: true });
  });

  it("gives up on text that is not JSON", () => {
    expect(jsonValueAt("not json", 2)).toBeNull();
  });
});
