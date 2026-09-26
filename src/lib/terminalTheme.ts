import type { ITheme } from "@xterm/xterm";
import type { CodeTheme } from "./codeThemes";

/**
 * VS Code's own terminal colours, in xterm's order — what VS Code draws for a theme that names
 * none, so a scheme without `ansi` looks here exactly as it does there. `terminalColorRegistry.ts`,
 * checked 2026-09-26.
 */
export const VSCODE_ANSI = {
  dark: [
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
  ],
  light: [
    "#000000", "#cd3131", "#107c10", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
    "#666666", "#f14c4c", "#14ce14", "#b5ba00", "#3b8eea", "#d670d6", "#29b8db", "#a5a5a5",
  ],
} as const;

/** xterm's names for the sixteen, in the order `ansi` lists them. */
const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/**
 * The selection wash, spelled out rather than left to xterm.
 *
 * xterm does ship a default, and it is the reason this looked *almost* right: a flat white at 30%
 * over the old `#1e1e27`. Against a terminal whose whole point is coloured text it reads as a smear
 * rather than as a highlight, and on a light scheme the same rule washes out to near-nothing. Worse,
 * `selectionInactiveBackground` defaults dimmer still, and a pane loses focus constantly — the dock's
 * own tab strip takes it, so does the editor — which is how "I selected something and see nothing"
 * happens even where the active colour would have shown.
 *
 * The same value active and inactive: what is selected does not stop being selected because you
 * looked at something else. No `selectionForeground`, deliberately — pinning one would flatten the
 * ANSI colours underneath, and the colours are the information. Translucent, so it also reads over
 * a see-through ground.
 */
const SELECTION = { light: "#3b82f659", dark: "#60a5fa66" } as const;

/**
 * The terminal painted in the scheme on screen: its ground, its text and its sixteen colours.
 *
 * The ground is the editor's (`ui.bg`, what Monaco paints), so a shell reads as the same material as
 * code. In a see-through window it is cleared, as the editor's is, and the sheet's glass shows
 * through; `allowTransparency` must be on for xterm to honour that. The cursor's accent — the glyph
 * drawn inside a block cursor — stays the solid ground either way, or it would vanish into the glass.
 */
export function terminalTheme(scheme: CodeTheme, glass: boolean): ITheme {
  const ansi = scheme.ansi ?? VSCODE_ANSI[scheme.mode];
  const selection = SELECTION[scheme.mode];
  const theme: ITheme = {
    background: glass ? "#00000000" : scheme.ui.bg,
    foreground: scheme.ui.text,
    cursor: scheme.ui.text,
    cursorAccent: scheme.ui.bg,
    selectionBackground: selection,
    selectionInactiveBackground: selection,
  };
  ANSI_NAMES.forEach((name, i) => {
    theme[name] = ansi[i];
  });
  return theme;
}
