// Not `from "./monacoSetup"` — that module imports this one. `monaco-editor` is an ESM singleton,
// so importing it directly is the same object without the cycle. Same reasoning as
// `monacoObjectScript.ts`, which is registered on the line above this one's call.
import * as monaco from "monaco-editor";
import { outlineOf, tableAtLine, type DbmlOutline, type OutlineTable } from "./dbml/outline";
// One list for the grammar, the completion provider and the inspector's column form — see the note
// at the top of that module for why it does not live here.
import { DBML_TYPES, TYPE_SUGGESTIONS } from "./dbml/dataTypes";

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
  types: DBML_TYPES,
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


/**
 * What may go inside a column's `[ … ]`.
 *
 * The ones that take a value carry it in the snippet — `default: ` with the caret after the colon —
 * because the half that is hard to remember is that they take one at all. `ref` gets its arrow, so
 * accepting it lands you in `refTable` on the very next keystroke.
 */
const SETTINGS: { label: string; body: string; detail: string }[] = [
  { label: "pk", body: "pk", detail: "Primary key" },
  { label: "primary key", body: "primary key", detail: "Primary key" },
  { label: "increment", body: "increment", detail: "Auto-incrementing" },
  { label: "unique", body: "unique", detail: "Unique" },
  { label: "not null", body: "not null", detail: "Required" },
  { label: "null", body: "null", detail: "Nullable" },
  { label: "default", body: "default: ", detail: "A default value" },
  { label: "note", body: "note: '", detail: "A comment on the column" },
  { label: "ref", body: "ref: > ", detail: "A relationship from this column" },
];

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

/**
 * What the caret is in the middle of, which is what decides the answer.
 *
 * The whole provider is this classification plus five short lists. It is deliberately textual — the
 * text before the caret on the current line, plus `outlineOf` for what the document declares —
 * because a document being completed does not parse, and a classifier that needs it to parse would
 * go quiet exactly when it is wanted. Same reason `lib/dbml/outline.ts` is a scan rather than the
 * real parser; the note at the top of that file is the long version.
 */
type Where =
  /** Nothing open: the top of the document, between blocks. */
  | { kind: "top" }
  /** Inside `[ … ]`, where `pk`, `not null` and the rest are keywords. */
  | { kind: "settings"; table: OutlineTable | null }
  /** After a `Ref:` or a `ref:` setting, before any `.` — a table is wanted. */
  | { kind: "refTable" }
  /** After `something.` in a ref — that table's columns are wanted. */
  | { kind: "refColumn"; table: string }
  /** Second token of a column line: its type. */
  | { kind: "type" }
  /** Inside `indexes { … }`: the current table's own columns. */
  | { kind: "index"; table: OutlineTable | null }
  /** Inside a table but at the start of a line — a new column name, which we cannot guess. */
  | { kind: "column" };

