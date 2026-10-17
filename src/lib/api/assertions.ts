/**
 * The no-code checks («Asserts») — rows like `status = 200` or `$.id existe` — evaluated against a
 * response into the same `TestResult`s a `pm.test` produces, so the Tests tab, the runner and a
 * flow's answer report both kinds side by side.
 *
 * Pure and synchronous: no sandbox, nothing executed. A row is data, which is why these need no
 * trust question the way a script does.
 */

import type { ApiAssertion, AssertionOperator, AssertionSource, HttpResponse, TestResult } from "../../types/api";
import { translate } from "../../state/languageStore";
import { deepEqual, JsonPathError, normalizePath, selectJsonPath } from "./jsonPath";

export const ASSERTION_SOURCES: AssertionSource[] = ["status", "time", "size", "header", "body", "jsonpath"];

export const ASSERTION_OPERATORS: AssertionOperator[] = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "notContains",
  "exists",
  "notExists",
  "matches",
  "isType",
];

/** The operators that compare against nothing. */
export const UNARY_OPERATORS: AssertionOperator[] = ["exists", "notExists"];

/** How an operator reads in a test's name — symbols, so the name is the same in every language. */
const OPERATOR_SYMBOL: Record<AssertionOperator, string> = {
  eq: "==",
  neq: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  contains: "contains",
  notContains: "!contains",
  exists: "exists",
  notExists: "!exists",
  matches: "matches",
  isType: "is",
};

export function newAssertion(id: string, source: AssertionSource = "status"): ApiAssertion {
  return {
    id,
    enabled: true,
    source,
    property: source === "jsonpath" ? "$." : "",
    operator: source === "time" || source === "size" ? "lt" : "eq",
    expected: source === "status" ? "200" : "",
  };
}

/** What a row is called in the results: `status == 200`, `$.data.id exists`. */
export function assertionName(assertion: ApiAssertion): string {
  const subject =
    assertion.source === "jsonpath"
      ? normalizePath(assertion.property || "$")
      : assertion.source === "header"
        ? `header ${assertion.property}`
        : assertion.source;
  const operator = OPERATOR_SYMBOL[assertion.operator];
  if (UNARY_OPERATORS.includes(assertion.operator)) return `${subject} ${operator}`;
  const unit = assertion.source === "time" ? " ms" : assertion.source === "size" ? " B" : "";
  return `${subject} ${operator} ${assertion.expected}${unit}`;
}

/** Every enabled row, in order, as test results. */
export function evaluateAssertions(assertions: ApiAssertion[] | undefined, response: HttpResponse): TestResult[] {
  const rows = (assertions ?? []).filter((row) => row.enabled && isComplete(row));
  if (rows.length === 0) return [];
  // The body is parsed once for every JSONPath row, and only when one asks.
  let parsed: { ok: true; value: unknown } | { ok: false } | null = null;
  const json = () => {
    if (parsed === null) {
      try {
        parsed = { ok: true, value: JSON.parse(response.body_text) };
      } catch {
        parsed = { ok: false };
      }
    }
    return parsed;
  };
  return rows.map((row) => {
    const started = performance.now();
    let error: string | null;
    try {
      error = check(row, response, json);
    } catch (e) {
      error = e instanceof JsonPathError ? e.message : String(e);
    }
    return { name: assertionName(row), passed: error === null, error, duration_ms: performance.now() - started };
  });
}

/** A row still being typed is skipped rather than failed: a header row with no name asserts nothing. */
function isComplete(row: ApiAssertion): boolean {
  if ((row.source === "header" || row.source === "jsonpath") && row.property.trim() === "") return false;
  if (!UNARY_OPERATORS.includes(row.operator) && row.expected.trim() === "" && row.operator !== "eq" && row.operator !== "neq") {
    return false;
  }
  return true;
}

