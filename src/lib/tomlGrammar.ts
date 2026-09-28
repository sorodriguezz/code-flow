import type { languages } from "monaco-editor";

/**
 * TOML, for Monaco — which ships no grammar for it, so `Cargo.toml` and `pyproject.toml` opened as
 * a language id nothing had registered and were drawn as plain text.
 *
 * Its own module, fetched by `monacoToml` the first time a TOML file is opened: most sessions never
 * open one, and the id alone is what has to exist up front.
 *
 * The patterns are exported and named so the test can hold them to the spec's own examples; the
 * grammar is only their arrangement.
 */

/** `key`, `"quoted key"`, `'literal key'`, and dotted runs of them — only when an `=` follows. */
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
export const TOML_KEY = new RegExp(`${KEY_PART}(?:\\s*\\.\\s*${KEY_PART})*(?=\\s*=)`);

/** A date, a local time, or both — `1979-05-27`, `07:32:00.999`, `1979-05-27T07:32:00-08:00`. */
export const TOML_DATETIME =
  /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?/;

/** Floats need a fraction or an exponent; anything else that looks numeric is an integer. */
export const TOML_FLOAT = /[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|[eE][+-]?\d(?:_?\d)*)/;
export const TOML_INTEGER = /0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|[+-]?(?:0|[1-9](?:_?\d)*)/;
export const TOML_SPECIAL_FLOAT = /[+-]?(?:inf|nan)\b/;

/** `[table]` and `[[array.of.tables]]`, which only ever open a line. */
export const TOML_TABLE = /^\s*(?:\[\[[^\]]*\]\]|\[[^\]]*\])/;

export const TOML_CONFIG: languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/**
 * Keys are `attribute.name` and table headers `type`, so the two things a manifest is read by — which
 * section, which setting — take the palette's two most distinct colours. The header rule comes
 * first and is anchored with `^`, which Monarch reads as "only at the start of a line": that is what
 * tells `[dependencies]` apart from the array in `features = ["full"]`, and it has to run before
 * the whitespace rule or an indented header would lose its line start to it.
 */
export const TOML_GRAMMAR: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".toml",
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.square" },
  ],
  tokenizer: {
    root: [
      [TOML_TABLE, "type"],
      [/[ \t\r\n]+/, ""],
      [/#.*$/, "comment"],
      [TOML_KEY, "attribute.name"],
      [/=/, "operator"],
      [/"""/, "string", "@multiBasic"],
      [/'''/, "string", "@multiLiteral"],
      [/"/, "string", "@basic"],
      [/'[^']*'/, "string"],
      [TOML_DATETIME, "number.date"],
      [TOML_FLOAT, "number.float"],
      [TOML_SPECIAL_FLOAT, "number.float"],
      [TOML_INTEGER, "number"],
      [/\b(?:true|false)\b/, "keyword"],
      [/[{}[\]]/, "@brackets"],
      [/[,.]/, "delimiter"],
    ],
    basic: [
      [/[^\\"]+/, "string"],
      [/\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, "string", "@pop"],
    ],
    multiBasic: [
      [/"""/, "string", "@pop"],
      [/[^\\"]+/, "string"],
      [/\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/, "string.escape"],
      // A backslash that ends a line trims the break, which makes it an escape too.
      [/\\\s*$/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, "string"],
    ],
    multiLiteral: [
      [/'''/, "string", "@pop"],
      [/[^']+/, "string"],
      [/'/, "string"],
    ],
  },
};
