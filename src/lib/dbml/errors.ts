import type { TranslationKey } from "../i18n/translations";

/**
 * What to try, when the parser says no.
 *
 * A PEG parser's message names the token it wanted, which is accurate and — to someone who has
 * written four lines of DBML in their life — useless. This maps the message onto the mistake that
 * actually produces it, in the app's own language.
 *
 * The suggestions are translation keys rather than sentences: this file is matched against the
 * *English* text `@dbml/core` emits, which is not the language the user is reading. Keeping the two
 * apart is what lets the match stay in English and the advice not.
 */
export interface DbmlHint {
  /** Advice, most likely first. */
  suggestions: TranslationKey[];
  /** A snippet showing the shape being described. Not translated: it is DBML. */
  example?: string;
}

const PATTERNS: { match: RegExp; hint: DbmlHint }[] = [
  {
    match: /expected .*(newline|comment)/i,
    hint: {
      suggestions: ["dbml.hint.oneFieldPerLine", "dbml.hint.settingsBrackets", "dbml.hint.noTrailingComma"],
      example: "Table users {\n  id integer [pk, increment]\n}",
    },
  },
  {
    match: /duplicated? (table|column|field|enum)/i,
    hint: { suggestions: ["dbml.hint.duplicateName", "dbml.hint.namesAreCaseSensitive"] },
  },
  {
    match: /duplicated? references/i,
    hint: {
      suggestions: ["dbml.hint.duplicateRef", "dbml.hint.inlineRefIsARef"],
      example: "Table posts {\n  author_id integer [ref: > users.id]\n}",
    },
  },
  {
    match: /(can'?t find|not found|undefined).*(table|column|field|schema)/i,
    hint: {
      suggestions: ["dbml.hint.defineBeforeRef", "dbml.hint.namesAreCaseSensitive", "dbml.hint.refShape"],
      example: "Ref: orders.user_id > users.id",
    },
  },
  {
    match: /(enum).*(not found|undefined)/i,
    hint: {
      suggestions: ["dbml.hint.defineEnumFirst", "dbml.hint.namesAreCaseSensitive"],
      example: "Enum status {\n  active\n  inactive\n}\n\nTable users {\n  status status [not null]\n}",
    },
  },
  {
    match: /default/i,
    hint: {
      suggestions: ["dbml.hint.quoteStringDefault", "dbml.hint.backtickExpression"],
      example: "created_at timestamp [default: `now()`]",
    },
  },
  {
    match: /expected .*(\}|\{)/i,
    hint: { suggestions: ["dbml.hint.matchBraces", "dbml.hint.oneFieldPerLine"] },
  },
];

/** The advice for one parser message, or a general set when nothing matches. */
export function hintFor(error: string): DbmlHint {
  for (const pattern of PATTERNS) {
    if (pattern.match.test(error)) return pattern.hint;
  }
  return {
    suggestions: ["dbml.hint.matchBraces", "dbml.hint.fieldShape", "dbml.hint.settingsBrackets"],
    example: "Table users {\n  id integer [pk, increment]\n  email varchar(120) [unique, not null]\n}",
  };
}
