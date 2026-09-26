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

import { RAINBOW_COLUMNS } from "./csvDialect";
import { glassBoost } from "./windowGlass";

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
  /**
   * The terminal's sixteen colours, in xterm's order — black, red, green, yellow, blue, magenta,
   * cyan, white, then the bright eight: the `terminal.ansi*` values of the scheme's published VS Code
   * theme. Absent where that theme names none, and then the terminal draws what VS Code does with
   * it — VS Code's own defaults (`terminalTheme`).
   */
  ansi?: readonly string[];
}

export const DARK_THEMES: CodeTheme[] = [
  {
    id: "codeflow-dark",
    name: "CodeFlow Dark",
    mode: "dark",
    // "Nocturno": ink neutrals with a slight indigo bias. `bg` is the frame the navigation sits on and
    // `surface` the sheet the work sits on — see the note atop `index.css`.
    ui: {
      bg: "#0b0c11",
      surface: "#121319",
      surfaceRaised: "#191a23",
      border: "#252733",
      text: "#e8e9f1",
      textMuted: "#a1a4b5",
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
    // Terminal: CodeFlow's own — the app's danger, success, warning, blue, violet and teal, and their
    // 300s for the bright eight.
    ansi: [
      "#252733", "#f87171", "#4ade80", "#fbbf24", "#60a5fa", "#c084fc", "#2dd4bf", "#a1a4b5",
      "#6b7280", "#fca5a5", "#86efac", "#fcd34d", "#93c5fd", "#d8b4fe", "#5eead4", "#e8e9f1",
    ],
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
    // Terminal: as published in Dracula Theme.
    ansi: [
      "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
      "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
    ],
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
    // Terminal: as published in VS Code's built-in Monokai.
    ansi: [
      "#333333", "#c4265e", "#86b42b", "#b3b42b", "#6a7ec8", "#8c6bc8", "#56adbc", "#e3e3dd",
      "#666666", "#f92672", "#a6e22e", "#e2e22e", "#819aff", "#ae81ff", "#66d9ef", "#f8f8f2",
    ],
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
    // Terminal: as published in One Dark Pro.
    ansi: [
      "#3f4451", "#e05561", "#8cc265", "#d18f52", "#4aa5f0", "#c162de", "#42b3c2", "#d7dae0",
      "#4f5666", "#ff616e", "#a5e075", "#f0a45d", "#4dc4ff", "#de73ff", "#4cd1e0", "#e6e6e6",
    ],
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
    // No `ansi`: the published VS Code port names no terminal colours, so the terminal takes VS Code's
    // defaults, as VS Code does.
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
    // Terminal: as published in Nord.
    ansi: [
      "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
    ],
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
    // Terminal: as published in Tokyo Night.
    ansi: [
      "#363b54", "#f7768e", "#73daca", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#787c99",
      "#363b54", "#f7768e", "#73daca", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#acb0d0",
    ],
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
    // Terminal: as published in Gruvbox Dark Medium.
    ansi: [
      "#3c3836", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
      "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
    ],
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
    // Terminal: as published in GitHub Dark Default.
    ansi: [
      "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
      "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
    ],
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
    // Terminal: as published in Night Owl.
    ansi: [
      "#011627", "#ef5350", "#22da6e", "#c5e478", "#82aaff", "#c792ea", "#21c7a8", "#ffffff",
      "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff",
    ],
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
    // Terminal: as published in Catppuccin Mocha.
    ansi: [
      "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
      "#585b70", "#f37799", "#89d88b", "#ebd391", "#74a8fc", "#f2aede", "#6bd7ca", "#bac2de",
    ],
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    mode: "dark",
    // Solarized Light's sixteen colours with the base tones swapped for their dark twins — that
    // symmetry is the scheme — so the accents below are the light entry's, role for role, and only
    // the comment tone moves (base01 here, base1 there).
    ui: {
      bg: "#002b36",
      surface: "#00212b",
      surfaceRaised: "#073642",
      border: "#004052",
      text: "#93a1a1",
      // base0, the scheme's body text, not the base01 its comments use: base01 sits at 2.8:1 on this
      // background — the light entry's reason for base00, mirrored.
      textMuted: "#839496",
    },
    tokens: {
      comment: "#586e75",
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
    // Terminal: as published in VS Code's built-in Solarized Dark.
    ansi: [
      "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  },
];

export const LIGHT_THEMES: CodeTheme[] = [
  {
    id: "codeflow-light",
    name: "CodeFlow Light",
    mode: "light",
    // "Papel": a grey frame around white sheets, so the two read apart without extra borders.
    ui: {
      bg: "#ebebf0",
      surface: "#ffffff",
      surfaceRaised: "#ffffff",
      border: "#e1e2e9",
      text: "#15161d",
      textMuted: "#545767",
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
    // Terminal: CodeFlow's own — the app's danger, success, warning, blue, violet and teal, and a step
    // lighter for the bright eight.
    ansi: [
      "#15161d", "#dc2626", "#15803d", "#b45309", "#2563eb", "#9333ea", "#0f766e", "#545767",
      "#6b7280", "#ef4444", "#16a34a", "#d97706", "#3b82f6", "#a855f7", "#0d9488", "#9ca3af",
    ],
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
    // Terminal: as published in GitHub Light Default.
    ansi: [
      "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
      "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
    ],
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
    // No `ansi`: Atom One Light names no terminal colours, so the terminal takes VS Code's
    // defaults, as VS Code does.
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
    // Terminal: as published in VS Code's built-in Solarized Light.
    ansi: [
      "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
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
    // Terminal: as published in Gruvbox Light Medium.
    ansi: [
      "#ebdbb2", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64",
      "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836",
    ],
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
    // Terminal: as published in Catppuccin Latte.
    ansi: [
      "#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
      "#6c6f85", "#de293e", "#49af3d", "#eea02d", "#456eff", "#fe85d8", "#2d9fa8", "#bcc0cc",
    ],
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
    // No `ansi`: VS Code's built-in Quiet Light names no terminal colours, so the terminal takes VS Code's
    // defaults, as VS Code does.
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
    // No `ansi`: no Xcode port names a full set of terminal colours, so the terminal takes VS Code's
    // defaults, as VS Code does.
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
    // Terminal: as published in Tokyo Night Light.
    ansi: [
      "#343b58", "#8c4351", "#33635c", "#8f5e15", "#2959aa", "#7b43ba", "#006c86", "#707280",
      "#343b58", "#8c4351", "#33635c", "#8f5e15", "#2959aa", "#7b43ba", "#006c86", "#707280",
    ],
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
    // Terminal: as published in Ayu Light.
    ansi: [
      "#000000", "#f06b6c", "#6cbf43", "#e7a100", "#21a1e2", "#a176cb", "#4abc96", "#c7c7c7",
      "#686868", "#f07171", "#86b300", "#eba400", "#22a4e6", "#a37acc", "#4cbf99", "#d1d1d1",
    ],
  },
  {
    id: "night-owl-light",
    name: "Night Owl Light",
    mode: "light",
    ui: {
      bg: "#fbfbfb",
      surface: "#f0f0f0",
      surfaceRaised: "#f6f6f6",
      border: "#d9d9d9",
      text: "#403f53",
      // Not the scheme's line-number grey (#90a7b2): that is 2.4:1 on this background — fine in a
      // gutter, too faint for every muted label in the app. This slate is Night Owl's too (a
      // signature's commas) and reads at 4.1:1.
      textMuted: "#5f7e97",
    },
    tokens: {
      comment: "#989fb1",
      keyword: "#994cc3",
      // The quoted-string colour, which is nearly every string in a file; the scheme gives only bare
      // `string` scopes (template literals) its function blue.
      string: "#c96765",
      number: "#aa0982",
      fn: "#4876d6",
      type: "#111111",
      variable: "#403f53",
      constant: "#aa0982",
      operator: "#994cc3",
      tag: "#994cc3",
      attribute: "#4876d6",
    },
    // Terminal: as published in Night Owl Light.
    ansi: [
      "#403f53", "#de3d3b", "#08916a", "#e0af02", "#288ed7", "#d6438a", "#2aa298", "#93a1a1",
      "#403f53", "#de3d3b", "#08916a", "#daaa01", "#288ed7", "#d6438a", "#2aa298", "#93a1a1",
    ],
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    mode: "light",
    // Rosé Pine's own layering: `base` for the frame, and the lighter `surface` for the panels, menus
    // and widgets that sit on it.
    ui: {
      bg: "#faf4ed",
      surface: "#fffaf3",
      surfaceRaised: "#fffaf3",
      // Highlight Med, the scheme's selection tone, as its published solid colour. Rosé Pine's own
      // theme files paint it as a translucent overlay (`#6e6a8614`), which can't go here:
      // `monacoSetup` appends an alpha of its own to this value.
      border: "#dfdad9",
      text: "#575279",
      textMuted: "#797593",
    },
    tokens: {
      comment: "#9893a5",
      keyword: "#286983",
      string: "#ea9d34",
      number: "#d7827e",
      fn: "#d7827e",
      type: "#56949f",
      variable: "#575279",
      constant: "#d7827e",
      operator: "#286983",
      tag: "#56949f",
      attribute: "#907aa9",
    },
    // Terminal: as published in Rosé Pine Dawn.
    ansi: [
      "#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
      "#797593", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
    ],
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
 * `vs`/`vs-dark` themes. `glass` is the same scheme with its backgrounds cleared, for a window that
 * is see-through (`lib/windowGlass`) — see `monacoSetup`, which registers both. */
export function monacoThemeName(id: string, glass = false): string {
  return glass ? `cf-${id}-glass` : `cf-${id}`;
}

export interface TokenRule {
  /** Monaco token scope, e.g. `keyword` or `attribute.value`. `""` is the catch-all. */
  token: string;
  /** Hex with the `#`. Monaco wants it bare, so `monacoSetup` strips it; the code-snapshot
   * renderer paints with it directly. */
  foreground: string;
  fontStyle?: "italic";
}

/**
 * The colours a delimited file's columns cycle through in this scheme — `RAINBOW_COLUMNS` of them.
 *
 * Taken from the scheme's own palette rather than from a rainbow of our choosing, which is what the
 * Rainbow CSV extension does too: the columns then look like they belong to the theme the user
 * picked, and every colour is one the theme's author already made readable on its background. The
 * first column is the plain text colour, as it is there.
 *
 * Nine of the shipped schemes have only six distinct token colours, and five more have seven. The gap
 * is filled with the comment colour in the fourth slot (Rainbow CSV's own fourth column is its
 * comment scope) and, after that, even mixes of two neighbouring palette colours — colours the theme
 * does not name but is made of, so they sit in it and stay readable on its background.
 *
 * The one colour no column may take is the muted text colour: it is what the separators are
 * painted in (`delimiter`), and a column wearing it vanishes into them. GitHub Dark's comments are
 * exactly that grey, which is why it is excluded up front rather than trusted to differ.
 */
export function rainbowPalette(theme: CodeTheme): string[] {
  const t = theme.tokens;
  const seen = new Set<string>([theme.ui.textMuted.toLowerCase()]);
  const distinct = (colors: string[]) =>
    colors.filter((color) => {
      const key = color.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const vivid = distinct([
    t.variable,
    t.keyword,
    t.string,
    t.fn,
    t.number,
    t.type,
    t.tag,
    t.attribute,
    t.operator,
    t.constant,
  ]);
  const palette = vivid.slice(0, RAINBOW_COLUMNS);
  const blends = [
    [1, 2],
    [3, 4],
    [2, 5],
    [4, 1],
  ]
    .filter(([a, b]) => vivid[a] && vivid[b])
    .map(([a, b]) => mixHex(vivid[a], vivid[b]));
  const pads = distinct([t.comment, ...blends]);
  if (palette.length < RAINBOW_COLUMNS && pads.length > 0) palette.splice(3, 0, pads.shift()!);
  while (palette.length < RAINBOW_COLUMNS && pads.length > 0) palette.push(pads.shift()!);
  // Only reachable by a scheme far sparser than any shipped one: repeat from the start rather than
  // leave a slot to Monaco's fallback.
  for (let i = 0; palette.length < RAINBOW_COLUMNS; i += 1) palette.push(palette[i]);
  return palette;
}

/** The colour halfway between two `#rrggbb` colours. */
function mixHex(a: string, b: string): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16);
  const mixed = [0, 1, 2].map((at) => Math.round((channel(a, at) + channel(b, at)) / 2));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
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
    // `///` is a class's API documentation and `//` is usually code somebody switched off. In an
    // ObjectScript class those are opposite things, and the doc blocks are long enough that telling
    // them apart pays. `ui.textMuted` rather than a new palette role: it is brighter than `comment` in
    // every dark scheme and darker in every light one, so a doc block reads as *more* present than
    // dead code in both directions — without editing 24 palettes.
    { token: "comment.doc", foreground: theme.ui.textMuted, fontStyle: "italic" },
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
    // A delimited file's columns — see `rainbowPalette`, and `monacoCsv.ts` for the tokens.
    ...rainbowPalette(theme).map((foreground, index) => ({ token: `rainbow${index + 1}`, foreground })),
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
  // 15%, the same mix `index.css` declares — the two used to disagree (14% there, 18% here).
  root.setProperty("--cf-accent-soft", "color-mix(in oklab, var(--cf-accent) 15%, var(--cf-surface))");
  // How much thicker this scheme's see-through glass is painted; read only while it is on.
  root.setProperty("--cf-glass-boost", `${glassBoost(theme)}%`);
}
