// Not `from "./monacoSetup"` — that module imports this one. `monaco-editor` is an ESM singleton,
// so importing it directly is the same object without the cycle. Same reasoning as
// `monacoObjectScript.ts`, which is registered on the line above this one's call.
import * as monaco from "monaco-editor";

/**
 * DBML, for Monaco.
 *
 * **Hand-written rather than taken from `@dbml/core`**, which does ship a Monarch grammar
 * (`dbmlMonarchTokensProvider`). Importing it would mean importing the package — fifteen megabytes
 * of parser — to colour a hundred lines of text, and this is registered at startup so that a
 * `.dbml` file opened in the code editor is highlighted without anything else being loaded at all.
 * The grammar below is DBML's whole surface: five block keywords, the settings inside brackets, and
 * the three ways it quotes a string.
 *
 * Registered from `monacoSetup` beside ObjectScript, for the same reason that one is: a language
 * has to exist before a model claims it, and a model can be created by any view.
 */

let installed = false;

const CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "'", close: "'" },
    { open: '"', close: '"' },
    { open: "`", close: "`" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "'", close: "'" },
    { open: '"', close: '"' },
  ],
  folding: { markers: { start: /^\s*\/\/\s*#?region\b/, end: /^\s*\/\/\s*#?endregion\b/ } },
};

/**
 * The grammar.
 *
 * The one thing worth pointing at: **`settings` is its own state**, entered at `[` and left at `]`.
 * Inside it `pk`, `not null` and `increment` are keywords and `ref` introduces a relationship,
 * while outside it those are perfectly ordinary column names — `Table pk { unique varchar }` is
 * legal DBML, and a flat token list would colour half of it as syntax.
 */
const DBML: monaco.languages.IMonarchLanguage = {
  ignoreCase: true,
  defaultToken: "",
  keywords: ["table", "enum", "ref", "project", "tablegroup", "note", "indexes", "as", "tablepartial"],
  settingKeywords: [
    "pk", "primary key", "increment", "unique", "not null", "null", "note", "default",
    "delete", "update", "cascade", "restrict", "set null", "set default", "no action",
    "name", "type", "btree", "hash", "headercolor",
  ],
  types: [
    "int", "integer", "bigint", "smallint", "tinyint", "serial", "bigserial",
    "varchar", "char", "text", "boolean", "bool", "float", "double", "real",
    "decimal", "numeric", "money", "date", "datetime", "timestamp", "timestamptz",
    "time", "json", "jsonb", "uuid", "bytea", "blob", "binary",
  ],
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      // A block header: the keyword, then the name it declares.
      [/\b(table|enum|tablegroup|project|tablepartial)\b/, "keyword", "@declaration"],
      [/\bref\b\s*[\w.]*\s*:/, "keyword"],
      [/\bnote\b\s*:/, "keyword"],
      [/\bindexes\b/, "keyword"],
      [/'''/, "string", "@blockString"],
      [/'/, "string", "@singleString"],
      [/"/, "type.identifier", "@quotedName"],
      [/`/, "string.escape", "@expression"],
      [/\[/, "delimiter.square", "@settings"],
      [/[<>-]/, "operator"],
      [/\d+(\.\d+)?/, "number"],
      [/[A-Za-z_]\w*(\([^)]*\))?(\[\])?/, { cases: { "@types": "type", "@default": "identifier" } }],
      [/[{}()]/, "@brackets"],
      [/[.,:]/, "delimiter"],
    ],
    declaration: [
      [/\s+/, ""],
      [/\bas\b/, "keyword"],
      [/"[^"]*"/, "type.identifier"],
      [/[\w.]+/, "type.identifier"],
      [/(?=\{)/, "", "@pop"],
      [/$/, "", "@pop"],
    ],
    settings: [
      [/\]/, "delimiter.square", "@pop"],
      [/'''/, "string", "@blockString"],
      [/'/, "string", "@singleString"],
      [/`/, "string.escape", "@expression"],
      [/"/, "string", "@doubleString"],
      [/\b(not\s+null|primary\s+key|set\s+null|set\s+default|no\s+action)\b/, "keyword"],
      [/[<>-]/, "operator"],
      [/\d+(\.\d+)?/, "number"],
      [/[A-Za-z_]\w*/, { cases: { "@settingKeywords": "keyword", "@default": "identifier" } }],
      [/[.,:]/, "delimiter"],
    ],
    comment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],
    blockString: [
      [/'''/, "string", "@pop"],
      [/./, "string"],
    ],
    singleString: [
      [/[^\\']+/, "string"],
      [/\\./, "string.escape"],
      [/'/, "string", "@pop"],
    ],
    doubleString: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
    quotedName: [
      [/[^"]+/, "type.identifier"],
      [/"/, "type.identifier", "@pop"],
    ],
    expression: [
      [/[^`]+/, "string.escape"],
      [/`/, "string.escape", "@pop"],
    ],
  },
};

/** The starting points a new schema is most often typed from. */
const SNIPPETS: { label: string; body: string; detail: string }[] = [
  {
    label: "Table",
    detail: "A table with a primary key",
    body: "Table ${1:name} {\n  id integer [pk, increment]\n  $0\n}",
  },
  {
    label: "Enum",
    detail: "An enum and its values",
    body: "Enum ${1:name} {\n  ${2:value}\n  $0\n}",
  },
  {
    label: "Ref",
    detail: "A relationship between two columns",
    body: "Ref: ${1:table}.${2:column} > ${3:other}.${4:id}",
  },
  {
    label: "indexes",
    detail: "An index block",
    body: "indexes {\n  (${1:column}) [${2:unique}]\n}",
  },
];

export function registerDbmlLanguage(): void {
  if (installed) return;
  installed = true;
  monaco.languages.register({ id: "dbml", extensions: [".dbml"], aliases: ["DBML", "dbml"] });
  monaco.languages.setLanguageConfiguration("dbml", CONFIG);
  monaco.languages.setMonarchTokensProvider("dbml", DBML);
  monaco.languages.registerCompletionItemProvider("dbml", {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: SNIPPETS.map((snippet) => ({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.detail,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}
