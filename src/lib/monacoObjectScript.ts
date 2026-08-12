// Not `from "./monacoSetup"` — that module imports this one. `monaco-editor` is an ESM singleton, so
// importing it directly is the same object without the cycle.
import * as monaco from "monaco-editor";

/**
 * InterSystems ObjectScript, as two Monaco languages.
 *
 * **Why this file exists.** `monacoLanguage.ts` has mapped `.cls` to an id called `objectscript` since
 * the day it was written, and nothing ever registered that id. Monaco does not complain about an
 * unknown language — it falls back to plain text, which tokenizes each line as one run painted in the
 * editor's foreground colour. That is the near-black a `.cls` file has always opened in: not a missing
 * theme, a missing grammar.
 *
 * **Two ids, one factory.** A `.cls` file's top level is class-definition language — `Class`,
 * `Property`, `Method` declarations — while a `.mac` / `.int` / `.inc` file's top level is routine
 * code. Monarch fixes the `root` state at registration, so one id cannot serve both roots; hence
 * `objectscript-class` and `objectscript`, generated from the same function with a different opening
 * fragment. Four ids (matching the VS Code extension's split) would buy nothing here.
 *
 * ## Five Monarch mechanics the rules below depend on
 *
 * Each is commented again at the rule that needs it, because all five look like mistakes to a reader
 * who does not know them, and *each* tidy-up breaks something different and silently:
 *
 * 1. **A leading `^` means "column 1 only", not "anchor".** Monarch strips it and sets
 *    `matchOnlyAtLineStart`. It is the entire implementation of labels, column-1 directives and the
 *    `^}` member terminator.
 * 2. **`ignoreCase` covers everything**, including every `cases` probe — which is what makes
 *    case-insensitive commands and directives free.
 * 3. **A literal `@` must be written `@@`**, because `@word` is an attribute reference and an
 *    undefined one throws at compile time. ObjectScript's indirection operator is therefore `@@` in
 *    these regexes.
 * 4. **`tokenPostfix` is appended to every token**, so it is set explicitly on both ids — one
 *    construct must not have two token spellings. Theme resolution is by longest dot-prefix, so
 *    `keyword.objectscript` still resolves to `keyword`.
 * 5. **`@brackets` yields `delimiter.curly` / `.square` / `.parenthesis`** from the `brackets` array,
 *    not a token of its own.
 */

/**
 * [full name, shortest legal abbreviation].
 *
 * Commands are the *only* category where the abbreviations are prefixes — `S`, `SE` and `SET` are all
 * SET. Functions abbreviate as acronyms (`$LB` for `$LISTBUILD`), which no generator can produce, so
 * those are matched by shape instead.
 *
 * **The known cost of keeping the single-letter forms.** ObjectScript has no reserved words, so a
 * variable named `b` at the end of a line is indistinguishable from `BREAK` without semantics — the
 * `statementGate` below rejects the cases a regex *can* see (a name being assigned, called or
 * dereferenced) and this one gets through. Legacy `.int` and `.mac` code is written almost entirely in
 * single letters, so dropping them would leave real routines uncoloured; one over-coloured operand is
 * the cheaper error, and raising a minimum here is a one-character fix if it ever grates.
 */
const COMMANDS: [string, number][] = [
  ["set", 1],
  ["do", 1],
  ["write", 1],
  ["read", 1],
  ["kill", 1],
  ["quit", 1],
  ["if", 1],
  ["for", 1],
  ["merge", 1],
  ["lock", 1],
  ["new", 1],
  ["open", 1],
  ["close", 1],
  ["use", 1],
  ["view", 1],
  ["job", 1],
  ["goto", 1],
  ["halt", 1],
  ["hang", 1],
  ["print", 1],
  ["break", 1],
  ["xecute", 1],
  ["return", 3],
  ["tcommit", 2],
  ["trollback", 3],
  ["tstart", 2],
  ["znspace", 2],
  ["zwrite", 2],
  ["ztrap", 2],
  ["zkill", 2],
  ["zload", 2],
  ["zprint", 2],
  ["zremove", 2],
  ["zsave", 2],
  ["zbreak", 2],
  ["zinsert", 2],
  // Block-oriented keywords cannot be abbreviated at all, unlike their line-oriented ancestors.
  // `["else", 4]` on purpose: colouring a variable named `e` is the more visible error.
  ["else", 4],
  ["elseif", 6],
  ["while", 5],
  ["try", 3],
  ["catch", 5],
  ["throw", 5],
  ["continue", 8],
];

