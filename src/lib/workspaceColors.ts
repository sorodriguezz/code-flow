/**
 * The colours a workspace or a project can be given.
 *
 * **Its own palette rather than the accent's eight.** The accent is one colour applied to the whole
 * window, so eight is generous — you pick once. These are *identity* colours: every workspace and
 * every project in it carries one, and the only job the colour has is telling two rows apart at a
 * glance. A user with fifteen repositories under three workspaces ran out of distinguishable
 * options at the eighth, which is the whole reason this list exists.
 *
 * **One hex has to work on both themes, so the middle of the range is all there is.** The colour is
 * stored as a single value and drawn on the app's chrome in whichever theme is on — a dot in the
 * sidebar over `--cf-surface`, a tinted glyph in Settings, a wash behind the workspace menu's tile.
 * Light surfaces run near white and dark ones near `#16161d`, so a pastel disappears on one and a
 * near-black on the other. Everything below sits around 55–70% lightness, which is the band that
 * reads on both — the same band the editor themes draw their own syntax colours from, which is what
 * keeps a workspace dot from looking foreign beside Dracula or Solarized Light.
 *
 * **No pure black or white**, for that reason and no other: each is invisible on exactly one of the
 * two themes, and a colour you cannot see on half your screens is not a choice. The greys at the
 * end are what "neutral" means here — they hold their own against both.
 *
 * **Ordered by hue**, which is what makes the grid scannable: the popover lays them out six to a
 * row, so each row is a band of the spectrum rather than a bag of colours.
 *
 * The eight colours the accent offers are all in here, deliberately. They are what every workspace
 * created before this list existed is set to, and leaving one out would show its owner a palette
 * with nothing selected in it.
 */
export const WORKSPACE_COLORS: string[] = [
  // Reds and oranges
  "#f43f5e",
  "#e11d48",
  "#ef4444",
  "#b91c1c",
  "#f97316",
  "#c2410c",
  // Yellows and greens
  "#f59e0b",
  "#d97706",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#16a34a",
  // Greens and teals
  "#10b981",
  "#047857",
  "#14b8a6",
  "#0d9488",
  "#06b6d4",
  "#0e7490",
  // Blues
  "#0ea5e9",
  "#3b82f6",
  "#1d4ed8",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  // Purples, pinks, and the neutrals
  "#9333ea",
  "#d946ef",
  "#ec4899",
  "#be185d",
  "#64748b",
  "#78716c",
];

/** What a workspace or project is given when nobody picked anything. The app's own indigo, which is
 * also the accent's default — a new row looks like it belongs to the app until it is told not to. */
export const DEFAULT_WORKSPACE_COLOR = "#6366f1";