/** `null` when the row holds, otherwise why not. */
function check(
  row: ApiAssertion,
  response: HttpResponse,
  json: () => { ok: true; value: unknown } | { ok: false },
): string | null {
  let actual: unknown;
  switch (row.source) {
    case "status":
      actual = response.status;
      break;
    case "time":
      actual = response.duration_ms;
      break;
    case "size":
      actual = response.size_bytes;
      break;
    case "header": {
      const wanted = row.property.trim().toLowerCase();
      actual = response.headers.find(([name]) => name.toLowerCase() === wanted)?.[1];
      break;
    }
    case "body":
      actual = response.body_text;
      break;
    case "jsonpath": {
      const body = json();
      if (!body.ok) return translate("api.assert.err.notJson");
      actual = selectJsonPath(body.value, row.property);
      break;
    }
  }
  return compare(row.operator, actual, row.expected);
}

function compare(operator: AssertionOperator, actual: unknown, expectedText: string): string | null {
  const shown = describe(actual);
  switch (operator) {
    case "exists":
      return actual === undefined ? translate("api.assert.err.missing") : null;
    case "notExists":
      return actual === undefined ? null : translate("api.assert.err.present", { actual: shown });
    case "eq":
      return equals(actual, expectedText) ? null : translate("api.assert.err.expected", { expected: expectedText, actual: shown });
    case "neq":
      return equals(actual, expectedText) ? translate("api.assert.err.unexpected", { expected: expectedText }) : null;
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const left = toNumber(actual);
      const right = Number(expectedText.trim());
      if (left === null) return translate("api.assert.err.notNumber", { actual: shown });
      if (Number.isNaN(right)) return translate("api.assert.err.notNumber", { actual: expectedText });
      const holds =
        operator === "lt" ? left < right : operator === "lte" ? left <= right : operator === "gt" ? left > right : left >= right;
      return holds ? null : translate("api.assert.err.compare", { check: `${left} ${OPERATOR_SYMBOL[operator]} ${right}` });
    }
    case "contains":
    case "notContains": {
      const found = contains(actual, expectedText);
      if (found === null) return translate("api.assert.err.noContains", { actual: shown });
      if (operator === "contains") return found ? null : translate("api.assert.err.notContained", { actual: shown, expected: expectedText });
      return found ? translate("api.assert.err.contained", { actual: shown, expected: expectedText }) : null;
    }
    case "matches": {
      if (actual === undefined) return translate("api.assert.err.missing");
      let pattern: RegExp;
      try {
        pattern = new RegExp(expectedText);
      } catch (e) {
        return translate("api.assert.err.regex", { error: e instanceof Error ? e.message : String(e) });
      }
      const text = typeof actual === "string" ? actual : JSON.stringify(actual);
      return pattern.test(text) ? null : translate("api.assert.err.noMatch", { actual: shown, pattern: expectedText });
    }
    case "isType": {
      const wanted = expectedText.trim().toLowerCase();
      const kind = typeOf(actual);
      return kind === wanted ? null : translate("api.assert.err.type", { actual: kind, expected: wanted });
    }
  }
}

function equals(actual: unknown, expectedText: string): boolean {
  const trimmed = expectedText.trim();
  let expected: unknown = expectedText;
  try {
    expected = JSON.parse(trimmed);
  } catch {
    // Not JSON: compared as the text typed.
  }
  if (deepEqual(actual, expected)) return true;
  // A header or a body is text; `200` typed against "200" means the same thing.
  if (typeof actual === "string" && typeof expected !== "string") return actual === trimmed;
  if (typeof actual === "number" && typeof expected === "string") return String(actual) === trimmed;
  return false;
}

function contains(actual: unknown, needle: string): boolean | null {
  if (typeof actual === "string") return actual.includes(needle);
  if (Array.isArray(actual)) {
    let parsed: unknown = needle;
    try {
      parsed = JSON.parse(needle.trim());
    } catch {
      // Compared as text.
    }
    return actual.some((item) => deepEqual(item, parsed) || item === needle);
  }
  if (actual !== null && typeof actual === "object") return Object.prototype.hasOwnProperty.call(actual, needle);
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (Array.isArray(value)) return value.length;
  return null;
}

function typeOf(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function describe(value: unknown): string {
  if (value === undefined) return translate("api.assert.nothing");
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
