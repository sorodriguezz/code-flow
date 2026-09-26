import { describe, expect, it } from "vitest";
import { findTheme } from "./codeThemes";
import { terminalTheme, VSCODE_ANSI } from "./terminalTheme";

describe("terminalTheme", () => {
  it("wears the scheme's ground, text and published colours", () => {
    const dracula = findTheme("dracula", "dark");
    const theme = terminalTheme(dracula, false);
    expect(theme.background).toBe(dracula.ui.bg);
    expect(theme.foreground).toBe(dracula.ui.text);
    expect(theme.red).toBe("#ff5555");
    expect(theme.brightWhite).toBe("#ffffff");
  });

  // What VS Code draws for a theme that names no terminal colours — so the scheme looks the same here.
  it("falls back to VS Code's defaults for the scheme's mode", () => {
    const quiet = findTheme("quiet-light", "light");
    expect(quiet.ansi).toBeUndefined();
    const theme = terminalTheme(quiet, false);
    expect(theme.green).toBe(VSCODE_ANSI.light[2]);
    expect(theme.white).toBe(VSCODE_ANSI.light[7]);
  });

  // The glyph inside a block cursor is drawn in `cursorAccent`: cleared with the ground, it would vanish.
  it("clears the ground in a see-through window but keeps the cursor's glyph solid", () => {
    const scheme = findTheme("codeflow-dark", "dark");
    const theme = terminalTheme(scheme, true);
    expect(theme.background).toBe("#00000000");
    expect(theme.cursorAccent).toBe(scheme.ui.bg);
  });
});
