import { describe, expect, it } from "vitest";
import { findUnresolved, listVariables, lookupVariable, resolve, resolveKeyValues, type VariableContext } from "./variables";
import type { ApiVariable } from "../../types/api";

function v(key: string, initialValue: string, extra: Partial<ApiVariable> = {}): ApiVariable {
  return { id: key, key, initialValue, currentValue: "", secret: false, enabled: true, description: "", ...extra };
}

function ctx(patch: Partial<VariableContext> = {}): VariableContext {
  return { local: {}, data: {}, environment: [], collection: [], global: [], ...patch };
}

describe("variable resolution", () => {
  it("follows local → data → environment → collection → global", () => {
    const scopes = ctx({
      local: { who: "local" },
      data: { who: "data", row: "7" },
      environment: [v("who", "environment"), v("host", "api.example.test")],
      collection: [v("who", "collection"), v("version", "v1")],
      global: [v("who", "global"), v("scheme", "https")],
    });
    expect(resolve("{{who}}", scopes)).toBe("local");
    expect(lookupVariable("row", scopes)).toEqual({ value: "7", scope: "data" });
    expect(resolve("{{scheme}}://{{host}}/{{version}}/orders/{{row}}", scopes)).toBe(
      "https://api.example.test/v1/orders/7",
    );
  });

  it("uses the current value over the initial one, and treats an empty current as not overridden", () => {
    expect(resolve("{{token}}", ctx({ environment: [v("token", "initial", { currentValue: "current" })] }))).toBe("current");
    expect(resolve("{{token}}", ctx({ environment: [v("token", "initial", { currentValue: "" })] }))).toBe("initial");
  });

  it("skips disabled variables, falling through to the next scope", () => {
    const scopes = ctx({
      environment: [v("baseUrl", "https://disabled.example.test", { enabled: false })],
      collection: [v("baseUrl", "https://api.example.test")],
    });
    expect(resolve("{{baseUrl}}", scopes)).toBe("https://api.example.test");
    expect(listVariables(scopes).map((entry) => [entry.name, entry.scope])).toEqual([["baseUrl", "collection"]]);
  });

  it("expands variables whose values hold other variables, and stops on a cycle", () => {
    const nested = ctx({ environment: [v("host", "api.example.test"), v("baseUrl", "https://{{host}}/v1")] });
    expect(resolve("{{baseUrl}}/orders", nested)).toBe("https://api.example.test/v1/orders");

    const cyclic = ctx({ environment: [v("a", "{{b}}"), v("b", "{{a}}")] });
    // Bounded: returns rather than spinning, with a token still in it.
    expect(resolve("{{a}}", cyclic)).toMatch(/\{\{[ab]\}\}/);
  });

  it("leaves an unknown token exactly as typed, and reports it", () => {
    const scopes = ctx({ environment: [v("host", "{{missing}}")] });
    expect(resolve("https://{{host}}/{{ orderId }}", scopes)).toBe("https://{{missing}}/{{ orderId }}");
    expect(findUnresolved("https://{{host}}/{{ orderId }}", scopes)).toEqual(["missing", "orderId"]);
  });

  it("evaluates dynamic variables per occurrence", () => {
    const [first, second] = resolve("{{$guid}} {{$guid}}", ctx()).split(" ");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });

  it("resolves key, value and file source of every row, disabled rows included", () => {
    const rows = resolveKeyValues(
      [
        { id: "1", key: "{{name}}", value: "{{value}}", description: "{{kept}}", enabled: false, type: "file", src: "{{dir}}/a.png" },
      ],
      ctx({ environment: [v("name", "X-Id"), v("value", "42"), v("dir", "/tmp")] }),
    );
    expect(rows[0]).toMatchObject({ key: "X-Id", value: "42", src: "/tmp/a.png", description: "{{kept}}", enabled: false });
  });
});
