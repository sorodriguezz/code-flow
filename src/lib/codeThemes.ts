/** Color schemes for the app + editor.
 *
 * A theme is picked *per mode*: one for light, one for dark. Switching the app between light and
 * dark (or letting the system do it) then swaps to that mode's chosen scheme, instead of forcing
 * a single palette to work on both backgrounds — which is the reason Dracula and Solarized Light
 * both exist in the first place.
 *
 * Each scheme carries two things: the six surface/text colors the whole UI is painted with
 * (`ui`), and the token colors Monaco highlights code with (`tokens`). The accent color stays
 * the user's own choice from the accent picker, so a theme never silently overrides it.
 *
 * Palettes are the published values of each scheme, not approximations — the point of picking
 * "Monokai" is getting Monokai.
 */

export interface CodeThemeUi {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
}

export interface CodeThemeTokens {
  comment: string;
  keyword: string;
  string: string;
  number: string;
  fn: string;
  type: string;
  variable: string;
  constant: string;
  operator: string;
  tag: string;
  attribute: string;
}

export interface CodeTheme {
  id: string;
  name: string;
  mode: "light" | "dark";
  ui: CodeThemeUi;
  tokens: CodeThemeTokens;
}

export const DARK_THEMES: CodeTheme[] = [
  {
    id: "codeflow-dark",
    name: "CodeFlow Dark",
    mode: "dark",
    ui: {
      bg: "#16161d",
      surface: "#1e1e27",
      surfaceRaised: "#262632",
      border: "#313140",
      text: "#eceef5",
      textMuted: "#9797ab",
    },
    tokens: {
      comment: "#6b7280",
      keyword: "#c084fc",
      string: "#86efac",
      number: "#fbbf24",
      fn: "#7dd3fc",
      type: "#5eead4",
      variable: "#eceef5",
      constant: "#fbbf24",
      operator: "#f0abfc",
      tag: "#f87171",
      attribute: "#fbbf24",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    mode: "dark",
    ui: {
      bg: "#282a36",
      surface: "#21222c",
      surfaceRaised: "#343746",
      border: "#44475a",
      text: "#f8f8f2",
      textMuted: "#8b91b5",
    },
    tokens: {
      comment: "#6272a4",
      keyword: "#ff79c6",
      string: "#f1fa8c",
      number: "#bd93f9",
      fn: "#50fa7b",
      type: "#8be9fd",
      variable: "#f8f8f2",
      constant: "#bd93f9",
      operator: "#ff79c6",
      tag: "#ff79c6",
      attribute: "#50fa7b",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    mode: "dark",
    ui: {
      bg: "#272822",
      surface: "#22231c",
      surfaceRaised: "#33342a",
      border: "#49483e",
      text: "#f8f8f2",
      textMuted: "#a59f85",
    },
    tokens: {
      comment: "#75715e",
      keyword: "#f92672",
      string: "#e6db74",
      number: "#ae81ff",
      fn: "#a6e22e",
      type: "#66d9ef",
      variable: "#f8f8f2",
      constant: "#ae81ff",
      operator: "#f92672",
      tag: "#f92672",
      attribute: "#a6e22e",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    mode: "dark",
    ui: {
      bg: "#282c34",
      surface: "#21252b",
      surfaceRaised: "#2c313a",
      border: "#3e4451",
      text: "#abb2bf",
      textMuted: "#7f848e",
    },
    tokens: {
      comment: "#5c6370",
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      fn: "#61afef",
      type: "#e5c07b",
      variable: "#e06c75",
      constant: "#d19a66",
      operator: "#56b6c2",
      tag: "#e06c75",
      attribute: "#d19a66",
    },
  },
  {
    id: "darcula",
    name: "Darcula (JetBrains)",
    mode: "dark",
    ui: {
      bg: "#2b2b2b",
      surface: "#3c3f41",
      surfaceRaised: "#4e5254",
      border: "#555555",
      text: "#a9b7c6",
      textMuted: "#909090",
    },
    tokens: {
      comment: "#808080",
      keyword: "#cc7832",
      string: "#6a8759",
      number: "#6897bb",
      fn: "#ffc66d",
      type: "#a9b7c6",
      variable: "#9876aa",
      constant: "#9876aa",
      operator: "#a9b7c6",
      tag: "#e8bf6a",
      attribute: "#bababa",
    },
  },
  {
    id: "nord",
    name: "Nord",
    mode: "dark",
    ui: {
      bg: "#2e3440",
      surface: "#2b303b",
      surfaceRaised: "#3b4252",
      border: "#434c5e",
      text: "#d8dee9",
      textMuted: "#8b98b0",
    },
    tokens: {
      comment: "#616e88",
      keyword: "#81a1c1",
      string: "#a3be8c",
      number: "#b48ead",
      fn: "#88c0d0",
      type: "#8fbcbb",
      variable: "#d8dee9",
      constant: "#b48ead",
      operator: "#81a1c1",
      tag: "#81a1c1",
      attribute: "#8fbcbb",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "dark",
    ui: {
      bg: "#1a1b26",
      surface: "#16161e",
      surfaceRaised: "#24283b",
      border: "#2f3549",
      text: "#a9b1d6",
      textMuted: "#7982a9",
    },
    tokens: {
      comment: "#565f89",
      keyword: "#bb9af7",
      string: "#9ece6a",
      number: "#ff9e64",
      fn: "#7aa2f7",
      type: "#2ac3de",
      variable: "#c0caf5",
      constant: "#ff9e64",
      operator: "#89ddff",
      tag: "#f7768e",
      attribute: "#bb9af7",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    mode: "dark",
    ui: {
      bg: "#282828",
      surface: "#1d2021",
      surfaceRaised: "#3c3836",
      border: "#504945",
      text: "#ebdbb2",
      textMuted: "#a89984",
    },
    tokens: {
      comment: "#928374",
      keyword: "#fb4934",
      string: "#b8bb26",
      number: "#d3869b",
      fn: "#b8bb26",
      type: "#fabd2f",
      variable: "#ebdbb2",
      constant: "#d3869b",
      operator: "#8ec07c",
      tag: "#8ec07c",
      attribute: "#fabd2f",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    mode: "dark",
    ui: {
      bg: "#0d1117",
      surface: "#010409",
      surfaceRaised: "#161b22",
      border: "#30363d",
      text: "#c9d1d9",
      textMuted: "#8b949e",
    },
    tokens: {
      comment: "#8b949e",
      keyword: "#ff7b72",
      string: "#a5d6ff",
      number: "#79c0ff",
      fn: "#d2a8ff",
      type: "#ffa657",
      variable: "#c9d1d9",
      constant: "#79c0ff",
      operator: "#ff7b72",
      tag: "#7ee787",
      attribute: "#79c0ff",
    },
  },
  {
    id: "night-owl",
    name: "Night Owl",
    mode: "dark",
    ui: {
      bg: "#011627",
      surface: "#01111d",
      surfaceRaised: "#0b2942",
      border: "#1d3b53",
      text: "#d6deeb",
      textMuted: "#7e9cb8",
    },
    tokens: {
      comment: "#637777",
      keyword: "#c792ea",
      string: "#ecc48d",
      number: "#f78c6c",
      fn: "#82aaff",
      type: "#ffcb8b",
      variable: "#d6deeb",
      constant: "#f78c6c",
      operator: "#c792ea",
      tag: "#caece6",
      attribute: "#c5e478",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    mode: "dark",
    ui: {
      bg: "#1e1e2e",
      surface: "#181825",
      surfaceRaised: "#313244",
      border: "#45475a",
      text: "#cdd6f4",
      textMuted: "#9399b2",
    },
    tokens: {
      comment: "#6c7086",
      keyword: "#cba6f7",
      string: "#a6e3a1",
      number: "#fab387",
      fn: "#89b4fa",
      type: "#f9e2af",
      variable: "#cdd6f4",
      constant: "#fab387",
      operator: "#89dceb",
      tag: "#f38ba8",
      attribute: "#f9e2af",
    },
  },
];

export const LIGHT_THEMES: CodeTheme[] = [
  {
    id: "codeflow-light",
    name: "CodeFlow Light",
    mode: "light",
    ui: {
      bg: "#f7f7fb",
      surface: "#ffffff",
      surfaceRaised: "#ffffff",
      border: "#e7e7ef",
      text: "#1c1c26",
      textMuted: "#6b6b7d",
    },
    tokens: {
      comment: "#8a8a99",
      keyword: "#7c3aed",
      string: "#15803d",
      number: "#b45309",
      fn: "#0369a1",
      type: "#0f766e",
      variable: "#1c1c26",
      constant: "#b45309",
      operator: "#a21caf",
      tag: "#be123c",
      attribute: "#b45309",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    mode: "light",
    ui: {
      bg: "#ffffff",
      surface: "#f6f8fa",
      surfaceRaised: "#ffffff",
      border: "#d0d7de",
      text: "#24292f",
      textMuted: "#57606a",
    },
    tokens: {
      comment: "#6e7781",
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      fn: "#8250df",
      type: "#953800",
      variable: "#24292f",
      constant: "#0550ae",
      operator: "#cf222e",
      tag: "#116329",
      attribute: "#0550ae",
    },
  },
  {
    id: "one-light",
    name: "One Light",
    mode: "light",
    ui: {
      bg: "#fafafa",
      surface: "#f0f0f0",
      surfaceRaised: "#ffffff",
      border: "#dcdcdc",
      text: "#383a42",
      textMuted: "#8a8b91",
    },
    tokens: {
      comment: "#a0a1a7",
      keyword: "#a626a4",
      string: "#50a14f",
      number: "#986801",
      fn: "#4078f2",
      type: "#c18401",
      variable: "#e45649",
      constant: "#986801",
      operator: "#0184bc",
      tag: "#e45649",
      attribute: "#986801",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    mode: "light",
    ui: {
      bg: "#fdf6e3",
      surface: "#eee8d5",
      surfaceRaised: "#fdf6e3",
      border: "#d9d2c2",
      text: "#586e75",
      // base00, not the base1 the scheme uses for comments: this drives every muted label in the
      // app, and base1 on this background lands at 2.5:1 — fine for a comment you skim past,
      // not for UI text you have to read.
      textMuted: "#657b83",
    },
    tokens: {
      comment: "#93a1a1",
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      fn: "#268bd2",
      type: "#b58900",
      variable: "#268bd2",
      constant: "#cb4b16",
      operator: "#859900",
      tag: "#268bd2",
      attribute: "#b58900",
    },
  },
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    mode: "light",
    ui: {
      bg: "#fbf1c7",
      surface: "#f2e5bc",
      surfaceRaised: "#fbf1c7",
      border: "#d5c4a1",
      text: "#3c3836",
      textMuted: "#7c6f64",
    },
    tokens: {
      comment: "#928374",
      keyword: "#9d0006",
      string: "#79740e",
      number: "#8f3f71",
      fn: "#79740e",
      type: "#b57614",
      variable: "#3c3836",
      constant: "#8f3f71",
      operator: "#427b58",
      tag: "#427b58",
      attribute: "#b57614",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    mode: "light",
    ui: {
      bg: "#eff1f5",
      surface: "#e6e9ef",
      surfaceRaised: "#ffffff",
      border: "#ccd0da",
      text: "#4c4f69",
      textMuted: "#7c7f93",
    },
    tokens: {
      comment: "#9ca0b0",
      keyword: "#8839ef",
      string: "#40a02b",
      number: "#fe640b",
      fn: "#1e66f5",
      type: "#df8e1d",
      variable: "#4c4f69",
      constant: "#fe640b",
      operator: "#04a5e5",
      tag: "#d20f39",
      attribute: "#df8e1d",
    },
  },
  {
    id: "quiet-light",
    name: "Quiet Light",
    mode: "light",
    ui: {
      bg: "#f5f5f5",
      surface: "#ededed",
      surfaceRaised: "#ffffff",
      border: "#dcdcdc",
      text: "#333333",
      textMuted: "#777777",
    },
    tokens: {
      comment: "#aaaaaa",
      keyword: "#4b83cd",
      string: "#448c27",
      number: "#ab6526",
      fn: "#aa3731",
      type: "#7a3e9d",
      variable: "#333333",
      constant: "#ab6526",
      operator: "#777777",
      tag: "#91b3e0",
      attribute: "#8f9d6a",
    },
  },
  {
    id: "xcode-light",
    name: "Xcode Light",
    mode: "light",
    ui: {
      bg: "#ffffff",
      surface: "#f2f2f7",
      surfaceRaised: "#ffffff",
      border: "#d8d8dc",
      text: "#262626",
      textMuted: "#6c6c70",
    },
    tokens: {
      comment: "#5d6c79",
      keyword: "#ad3da4",
      string: "#d12f1b",
      number: "#272ad8",
      fn: "#4b21b0",
      type: "#3900a0",
      variable: "#262626",
      constant: "#272ad8",
      operator: "#262626",
      tag: "#ad3da4",
      attribute: "#805ea7",
    },
  },
  {
    id: "tokyo-night-light",
    name: "Tokyo Night Light",
    mode: "light",
    ui: {
      bg: "#d5d6db",
      surface: "#cbccd1",
      surfaceRaised: "#e1e2e7",
      border: "#b6b7bd",
      text: "#343b58",
      textMuted: "#6c6e75",
    },
    tokens: {
      comment: "#9699a3",
      keyword: "#5a4a78",
      string: "#385f0d",
      number: "#965027",
      fn: "#34548a",
      type: "#166775",
      variable: "#343b58",
      constant: "#965027",
      operator: "#006c86",
      tag: "#8c4351",
      attribute: "#5a4a78",
    },
  },
  {
    id: "ayu-light",
    name: "Ayu Light",
    mode: "light",
    ui: {
      bg: "#fcfcfc",
      surface: "#f3f4f5",
      surfaceRaised: "#ffffff",
      border: "#e0e2e4",
      text: "#5c6166",
      textMuted: "#8a9199",
    },
    tokens: {
      comment: "#abb0b6",
      keyword: "#fa8d3e",
      string: "#86b300",
      number: "#a37acc",
      fn: "#f2ae49",
      type: "#399ee6",
      variable: "#5c6166",
      constant: "#a37acc",
      operator: "#ed9366",
      tag: "#55b4d4",
      attribute: "#f2ae49",
    },
  },
];

export const ALL_THEMES = [...DARK_THEMES, ...LIGHT_THEMES];

export const DEFAULT_DARK_THEME = "codeflow-dark";
export const DEFAULT_LIGHT_THEME = "codeflow-light";

export function themesFor(mode: "light" | "dark"): CodeTheme[] {
  return mode === "dark" ? DARK_THEMES : LIGHT_THEMES;
}

export function findTheme(id: string, mode: "light" | "dark"): CodeTheme {
  const pool = themesFor(mode);
  return pool.find((t) => t.id === id) ?? pool[0];
}

/** Monaco's registered name for a scheme. Namespaced so it can't collide with the built-in
 * `vs`/`vs-dark` themes. */
export function monacoThemeName(id: string): string {
  return `cf-${id}`;
}

export interface TokenRule {
  /** Monaco token scope, e.g. `keyword` or `attribute.value`. `""` is the catch-all. */
  token: string;
  /** Hex with the `#`. Monaco wants it bare, so `monacoSetup` strips it; the code-snapshot
   * renderer paints with it directly. */
  foreground: string;
  fontStyle?: "italic";
}

/** How a scheme colours code, as scope→colour rules.
 *
 * Shared rather than inlined at the Monaco registration, because the code-snapshot renderer
 * paints tokens onto a canvas itself and has to reach the *same* conclusion Monaco does — a
 * snapshot whose colours don't match the editor it was taken from is a bug you can see. */
export function tokenRulesFor(theme: CodeTheme): TokenRule[] {
  return [
    { token: "", foreground: theme.tokens.variable },
    { token: "comment", foreground: theme.tokens.comment, fontStyle: "italic" },
    { token: "keyword", foreground: theme.tokens.keyword },
    { token: "keyword.json", foreground: theme.tokens.constant },
    { token: "string", foreground: theme.tokens.string },
    { token: "string.key", foreground: theme.tokens.variable },
    { token: "string.value", foreground: theme.tokens.string },
    { token: "number", foreground: theme.tokens.number },
    { token: "regexp", foreground: theme.tokens.string },
    { token: "type", foreground: theme.tokens.type },
    { token: "type.identifier", foreground: theme.tokens.type },
    { token: "constant", foreground: theme.tokens.constant },
    { token: "function", foreground: theme.tokens.fn },
    { token: "identifier", foreground: theme.tokens.variable },
    { token: "variable", foreground: theme.tokens.variable },
    { token: "variable.predefined", foreground: theme.tokens.constant },
    { token: "operator", foreground: theme.tokens.operator },
    { token: "delimiter", foreground: theme.ui.textMuted },
    { token: "tag", foreground: theme.tokens.tag },
    { token: "metatag", foreground: theme.tokens.tag },
    { token: "attribute.name", foreground: theme.tokens.attribute },
    { token: "attribute.value", foreground: theme.tokens.string },
    { token: "annotation", foreground: theme.tokens.attribute },
  ];
}

/** Resolves one of Monaco's token types (`keyword.ts`, `string.quoted.double.js`) to its colour,
 * the way Monaco's own theme service does: the rule whose scope is the longest dot-delimited
 * prefix of the type wins, and `""` catches everything else. */
export function resolveTokenRule(tokenType: string, rules: TokenRule[]): TokenRule {
  let best = rules.find((r) => r.token === "") ?? rules[0];
  for (const rule of rules) {
    if (rule.token === "") continue;
    const matches = tokenType === rule.token || tokenType.startsWith(`${rule.token}.`);
    if (matches && rule.token.length > best.token.length) best = rule;
  }
  return best;
}

/** Paints the app in this scheme by rewriting the CSS variables every component already reads.
 *
 * `--cf-accent` is deliberately not touched: the accent picker owns it, and a theme silently
 * replacing the user's chosen accent would make that setting look broken. `--cf-accent-soft` is
 * re-derived here, though, because it mixes the accent *into the surface* — and the surface is
 * exactly what just changed.
 */
export function applyThemeVars(theme: CodeTheme) {
  const root = document.documentElement.style;
  root.setProperty("--cf-bg", theme.ui.bg);
  root.setProperty("--cf-surface", theme.ui.surface);
  root.setProperty("--cf-surface-raised", theme.ui.surfaceRaised);
  root.setProperty("--cf-border", theme.ui.border);
  root.setProperty("--cf-text", theme.ui.text);
  root.setProperty("--cf-text-muted", theme.ui.textMuted);
  root.setProperty("--cf-accent-soft", "color-mix(in oklab, var(--cf-accent) 18%, var(--cf-surface))");
}
