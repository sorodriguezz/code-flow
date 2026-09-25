import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read as a file: `?raw` CSS imports are empty under vitest.
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("\n}", at));
}

describe("text selection", () => {
  // WKWebView reads only the prefixed property and the dev server does not add it, so the plain one
  // alone left every label on macOS selectable by a drag or ⌘A.
  it("turns it off app-wide in both spellings", () => {
    const body = rule("body");
    expect(body).toContain("-webkit-user-select: none;");
    expect(body).toMatch(/\n\s+user-select: none;/);
  });

  it("gives it back to what was typed", () => {
    const fields = rule('input,\ntextarea,\n[contenteditable]:not([contenteditable="false"])');
    expect(fields).toContain("-webkit-user-select: text;");
    expect(fields).toMatch(/\n\s+user-select: text;/);
  });
});

describe("control fills", () => {
  // Outside a see-through window the aliases must be the tokens themselves, or every button in the
  // app would change colour for people who never turned the glass on.
  it("alias their tokens", () => {
    const root = rule(":root");
    expect(root).toContain("--cf-control: var(--cf-surface);");
    expect(root).toContain("--cf-accent-fill: var(--cf-accent);");
    expect(root).toContain("--cf-danger-fill: var(--cf-danger);");
  });

  it("stay solid on whatever floats in a see-through window", () => {
    const at = css.indexOf(':is(.fixed, [role="dialog"], [role="menu"], [aria-modal="true"])');
    expect(at).toBeGreaterThanOrEqual(0);
    const restore = css.slice(at, css.indexOf("\n}", at));
    for (const declaration of [
      "--cf-surface: var(--cf-surface-solid);",
      "--cf-surface-raised: var(--cf-surface-raised-solid);",
      "--cf-field: var(--cf-field-solid);",
      "--cf-control: var(--cf-surface-solid);",
      "--cf-accent-fill: var(--cf-accent);",
      "--cf-danger-fill: var(--cf-danger);",
    ]) {
      expect(restore).toContain(declaration);
    }
  });
});
