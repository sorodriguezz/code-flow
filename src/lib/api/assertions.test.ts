import { describe, expect, it } from "vitest";
import { assertionName, evaluateAssertions, newAssertion } from "./assertions";
import type { ApiAssertion, HttpResponse } from "../../types/api";

function response(body: unknown, extra: Partial<HttpResponse> = {}): HttpResponse {
  return {
    status: 200,
    status_text: "OK",
    http_version: "HTTP/1.1",
    headers: [["Content-Type", "application/json; charset=utf-8"]],
    body_text: typeof body === "string" ? body : JSON.stringify(body),
    body_base64: null,
    size_bytes: 120,
    duration_ms: 87,
    timings: { dns_ms: -1, connect_ms: -1, tls_ms: -1, first_byte_ms: 80, download_ms: 7, total_ms: 87 },
    redirects: [],
    set_cookies: [],
    sent: { method: "GET", url: "https://api.example.com", headers: [], body_preview: "" },
    ...extra,
  };
}

const row = (patch: Partial<ApiAssertion>): ApiAssertion => ({ ...newAssertion("a"), ...patch });

describe("assertions", () => {
  const body = { data: { id: 7, tags: ["a", "b"], name: "Ana" }, empty: null };

  it("passes and fails on status, time and size", () => {
    const [status, time, size] = evaluateAssertions(
      [row({ source: "status", operator: "eq", expected: "200" }), row({ source: "time", operator: "lt", expected: "50" }), row({ source: "size", operator: "lte", expected: "120" })],
      response(body),
    );
    expect(status.passed).toBe(true);
    expect(time.passed).toBe(false);
    expect(size.passed).toBe(true);
  });

  it("reads headers case-insensitively", () => {
    const [found] = evaluateAssertions([row({ source: "header", property: "content-type", operator: "contains", expected: "json" })], response(body));
    expect(found.passed).toBe(true);
  });

  it("checks JSON paths", () => {
    const results = evaluateAssertions(
      [
        row({ source: "jsonpath", property: "$.data.id", operator: "eq", expected: "7" }),
        row({ source: "jsonpath", property: ".data.tags", operator: "contains", expected: "b" }),
        row({ source: "jsonpath", property: "$.data.missing", operator: "notExists", expected: "" }),
        row({ source: "jsonpath", property: "$.empty", operator: "isType", expected: "null" }),
        row({ source: "jsonpath", property: "$.data.name", operator: "matches", expected: "^A" }),
        row({ source: "jsonpath", property: "$.data.tags", operator: "gte", expected: "2" }),
      ],
      response(body),
    );
    expect(results.map((r) => r.passed)).toEqual([true, true, true, true, true, true]);
  });

  it("fails a JSON path over a body that is not JSON", () => {
    const [result] = evaluateAssertions([row({ source: "jsonpath", property: "$.a", operator: "exists" })], response("<html>"));
    expect(result.passed).toBe(false);
  });

  it("skips disabled and unfinished rows", () => {
    expect(evaluateAssertions([row({ enabled: false }), row({ source: "header", property: "" })], response(body))).toEqual([]);
  });

  it("names a row with symbols", () => {
    expect(assertionName(row({ source: "status", operator: "eq", expected: "201" }))).toBe("status == 201");
    expect(assertionName(row({ source: "jsonpath", property: ".id", operator: "exists" }))).toBe("$.id exists");
    expect(assertionName(row({ source: "time", operator: "lt", expected: "500" }))).toBe("time < 500 ms");
  });
});
