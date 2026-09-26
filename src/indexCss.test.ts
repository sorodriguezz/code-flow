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

describe("see-through window", () => {
  /** The declarations of the rule that starts at `marker` (a piece of its selector). */
  function ruleAt(marker: string): string {
    const at = css.indexOf(marker);
    expect(at, `no rule containing ${marker}`).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("\n}", at));
  }

  // WKWebView only honoured the prefixed spelling until recently, and the dev server adds no
  // prefixes — the same trap as `user-select` above.
  it("blurs in both spellings wherever it blurs", () => {
    for (const marker of [
      ':is([class~="shadow-[var(--cf-shadow)]"], [class~="shadow-[var(--cf-shadow-modal)]"], .cf-tip):is(',
      ":is(.absolute, .sticky, .cf-pinned):is(",
      ".monaco-editor .sticky-widget {",
    ]) {
      const body = ruleAt(marker);
      expect(body, marker).toContain("-webkit-backdrop-filter: var(");
      expect(body, marker).toMatch(/\n\s+backdrop-filter: var\(/);
    }
  });

  // A floating panel is the one layer under what it holds: a card inside a dialog that painted the
  // panel's coat again would come out denser than the dialog around it.
  it("makes a floating panel the ground of what it holds", () => {
    const float = ruleAt(':is([class~="shadow-[var(--cf-shadow)]"], [class~="shadow-[var(--cf-shadow-modal)]"], .cf-tip):is(');
    expect(float).toContain("background: var(--cf-glass-float-fill);");
    expect(float).toContain("--cf-surface: transparent;");
    expect(float).toContain("--cf-field: color-mix(");
  });

  it("thickens every coat by the scheme's boost", () => {
    const root = rule(":root[data-glass]");
    for (const fill of ["frame", "sheet", "solo", "float", "pin"]) {
      const at = root.indexOf(`--cf-glass-${fill}-fill:`);
      expect(at, fill).toBeGreaterThanOrEqual(0);
      expect(root.slice(at, root.indexOf(";", at)), fill).toContain("var(--cf-glass-boost, 0%)");
    }
  });
});