/** `"set"` with a minimum of 1 becomes `s(?:e(?:t)?)?` — every prefix from the minimum up and nothing
 *  else. One alternation per command, no cross product. */
function prefixAlt(word: string, min: number): string {
  let tail = "";
  for (let i = word.length - 1; i >= min; i--) tail = `(?:${word[i]}${tail})?`;
  return word.slice(0, min) + tail;
}

/**
 * Every command and legal abbreviation, longest-first.
 *
 * Sorted because alternation is leftmost-first and the T- and Z- families share initials. The
 * lookahead is load-bearing rather than noise: a command is always followed by whitespace, by `:`
 * (a postconditional, which attaches with no space) or by end of line — never by `=`, `(` or `.`.
 */
const COMMAND_RE = new RegExp(
  `(?:${[...COMMANDS]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([word, min]) => prefixAlt(word, min))
    .join("|")})(?=[\\s:]|$)`,
);

/**
 * The grammar, rooted either in routine code or in a class body.
 *
 * Note the identifier class throughout: `[A-Za-z%][A-Za-z0-9]*`, never `\w`. `_` is ObjectScript's
 * **concatenation operator**, so a `\w` would swallow `a_b` into one identifier and lose the operator.
 */
function objectScript(rootFragment: "code" | "classBody"): monaco.languages.IMonarchLanguage {
  return {
    ignoreCase: true,
    tokenPostfix: ".objectscript",
    // The theme's catch-all, which is what plain text already used — so anything the rules miss is no
    // worse than before rather than invisible.
    defaultToken: "",
    brackets: [
      { open: "{", close: "}", token: "delimiter.curly" },
      { open: "[", close: "]", token: "delimiter.square" },
      { open: "(", close: ")", token: "delimiter.parenthesis" },
    ],

    commands: COMMAND_RE,
    codeMembers: ["method", "classmethod", "clientmethod", "trigger"],
    sqlMembers: ["query"],
    xmlMembers: ["xdata", "storage"],
    declMembers: ["parameter", "property", "relationship", "index", "foreignkey", "projection"],
    typeWords: ["as", "of", "list", "array", "references", "on", "not", "extends", "output"],
    // Closed and short, unlike the ~200 system functions — so this is the list that is enumerated and
    // `@default` is the *function* arm. An unknown `$name` is unmistakably a system name.
    specialVariables: [
      "$device", "$ecode", "$estack", "$etrap", "$horolog", "$h", "$io", "$i", "$job", "$j", "$key",
      "$namespace", "$quit", "$roles", "$stack", "$storage", "$system", "$test", "$t", "$this",
      "$throwobj", "$tlevel", "$username", "$x", "$y", "$za", "$zb", "$zchild", "$zeof", "$zeos",
      "$zerror", "$ze", "$zhorolog", "$zh", "$zio", "$zjob", "$zmode", "$zname", "$znspace",
      "$zorder", "$zparent", "$zpi", "$zpos", "$zreference", "$zr", "$ztimestamp", "$zts",
      "$ztimezone", "$ztz", "$ztrap", "$zt", "$zversion", "$zv",
    ],
    sqlKeywords: [
      "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "join",
      "left", "right", "inner", "outer", "on", "order", "by", "group", "having", "as", "and", "or",
      "not", "null", "is", "in", "like", "between", "distinct", "top", "declare", "cursor", "fetch",
      "open", "close", "union", "all", "case", "when", "then", "else", "end", "count", "sum", "min",
      "max", "avg", "exists",
    ],

    tokenizer: {
      root: [{ include: rootFragment === "code" ? "@code" : "@classBody" }],

      // ---------------------------------------------------------------- .cls outer level
      classBody: [
        [/^\/\/\//, { token: "comment.doc", next: "@docLine" }],
        [/^\s*\/\*/, { token: "comment", next: "@blockComment" }],
        [/^\s*(?:\/\/|;;?)/, { token: "comment", next: "@lineComment" }],
        [/^\s*(#[a-z;]+|##[a-z;]+)/, "metatag"],
        [
          /^(Class)(\s+)([%A-Za-z][A-Za-z0-9.]*)/,
          ["keyword", "white", { token: "type.identifier", next: "@classHeader" }],
        ],
        [/^(?:Import|IncludeGenerator|Include)\b/, { token: "keyword", next: "@typeList" }],
        // Kind and name in one match, so a member's name can never be mistaken for a type or a
        // command.
        [
          /^(\s*)([A-Za-z]+)(\s+)([%A-Za-z][A-Za-z0-9]*)/,
          [
            "white",
            {
              cases: {
                "@codeMembers": { token: "keyword", next: "@memberHeaderCode" },
                "@sqlMembers": { token: "keyword", next: "@memberHeaderSql" },
                "@xmlMembers": { token: "keyword", next: "@memberHeaderXml" },
                "@declMembers": { token: "keyword", next: "@memberDecl" },
                "@default": "identifier",
              },
            },
            "white",
            // Method and Query names read as functions, Property and Parameter names would ideally
            // read as variables. One token for both loses a distinction a reader scans for; two
            // near-identical rules duplicate the whole line. `function` wins — a property name in
            // function colour is a far smaller error than a black one.
            "function",
          ],
        ],
        [/^[{}]/, "@brackets"],
        { include: "@whitespace" },
        [/./, ""],
      ],

      // `Extends (%Persistent, %XML.Adaptor) [ Abstract ]`
      classHeader: [
        [/\bExtends\b/, "keyword"],
        [/\[/, { token: "@brackets", next: "@memberKeywords" }],
        [/[%A-Za-z][A-Za-z0-9.]*/, "type.identifier"],
        [/[(),]/, "delimiter"],
        [/\{/, { token: "@brackets", next: "@popall" }],
        { include: "@whitespace" },
      ],

      // Import / Include targets.
      typeList: [
        // `$`-anchored first, so the list ends with its line — an Import never continues onto the next
        // one, and see `docLine` for why a bare `[/$/]` rule cannot do this.
        [/[%A-Za-z][A-Za-z0-9.]*$/, { token: "type.identifier", next: "@pop" }],
        [/[%A-Za-z][A-Za-z0-9.]*/, "type.identifier"],
        [/[(),]$/, { token: "delimiter", next: "@pop" }],
        [/[(),]/, "delimiter"],
        [/[ \t]+$/, { token: "white", next: "@pop" }],
        { include: "@whitespace" },
      ],

      // `;`-terminated declarations: Property / Parameter / Index / ForeignKey / Projection.
      memberDecl: [
        [/;/, { token: "delimiter", next: "@popall" }],
        [/\[/, { token: "@brackets", next: "@memberKeywords" }],
        [/\(/, { token: "@brackets", next: "@parenList" }],
        // `%String`, `Sample.Person`: the sigil and the package path are part of the type name, so this
        // cannot be `[A-Za-z]+` — that left a bare `%` painted in the catch-all colour.
        [/[%A-Za-z][A-Za-z0-9.]*/, { cases: { "@typeWords": "keyword", "@default": "type.identifier" } }],
        [/=/, "operator"],
        { include: "@literals" },
        { include: "@whitespace" },
        [/./, ""],
      ],

      // The three body-language variants, identical but for the `{` action. Monarch has no variables,
      // only a state stack, so "which language is this body" can only be carried by which state we
      // are in.
      memberHeaderCode: [
        { include: "@memberHeaderCommon" },
        [/\{/, { token: "@brackets", switchTo: "@code" }],
      ],
      memberHeaderSql: [
        { include: "@memberHeaderCommon" },
        [/\{/, { token: "@brackets", switchTo: "@sqlBody" }],
      ],
      memberHeaderXml: [
        { include: "@memberHeaderCommon" },
        [/\{/, { token: "@brackets", switchTo: "@xmlBody" }],
      ],

      memberHeaderCommon: [
        [/\[/, { token: "@brackets", next: "@memberKeywords" }],
        [/\(/, { token: "@brackets", next: "@parenList" }],
        [/[%A-Za-z][A-Za-z0-9.]*/, { cases: { "@typeWords": "keyword", "@default": "type.identifier" } }],
        [/,/, "delimiter"],
        { include: "@whitespace" },
      ],

      // `[ Required, SqlFieldName = NAME, Not Internal ]` — matched structurally rather than against a
      // keyword list, so a member keyword InterSystems adds in 2027 still colours correctly.
      memberKeywords: [
        [/\]/, { token: "@brackets", next: "@pop" }],
        [/\bNot\b/, "keyword"],
        [/=/, "operator"],
        [/"/, { token: "attribute.value", next: "@stringAttr" }],
        [/[A-Za-z][A-Za-z0-9]*(?=\s*=)/, "attribute.name"],
        [/[%A-Za-z][A-Za-z0-9.]*/, "attribute.name"],
        [/[-+0-9.]+/, "attribute.value"],
        [/[,()]/, "delimiter"],
        { include: "@whitespace" },
      ],

      // Formal specs and property parameter lists.
      parenList: [
        [/\)/, { token: "@brackets", next: "@pop" }],
        // By-reference and output markers, which are not part of the name.
        [/&|\*/, "operator"],
        // A `%` sigil or a dotted path is a class name; a bare word in this position is a parameter.
        // `@default` here is `identifier` precisely because parameter names outnumber types, so the
        // types have to be picked out first.
        [/%[A-Za-z][A-Za-z0-9.]*|[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+/, "type.identifier"],
        [/[%A-Za-z][A-Za-z0-9.]*/, { cases: { "@typeWords": "keyword", "@default": "identifier" } }],
        [/=/, "operator"],
        [/,/, "delimiter"],
        { include: "@literals" },
        { include: "@whitespace" },
        [/./, ""],
      ],

      // ---------------------------------------------------------------- shared code tokenizer
      // Serves method bodies, `.mac`, `.int` and `.inc` alike: a method body contains the same
      // statements, labels and comments a routine does.
      code: [
        // Closes a member body. Class serialization always writes the closing brace in column 1, and
        // the leading `^` is the only way to say "only there" — brace counting cannot work, because a
        // JSON XData body and an `If {}` block both contain braces. `@popall` rather than `@pop`, so
        // it also unwinds from a nested state and so a stray `^}` in a `.mac` (whose root *is* this
        // state) is a no-op instead of popping past the root.
        [/^\}/, { token: "@brackets", next: "@popall" }],

        // Column 1 is semantically reserved: nothing there is ever a command.
        [/^\/\/\//, { token: "comment.doc", next: "@docLine" }],
        [/^(##;|#;)/, { token: "comment", next: "@lineComment" }],
        // The only two-word directive.
        [/^(\s*)(#sqlcompile\s+[a-z]+)/, ["white", "metatag"]],
        [
          /^(\s*)(#define|#def1arg)(\s+)([%A-Za-z][A-Za-z0-9]*)/,
          ["white", "metatag", "white", "metatag"],
        ],
        [
          /^(\s*)(#include|#import)(\s+)([%A-Za-z][A-Za-z0-9.]*)/,
          ["white", "metatag", "white", "type.identifier"],
        ],
        [/^(\s*)(#dim)(\s+)([%A-Za-z][A-Za-z0-9]*)/, ["white", "metatag", "white", "variable"]],
        // Every other directive.
        [/^(\s*)(##?[a-z][a-z0-9]*)/, ["white", "metatag"]],
        // Legacy dotted DO block. The whitespace after the dots is required, which is what keeps
        // `..Property` out of this rule.
        [/^(\s*)((?:\.[ \t]+)+)/, ["white", "delimiter"]],
        // A label: the only ObjectScript name that may start with a digit, and the only thing a bare
        // column-1 word can be.
        [/^[%A-Za-z0-9][A-Za-z0-9]*/, "type.identifier"],

        { include: "@comments" },
        { include: "@literals" },

        // Embedded shells. `&sql(...)` is paren-counted rather than handed to Monaco's `sql` language:
        // an embedded language needs a rule that recognises the *end*, and SQL is full of parens.
        // The opening paren is consumed *by this rule*, not left for `sqlBlock`'s own paren counter.
        // Leaving it meant `&sql(…)` pushed the state twice and the balancing `)` popped only one, so
        // everything after an embedded SQL line tokenized as SQL — including the next method.
        [
          /(&sql[A-Za-z0-9]*)(\s*)(\()/,
          ["keyword", "white", { token: "delimiter.parenthesis", next: "@sqlBlock" }],
        ],
        [/&html\s*(?=<)/, { token: "keyword", next: "@htmlBlock" }],
        [/&js\s*(?=<)/, { token: "keyword", next: "@htmlBlock" }],

        // The `$` family, longest sigil first or `$$$OK` tokenizes as `$$` followed by `$OK`.
        [/\$\$\$[%A-Za-z][A-Za-z0-9]*/, "metatag"],
        [/\$\$[%A-Za-z][A-Za-z0-9]*/, "function"],
        [
          /\$[A-Za-z][A-Za-z0-9]*/,
          {
            cases: {
              "@specialVariables": "variable.predefined",
              // Abbreviations and %ZLANG names land here, which is right: an unknown `$name` is a
              // system function far more often than anything else.
              "@default": "function",
            },
          },
        ],

        [/##class(?=\s*\()/, "keyword"],
        [/##super/, "keyword"],
        // `..Prop`, `..Method()`, `..#PARAMETER`.
        [/\.\.#?[%A-Za-z][A-Za-z0-9]*/, "variable"],
        [/i%[%A-Za-z][A-Za-z0-9]*/, "variable"],
        [/%%[A-Za-z]+/, "variable.predefined"],
        [/\^\$?[[|]/, { token: "variable.predefined", next: "@globalNs" }],
        [/\^{1,2}\$?[%A-Za-z][A-Za-z0-9.]*/, "variable.predefined"],
        [/#[A-Za-z][A-Za-z0-9]*/, "variable"],

        { include: "@statementGate" },
        [/[{}()[\]]/, "@brackets"],
        { include: "@operators" },
        [/[%A-Za-z][A-Za-z0-9]*/, "identifier"],
        { include: "@whitespace" },
        [/./, ""],
      ],

      /**
       * ObjectScript has no reserved words: `Set s=1`, `Set d.x=1` and `For i=1:1:10` are all legal,
       * so colouring every `s` as SET paints half the locals. The reject rule has to come *first*: a
       * name followed by `=`, `(` or `.` is being assigned, called or dereferenced, so it is a
       * variable however much it looks like a command. `\s*=` allows `x = 1`; `\(` and `\.`
       * deliberately allow no space, so `If (x=1)` and `Do ..Method()` keep their keyword.
       */
      statementGate: [
        [/[A-Za-z%][A-Za-z0-9]*(?=\s*=|\(|\.)/, "identifier"],
        [/@commands/, "keyword"],
      ],

      operators: [
        // `@@` is a literal at-sign (indirection) — see mechanic 3. `_` is concatenation and `'` is
        // unary NOT, which is also why `'` is not an auto-closing pair below.
        [/\*\*|]]|&&|\|\||'&&|'\|\||'=|'<|'>|'&|'\||<=|>=/, "operator"],
        [/[-+*/\\#_'=<>&!?@@~[\]]/, "operator"],
        [/[:,;]/, "delimiter"],
      ],

      literals: [
        // No `_` in the number rule: that is concatenation, not a digit separator.
        [/\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?/, "number"],
        [/"/, { token: "string", next: "@string" }],
      ],

      comments: [
        [/\/\*/, { token: "comment", next: "@blockComment" }],
        [/(?:\/\/|;;?)/, { token: "comment", next: "@lineComment" }],
        [/##;/, { token: "comment", next: "@lineComment" }],
      ],

      // ---------------------------------------------------------------- leaf states
      lineComment: [
        [/[^]*$/, { token: "comment", next: "@pop" }],
        [/$/, { token: "comment", next: "@pop" }],
      ],
      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[/*]/, "comment"],
      ],
      // `///` carries HTML — `<class>`, `<method>`, `<b>` — and colouring those tags is most of what
      // makes a long documentation block readable.
      // Every rule here comes in a `$`-anchored pair, and that is not redundancy: Monarch's tokenizer
      // stops as soon as it reaches the end of the line, so a bare `[/$/, "@pop"]` rule is *never*
      // reached and the state leaks into the line below. Without the pairs, one `///` line painted the
      // whole rest of the file as documentation — which is how this was caught.
      docLine: [
        [/<\/?[A-Za-z][A-Za-z0-9]*[^>]*>$/, { token: "tag", next: "@pop" }],
        [/<\/?[A-Za-z][A-Za-z0-9]*[^>]*>/, "tag"],
        [/[^<]+$/, { token: "comment.doc", next: "@pop" }],
        [/[^<]+/, "comment.doc"],
        [/<$/, { token: "comment.doc", next: "@pop" }],
        [/</, "comment.doc"],
      ],
      // `""` is the only escape and there is no line continuation, so popping at end of line cannot
      // corrupt the lines below.
      string: [
        [/""$/, { token: "string.escape", next: "@pop" }],
        [/""/, "string.escape"],
        [/"/, { token: "string", next: "@pop" }],
        // The `$` variant is what closes an *unterminated* string at the end of its line. See the
        // note on `docLine`: a `[/$/]` rule would never run, and the string would swallow the file.
        [/[^"]+$/, { token: "string", next: "@pop" }],
        [/[^"]+/, "string"],
      ],
      stringAttr: [
        [/""$/, { token: "attribute.value", next: "@pop" }],
        [/""/, "attribute.value"],
        [/"/, { token: "attribute.value", next: "@pop" }],
        [/[^"]+$/, { token: "attribute.value", next: "@pop" }],
        [/[^"]+/, "attribute.value"],
      ],
      // `^["ns"]Global`, `^|"ns"|Global`, `^||ppg`.
      globalNs: [
        [/[\]|]/, { token: "variable.predefined", next: "@pop" }],
        [/"[^"]*"/, "string"],
        // A global reference always closes on its own line; the `$` variant is the safety net for
        // malformed input, for the reason `docLine` explains.
        [/[^\]|"]+$/, { token: "variable.predefined", next: "@pop" }],
        [/[^\]|"]+/, "variable.predefined"],
      ],
      // One push per `(` and one pop per `)`, so the block ends on the balancing paren rather than on
      // the first one inside `VALUES (1,2)`.
      sqlBlock: [
        [/\(/, { token: "delimiter.parenthesis", next: "@sqlBlock" }],
        [/\)/, { token: "delimiter.parenthesis", next: "@pop" }],
        [/--.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@blockComment" }],
        // Host variable.
        [/:[%A-Za-z][A-Za-z0-9.]*/, "variable"],
        [/'[^']*'/, "string"],
        [/"/, { token: "string", next: "@string" }],
        [/\d+(?:\.\d+)?/, "number"],
        [/[A-Za-z][A-Za-z0-9_]*/, { cases: { "@sqlKeywords": "keyword", "@default": "identifier" } }],
        [/[,;.*=<>+\-/]/, "operator"],
        { include: "@whitespace" },
        [/./, ""],
      ],
      // Balanced-angle counting is what the preprocessor itself does: `&html<<p>x</p>>`.
      htmlBlock: [
        [/</, { token: "tag", next: "@htmlBlock" }],
        [/>/, { token: "tag", next: "@pop" }],
        // Compile-time and run-time interpolation.
        [/##\([^)]*\)##|#\([^)]*\)#/, "metatag"],
        [/[A-Za-z-]+(?==)/, "attribute.name"],
        [/"[^"]*"/, "attribute.value"],
        { include: "@whitespace" },
        [/[^<>"#\s]+/, ""],
        [/./, ""],
      ],
      // XData and Storage. Hand-rolled rather than an embedded `xml`: embedding degrades the first
      // paint to plain text until the nested language loads, and Monarch refuses an embedding inside
      // an embedding, which would rule out `&sql` anywhere near it.
      xmlBody: [
        [/^\}/, { token: "@brackets", next: "@popall" }],
        [/<!--/, { token: "comment", next: "@xmlComment" }],
        [/<\/?[A-Za-z][A-Za-z0-9:.-]*/, "tag"],
        [/\/?>/, "tag"],
        [/[A-Za-z][A-Za-z0-9:.-]*(?=\s*=)/, "attribute.name"],
        [/=/, "operator"],
        [/"[^"]*"/, "attribute.value"],
        // Before the catch-all: without it, `[^<="]+` swallows the space *and* the attribute name that
        // follows it, so every attribute in an XData block was drawn uncoloured.
        { include: "@whitespace" },
        [/[^<="\s]+/, ""],
        [/./, ""],
      ],
      xmlComment: [
        [/-->/, { token: "comment", next: "@pop" }],
        [/[^-]+/, "comment"],
        [/./, "comment"],
      ],
      // A Query member's body: SQL, with no surrounding parens to count.
      sqlBody: [[/^\}/, { token: "@brackets", next: "@popall" }], { include: "@sqlBlock" }],
      whitespace: [[/[ \t\r\n]+/, "white"]],
    },
  };
}

/** Shared by both ids: the editor behaviours that are about the language rather than its colours. */
const CONFIG: monaco.languages.LanguageConfiguration = {
  // `;` is also a line comment, but `//` is what ⌘/ should insert: it is what every modern
  // ObjectScript file uses and the only form that cannot be confused with a statement separator.
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
    { open: '"', close: '"', notIn: ["string", "comment"] },
    // `'` is deliberately absent: it is the unary NOT operator, so auto-closing it would insert
    // garbage on every `'=`.
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  folding: {
    markers: {
      start: /^\s*(?:#(?:if|ifdef|ifndef|ifundef)\b|\/\/\s*#?region\b)/i,
      end: /^\s*(?:#endif\b|\/\/\s*#?endregion\b)/i,
    },
  },
  // `_` is excluded because it is concatenation — including it would make a double-click on `a_b`
  // select the whole expression. `%`, `$`, `$$`, `$$$`, `^` and dotted class paths are part of the
  // word; a leading digit is allowed because labels are the only names that may start with one.
  wordPattern:
    /(?:\$\$\$|\$\$|\$|%%|i%|%|\^\^|\^|\.\.#|\.\.|#)?[A-Za-z0-9][A-Za-z0-9]*(?:\.[A-Za-z%][A-Za-z0-9]*)*/,
  onEnterRules: [
    {
      beforeText: /^\s*\/\/\/.*$/,
      action: { indentAction: monaco.languages.IndentAction.None, appendText: "/// " },
    },
  ],
  // No `indentationRules`: modern code is brace-driven, which `brackets` already covers, and legacy
  // code is dot-driven — one rule serving both would fight the user in whichever they are writing.
};

let installed = false;

/**
 * Teaches Monaco both ObjectScript dialects. Idempotent, and the guard is not decoration: a repeated
 * `languages.register` is *merged* into the existing entry rather than rejected, so a second call
 * would append duplicate extensions and stack a second language configuration.
 */
export function registerObjectScript(): void {
  if (installed) return;
  installed = true;
  register("objectscript", [".mac", ".int", ".inc"], "code", "ObjectScript");
  register("objectscript-class", [".cls"], "classBody", "ObjectScript Class");
}

function register(
  id: string,
  extensions: string[],
  rootFragment: "code" | "classBody",
  alias: string,
): void {
  monaco.languages.register({ id, extensions, aliases: [alias, id] });
  monaco.languages.setLanguageConfiguration(id, CONFIG);
  monaco.languages.setMonarchTokensProvider(id, objectScript(rootFragment));
}
