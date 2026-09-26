import { describe, expect, it } from "vitest";
import { ALL_THEMES, DARK_THEMES, LIGHT_THEMES, findTheme, themesFor } from "./codeThemes";

describe("the shipped schemes", () => {
  // `monacoSetup` appends an alpha of its own to `border` and `surfaceRaised` (`${border}cc`), so a
  // value that already carries one — Rosé Pine and Night Owl publish several that way — becomes a
  // ten-digit colour Monaco cannot parse, and `Color.fromHex` paints what it cannot parse red: the
  // selection and the scrollbar, in every file.
  it("write every colour as an opaque #rrggbb", () => {
    for (const theme of ALL_THEMES) {
      for (const [role, color] of Object.entries({ ...theme.ui, ...theme.tokens })) {
        expect(color, `${theme.id}.${role}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      (theme.ansi ?? []).forEach((color, i) => expect(color, `${theme.id}.ansi[${i}]`).toMatch(/^#[0-9a-f]{6}$/i));
    }
  });

  // xterm reads the sixteen by position; a short list would shift every colour after the gap.
  it("give the terminal all sixteen colours or none", () => {
    for (const theme of ALL_THEMES) {
      if (theme.ansi) expect(theme.ansi, theme.id).toHaveLength(16);
    }
  });

  // An id is also the Monaco theme's name (`cf-<id>`), and `findTheme` only looks in the list of the
  // mode it is asked for, falling back to that list's first entry: a duplicate id, or a scheme filed
  // under the other mode, would quietly put the user back on the default.
  it("have unique ids, each in the list of its own mode", () => {
    expect(new Set(ALL_THEMES.map((theme) => theme.id)).size).toBe(ALL_THEMES.length);
    for (const theme of DARK_THEMES) expect(theme.mode, theme.id).toBe("dark");
    for (const theme of LIGHT_THEMES) expect(theme.mode, theme.id).toBe("light");
    for (const theme of ALL_THEMES) {
      expect(themesFor(theme.mode), theme.id).toContain(theme);
      expect(findTheme(theme.id, theme.mode), theme.id).toBe(theme);
    }
  });
});