/** `Ref: a.b > c.d`, and the `ref:` setting inside a column's brackets. Both name tables. */
const REF_HEAD = /\b(ref\s*:|ref\s+[\w."]*\s*:)/i;

/** The identifier immediately before a trailing `.`, if the caret is right after one. */
const QUALIFIER = /([\w"]+)\.\s*[\w"]*$/;

function classify(before: string, inTable: OutlineTable | null): Where {
  // Brackets win over everything else on the line: a `ref:` inside them is still inside them, and
  // the closing `]` is what leaves. Counted rather than tested so `[a] [` lands inside the second.
  const opens = (before.match(/\[/g) ?? []).length;
  const closes = (before.match(/\]/g) ?? []).length;
  const inBrackets = opens > closes;

  if (REF_HEAD.test(before)) {
    const qualified = QUALIFIER.exec(before);
    if (qualified) return { kind: "refColumn", table: qualified[1].replace(/"/g, "") };
    return { kind: "refTable" };
  }
  if (inBrackets) return { kind: "settings", table: inTable };
  if (!inTable) return { kind: "top" };

  // A complete word, whitespace, then whatever is being typed: that second word is the type. The
  // trailing group is allowed to be empty so the list is up before the first character rather than
  // after it.
  if (/^\s*("[^"]*"|[\w]+)\s+[\w"(]*$/.test(before)) return { kind: "type" };
  return { kind: "column" };
}

/** The line up to the caret. */
function textBefore(model: monaco.editor.ITextModel, position: monaco.Position): string {
  return model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
}

/** Is the caret inside an `indexes { … }` block? Cheap: the nearest unclosed one above it. */
function inIndexes(model: monaco.editor.ITextModel, position: monaco.Position): boolean {
  for (let line = position.lineNumber - 1; line >= 1; line -= 1) {
    const text = model.getLineContent(line).trim();
    if (/^\}/.test(text)) return false;
    if (/^indexes\b/i.test(text)) return true;
    if (/^(table|enum|tablegroup|project|tablepartial)\b/i.test(text)) return false;
  }
  return false;
}

/**
 * Schema-aware completion for DBML.
 *
 * What was here before was five snippets — `Table`, `Enum`, `Ref`, `indexes` — offered identically
 * wherever the caret was. They are still here, at the top level where they are the answer, but they
 * were never the hard part: the names you cannot remember in a schema are *its own*, and the widget
 * knew none of them. Typing `Ref: orders.` offered nothing, in the one document that contains the
 * complete list of what could legally come next.
 *
 * Modelled on `lib/db/sqlCompletion.ts` and for the same reason it gives: **it never awaits**.
 * Monaco asks a provider once per suggest session and filters that answer locally as you keep
 * typing, so anything not ready when the widget opens is not late — it is absent for the whole
 * session. Everything here reads the buffer synchronously, which it can because the buffer is the
 * schema.
 */
const dbmlProvider: monaco.languages.CompletionItemProvider = {
  // `.` is the one that matters — it is what turns `orders.` into a column list. The others open
  // the list where a name is wanted but no word has been started yet.
  triggerCharacters: [".", "[", ",", " ", ">", "<"],
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
    const source = model.getValue();
    const before = textBefore(model, position);
    const outline = outlineOf(source);
    const inTable = tableAtLine(source, position.lineNumber);
    const where = inIndexes(model, position)
      ? ({ kind: "index", table: inTable } as Where)
      : classify(before, inTable);

    const item = (
      label: string,
      kind: monaco.languages.CompletionItemKind,
      detail: string,
      sort: string,
      insert = label,
    ): monaco.languages.CompletionItem => ({ label, kind, detail, insertText: insert, sortText: sort, range });

    switch (where.kind) {
      case "top":
        return {
          suggestions: SNIPPETS.map((snippet) => ({
            label: snippet.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: snippet.detail,
            insertText: snippet.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            sortText: "0",
            range,
          })),
        };

      case "refTable":
        return {
          suggestions: outline.tables.map((table) =>
            // The alias is what a ref may legally name when the table has one, so it is what is
            // inserted — offering the full name beside an `as` the author wrote is offering them
            // the version they chose not to use.
            item(
              table.alias ?? table.name,
              monaco.languages.CompletionItemKind.Class,
              `${table.columns.length}`,
              "0",
              quoted(table.alias ?? table.name),
            ),
          ),
        };

      case "refColumn": {
        const target = findTable(outline, where.table);
        if (!target) return { suggestions: [] };
        return {
          suggestions: target.columns.map((column, at) =>
            item(
              column.name,
              monaco.languages.CompletionItemKind.Field,
              column.type,
              String(at).padStart(3, "0"),
              quoted(column.name),
            ),
          ),
        };
      }

      case "settings":
        return {
          suggestions: SETTINGS.map((setting) =>
            item(setting.label, monaco.languages.CompletionItemKind.Keyword, setting.detail, "0", setting.body),
          ),
        };

      case "type":
        return {
          suggestions: [
            // Enums first: a type list is a fixed thing everyone knows, while the enums are this
            // document's own and are the reason to look.
            ...outline.enums.map((name) =>
              item(name, monaco.languages.CompletionItemKind.Enum, "enum", "0", quoted(name)),
            ),
            // The parametrised forms, in use-order: what somebody reaching for `varchar` means is
            // `varchar(255)`, and offering the bare word makes them type the parentheses by hand.
            // `sortText` is the index so the list keeps that order instead of being re-alphabetised.
            ...TYPE_SUGGESTIONS.map((type, at) =>
              item(type, monaco.languages.CompletionItemKind.TypeParameter, "", `1${String(at).padStart(3, "0")}`),
            ),
          ],
        };

      case "index":
        return {
          suggestions: (where.table?.columns ?? []).map((column, at) =>
            item(
              column.name,
              monaco.languages.CompletionItemKind.Field,
              column.type,
              String(at).padStart(3, "0"),
              quoted(column.name),
            ),
          ),
        };

      // A column name is the author's to invent. Answering with an empty list rather than falling
      // through to Monaco's word-based fallback would be worse — that fallback offers the other
      // names in the file, which is a reasonable guess at a name you are repeating.
      case "column":
        return { suggestions: [] };
    }
  },
};

/** Quotes a name only when DBML requires it, which is when it is not a bare identifier. */
function quoted(name: string): string {
  return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/.test(name) ? name : `"${name}"`;
}

/** By alias first, then by name, then by the bare half of a `schema.name`. */
function findTable(outline: DbmlOutline, needle: string): OutlineTable | undefined {
  const wanted = needle.toLowerCase();
  return (
    outline.tables.find((table) => table.alias?.toLowerCase() === wanted) ??
    outline.tables.find((table) => table.name.toLowerCase() === wanted) ??
    outline.tables.find((table) => table.name.toLowerCase().split(".").pop() === wanted)
  );
}

export function registerDbmlLanguage(): void {
  if (installed) return;
  installed = true;
  monaco.languages.register({ id: "dbml", extensions: [".dbml"], aliases: ["DBML", "dbml"] });
  monaco.languages.setLanguageConfiguration("dbml", CONFIG);
  monaco.languages.setMonarchTokensProvider("dbml", DBML);
  monaco.languages.registerCompletionItemProvider("dbml", dbmlProvider);
}
