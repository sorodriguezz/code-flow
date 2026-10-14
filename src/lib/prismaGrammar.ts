import type { languages } from "monaco-editor";

/**
 * Prisma's schema language, for Monaco — which ships no grammar for it, so `schema.prisma` opened as
 * plain text: forty models in one colour.
 *
 * Its own module, fetched by `monacoPrisma` the first time a `.prisma` file opens, like
 * `tomlGrammar`: most sessions never open one.
 *
 * # What gets which colour
 *
 * The file is read the way the Prisma extension for VS Code paints it, in the token names the app's
 * themes already colour (`codeThemes.ts`):
 *
 * | Written                                           | Token             |
 * |---------------------------------------------------|-------------------|
 * | `model` `enum` `type` `view` `datasource` `generator` | `keyword`     |
 * | the block's name, and a field typed by a model    | `type.identifier` |
 * | `String` `Int` `DateTime`… (the scalars)          | `type`            |
 * | a field's name                                    | `variable`        |
 * | `@id` `@default` `@@index` `@db.VarChar`          | `annotation`      |
 * | `autoincrement()` `now()` `env()`                 | `function`        |
 * | `fields:` `references:` `onDelete:`, config keys  | `attribute.name`  |
 * | an enum's values, `Cascade`, `Desc`, `true`       | `constant`        |
 * | `?` and `[]` after a type                         | `operator`        |
 * | `///` (it ends up in the generated client)        | `comment.doc`     |
 *
 * # One state per kind of block
 *
 * The same word means different things in different blocks: in a model the first word of a line is
 * a field, in an enum it is a value, in a datasource it is a setting — and `type` is a keyword at
 * the top level but a perfectly ordinary field name inside a model (`type String`). So entering a
 * block switches to that block's state, and the field and value rules exist only there.
 *
 * Those two rules are anchored with `^`, which Monarch reads as "only at the start of a line", and
 * sit above the whitespace rule for the reason `tomlGrammar` gives: an indented line would lose its
 * line start to it.
 */

/** Prisma's scalar types. Anything else in a field's type position is a model, enum or composite. */
export const PRISMA_SCALARS = [
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "DateTime",
  "Json",
  "Bytes",
  "Unsupported",
];

/** The bare words an argument can be: referential actions, sort orders, index algorithms. */
export const PRISMA_CONSTANTS = [
  "true",
  "false",
  "null",
  "Cascade",
  "Restrict",
  "NoAction",
  "SetNull",
  "SetDefault",
  "Asc",
  "Desc",
  "BTree",
  "Hash",
  "Gist",
  "Gin",
  "SpGist",
  "Brin",
];

/** `model User {`, `enum Role {` — a block's keyword, its name and the brace that opens it. */
export const PRISMA_MODEL_HEAD = /(model|view|type)(\s+)([A-Za-z_]\w*)(\s*)(\{)/;
export const PRISMA_ENUM_HEAD = /(enum)(\s+)([A-Za-z_]\w*)(\s*)(\{)/;
export const PRISMA_CONFIG_HEAD = /(datasource|generator)(\s+)([A-Za-z_]\w*)(\s*)(\{)/;
/** A field: its name, then its type. Only at the start of a line inside a model. */
export const PRISMA_FIELD = /^(\s*)([A-Za-z_]\w*)(\s+)([A-Za-z_]\w*)/;
/**
 * `@id`, `@@index`, and native types — `@db.VarChar`.
 *
 * The `@` is written `[@]` on purpose. Monarch reads `@name` in a pattern as a reference to one of
 * the language's attributes and `@@` as an escaped `@`, so the obvious `/@@?[A-Za-z_]/` reached the
 * tokenizer as `/@?[A-Za-z_]/` — every identifier an attribute, `autoincrement` and `Cascade`
 * included. Inside a class neither rewrite applies, and it reads the same to JavaScript.
 */
export const PRISMA_ATTRIBUTE = /[@][@]?[A-Za-z_][\w.]*/;
/** `autoincrement(`, `env(`: a lowercase name with a call after it. `Unsupported(` is a type. */
export const PRISMA_FUNCTION = /[a-z_]\w*(?=\s*\()/;
/** `fields:`, `onDelete:`, `map:` — a named argument. */
export const PRISMA_NAMED_ARG = /[A-Za-z_]\w*(?=\s*:)/;

export const PRISMA_CONFIG: languages.LanguageConfiguration = {
  comments: { lineComment: "//" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};

export const PRISMA_GRAMMAR: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".prisma",
  scalars: PRISMA_SCALARS,
  constants: PRISMA_CONSTANTS,
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  tokenizer: {
    root: [
      { include: "@whitespace" },
      [PRISMA_MODEL_HEAD, ["keyword", "", "type.identifier", "", { token: "@brackets", next: "@model" }]],
      [PRISMA_ENUM_HEAD, ["keyword", "", "type.identifier", "", { token: "@brackets", next: "@enum" }]],
      [PRISMA_CONFIG_HEAD, ["keyword", "", "type.identifier", "", { token: "@brackets", next: "@config" }]],
      // A block whose brace is on the next line, or one being typed: the keyword still reads.
      [/\b(?:model|view|type|enum|datasource|generator)\b/, "keyword"],
      { include: "@values" },
    ],
    model: [
      [PRISMA_FIELD, ["", "variable", "", { cases: { "@scalars": "type", "@default": "type.identifier" } }]],
      { include: "@whitespace" },
      [/\}/, "@brackets", "@pop"],
      [PRISMA_ATTRIBUTE, "annotation"],
      [/\?|\[\]/, "operator"],
      { include: "@values" },
    ],
    enum: [
      [/^(\s*)([A-Za-z_]\w*)/, ["", "constant"]],
      { include: "@whitespace" },
      [/\}/, "@brackets", "@pop"],
      [PRISMA_ATTRIBUTE, "annotation"],
      { include: "@values" },
    ],
    config: [
      { include: "@whitespace" },
      [/\}/, "@brackets", "@pop"],
      [/[A-Za-z_]\w*(?=\s*=)/, "attribute.name"],
      [/=/, "operator"],
      { include: "@values" },
    ],
    values: [
      [/"/, "string", "@string"],
      [PRISMA_FUNCTION, "function"],
      [PRISMA_NAMED_ARG, "attribute.name"],
      [/-?\d+(?:\.\d+)?/, "number"],
      [/[A-Za-z_]\w*/, { cases: { "@constants": "constant", "@default": "identifier" } }],
      [/[{}()[\]]/, "@brackets"],
      [/[,:.]/, "delimiter"],
    ],
    whitespace: [
      [/[ \t\r\n]+/, ""],
      [/\/\/\/.*$/, "comment.doc"],
      [/\/\/.*$/, "comment"],
    ],
    string: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
  },
};
