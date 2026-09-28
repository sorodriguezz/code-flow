import { describe, expect, it } from "vitest";
import {
  TOML_DATETIME,
  TOML_FLOAT,
  TOML_GRAMMAR,
  TOML_INTEGER,
  TOML_KEY,
  TOML_SPECIAL_FLOAT,
  TOML_TABLE,
} from "./tomlGrammar";

/** What Monarch does with a rule's pattern: match it anchored at the current position. */
const whole = (pattern: RegExp, text: string) => new RegExp(`^(?:${pattern.source})`).exec(text)?.[0] ?? null;

describe("the TOML grammar's patterns", () => {
  it("reads bare, quoted and dotted keys, and only in front of an `=`", () => {
    expect(whole(TOML_KEY, "name = \"x\"")).toBe("name");
    expect(whole(TOML_KEY, "serde-json.version = \"1\"")).toBe("serde-json.version");
    expect(whole(TOML_KEY, '"quoted key" = 1')).toBe('"quoted key"');
    expect(whole(TOML_KEY, "site.'google.com' = true")).toBe("site.'google.com'");
    expect(whole(TOML_KEY, "true")).toBeNull();
  });

  it("reads the spec's dates and times whole", () => {
    for (const value of [
      "1979-05-27T07:32:00Z",
      "1979-05-27T00:32:00.999999-07:00",
      "1979-05-27 07:32:00Z",
      "1979-05-27",
      "07:32:00",
      "00:32:00.999999",
    ]) {
      expect(whole(TOML_DATETIME, value)).toBe(value);
    }
  });

  it("tells floats from integers", () => {
    for (const value of ["+1.0", "3.1415", "-0.01", "5e+22", "1e06", "-2E-2", "6.626e-34", "224_617.445_991"]) {
      expect(whole(TOML_FLOAT, value)).toBe(value);
    }
    expect(whole(TOML_FLOAT, "42")).toBeNull();
    for (const value of ["+99", "42", "0", "-17", "1_000", "0xDEAD_BEEF", "0o755", "0b1101_0110"]) {
      expect(whole(TOML_INTEGER, value)).toBe(value);
    }
    expect(whole(TOML_SPECIAL_FLOAT, "-inf")).toBe("-inf");
    expect(whole(TOML_SPECIAL_FLOAT, "nan")).toBe("nan");
  });

  it("reads table headers, indented or not, and nothing else", () => {
    expect(whole(TOML_TABLE, "[dependencies]")).toBe("[dependencies]");
    expect(whole(TOML_TABLE, "  [target.'cfg(unix)'.dependencies]")).toBe("  [target.'cfg(unix)'.dependencies]");
    expect(whole(TOML_TABLE, "[[bin]]")).toBe("[[bin]]");
    // Monarch honours the `^` only at the start of a line, which is what keeps an array value out.
    expect(TOML_TABLE.source.startsWith("^")).toBe(true);
  });

  it("puts the header rule ahead of the whitespace rule", () => {
    const root = (TOML_GRAMMAR.tokenizer as Record<string, unknown[][]>).root;
    expect(root[0][0]).toBe(TOML_TABLE);
    expect(TOML_GRAMMAR.tokenPostfix).toBe(".toml");
  });
});
