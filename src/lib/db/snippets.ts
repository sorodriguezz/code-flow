/**
 * The console's snippets: a prefix you type, and the text it expands to.
 *
 * The body is Monaco snippet syntax — `${1:column}` is a tab stop with a placeholder, `$0` where the
 * caret ends — so a snippet can leave you exactly where the next word goes. `language` keeps a SQL
 * snippet out of a Mongo console and the other way round; `any` is offered everywhere.
 */
export interface DbSnippet {
  id: string;
  prefix: string;
  description: string;
  body: string;
  language: "sql" | "javascript" | "redis" | "any";
}

export const DEFAULT_SNIPPETS: DbSnippet[] = [
  { id: "sel", prefix: "sel", description: "SELECT … FROM", body: "SELECT ${2:*}\nFROM ${1:table}\n$0", language: "sql" },
  {
    id: "selw",
    prefix: "selw",
    description: "SELECT … WHERE",
    body: "SELECT ${3:*}\nFROM ${1:table}\nWHERE ${2:condition}$0",
    language: "sql",
  },
  {
    id: "cnt",
    prefix: "cnt",
    description: "SELECT COUNT(*) … GROUP BY",
    body: "SELECT ${2:column}, COUNT(*)\nFROM ${1:table}\nGROUP BY ${2:column}\nORDER BY 2 DESC$0",
    language: "sql",
  },
  {
    id: "ins",
    prefix: "ins",
    description: "INSERT INTO … VALUES",
    body: "INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})$0",
    language: "sql",
  },
  {
    id: "upd",
    prefix: "upd",
    description: "UPDATE … SET … WHERE",
    body: "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}$0",
    language: "sql",
  },
  { id: "del", prefix: "del", description: "DELETE … WHERE", body: "DELETE FROM ${1:table}\nWHERE ${2:condition}$0", language: "sql" },
  {
    id: "cte",
    prefix: "cte",
    description: "WITH … AS (…)",
    body: "WITH ${1:name} AS (\n  ${2:SELECT 1}\n)\nSELECT *\nFROM ${1:name}$0",
    language: "sql",
  },
  {
    id: "join",
    prefix: "join",
    description: "JOIN … ON",
    body: "JOIN ${1:table} ${2:t} ON ${2:t}.${3:id} = ${4:other}.${5:id}$0",
    language: "sql",
  },
  { id: "find", prefix: "find", description: "db.collection.find()", body: "db.${1:collection}.find({ $2 })$0", language: "javascript" },
  {
    id: "agg",
    prefix: "agg",
    description: "db.collection.aggregate()",
    body: "db.${1:collection}.aggregate([\n  { \\$match: { $2 } },\n  { \\$group: { _id: \"\\$${3:field}\", count: { \\$sum: 1 } } }\n])$0",
    language: "javascript",
  },
];

/** A stored list, with anything malformed dropped rather than failing the whole list. */
export function parseSnippets(raw: string): DbSnippet[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return DEFAULT_SNIPPETS;
    return value
      .filter(
        (entry): entry is DbSnippet =>
          !!entry &&
          typeof entry.id === "string" &&
          typeof entry.prefix === "string" &&
          entry.prefix.trim() !== "" &&
          typeof entry.body === "string",
      )
      .map((entry) => ({
        id: entry.id,
        prefix: entry.prefix.trim(),
        description: typeof entry.description === "string" ? entry.description : "",
        body: entry.body,
        language: ["sql", "javascript", "redis"].includes(entry.language) ? entry.language : "any",
      }));
  } catch {
    return DEFAULT_SNIPPETS;
  }
}

/** The snippets a console in `language` offers. */
export function snippetsFor(snippets: DbSnippet[], language: "sql" | "javascript" | "redis"): DbSnippet[] {
  return snippets.filter((snippet) => snippet.language === "any" || snippet.language === language);
}

/** A selection saved as a snippet: plain text, so a literal `$` must not read as a tab stop. */
export function escapeSnippetBody(text: string): string {
  return text.replace(/[\\$}]/g, (char) => `\\${char}`);
}
