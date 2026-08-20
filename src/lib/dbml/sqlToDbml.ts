/**
 * SQL DDL in, DBML out.
 *
 * **A reader, not a parser.** It finds `CREATE TABLE` statements and the constraints inside and
 * after them, and ignores everything else in the file — triggers, grants, inserts, procedures. That
 * is the right shape for what it is for: somebody pastes a schema dump, most of which is not the
 * schema, and wants the tables out of it. A real SQL grammar would reject the whole paste over a
 * stored procedure it could not parse.
 *
 * `parse.ts` wraps this with `@dbml/core`'s own dialect-aware importer, which is tried first — see
 * `sqlToDbmlWithCore`. This is the fallback, and the only path that costs nothing to load.
 */

interface Column {
  name: string;
  type: string;
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  increment: boolean;
  default: string | null;
}

interface Table {
  name: string;
  columns: Column[];
  /** Multi-column uniques, which have no per-column spelling in DBML. */
  uniqueGroups: string[][];
}

interface Reference {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

function unquote(value: string): string {
  return value.replace(/^["'`[]|["'`\]]$/g, "").trim();
}

/**
 * The engine's type name as DBML would write it.
 *
 * Normalised rather than copied, because the whole point of importing a schema is to get something
 * that reads as DBML — `NVARCHAR(MAX)` and `int4` are not wrong, they are just not what anyone
 * would have typed.
 */
function normaliseType(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (["INT", "INTEGER", "INT4"].includes(upper)) return "integer";
  if (["BIGINT", "INT8"].includes(upper)) return "bigint";
  if (["SMALLINT", "INT2", "TINYINT"].includes(upper)) return "smallint";
  if (upper === "SERIAL") return "integer";
  if (upper === "BIGSERIAL") return "bigint";
  if (upper === "SMALLSERIAL") return "smallint";
  if (upper === "BIT") return "boolean";
  if (["FLOAT", "REAL", "FLOAT4"].includes(upper)) return "float";
  if (["DOUBLE", "DOUBLE PRECISION", "FLOAT8"].includes(upper)) return "double";
  if (upper.startsWith("DECIMAL") || upper.startsWith("NUMERIC")) {
    const args = raw.match(/\([\d,\s]+\)/);
    return args ? `decimal${args[0].replace(/\s+/g, "")}` : "decimal";
  }
  if (upper === "MONEY") return "decimal(19,4)";
  if (upper === "NVARCHAR(MAX)" || upper === "VARCHAR(MAX)") return "text";
  if (upper.startsWith("VARCHAR") || upper.startsWith("CHARACTER VARYING") || upper.startsWith("NVARCHAR")) {
    const length = raw.match(/\((\d+)\)/);
    return length ? `varchar(${length[1]})` : "varchar(255)";
  }
  if (["TEXT", "NTEXT", "LONGTEXT", "MEDIUMTEXT", "TINYTEXT", "CLOB"].includes(upper)) return "text";
  if (upper.startsWith("CHAR") || upper.startsWith("NCHAR")) {
    const length = raw.match(/\((\d+)\)/);
    return length ? `char(${length[1]})` : "char(1)";
  }
  if (["BOOLEAN", "BOOL"].includes(upper)) return "boolean";
  if (upper === "DATE") return "date";
  if (upper.startsWith("TIMESTAMP")) return "timestamp";
  if (upper.startsWith("DATETIME") || upper === "SMALLDATETIME") return "datetime";
  if (upper === "TIME") return "time";
  if (upper === "JSON") return "json";
  if (upper === "JSONB") return "jsonb";
  if (["UUID", "UNIQUEIDENTIFIER"].includes(upper)) return "uuid";
  if (["BYTEA", "BLOB"].includes(upper) || upper.startsWith("BINARY") || upper.startsWith("VARBINARY")) {
    return "blob";
  }
  return raw.trim().toLowerCase();
}

/** Splits on commas that are not inside brackets — a column list is full of the other kind. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * The types whose names contain a space.
 *
 * They have to be listed, because "the type is the second word" is what a column definition looks
 * like right up until `id SERIAL PRIMARY KEY` — where the naive read takes `id SERIAL PRIMARY` as
 * the name and `KEY` as the type. Matching the known multi-word types first, and a single word
 * otherwise, is what tells the two apart.
 */
const MULTI_WORD_TYPES =
  "double\\s+precision|character\\s+varying|national\\s+character\\s+varying|bit\\s+varying|" +
  "timestamp\\s+with(?:out)?\\s+time\\s+zone|time\\s+with(?:out)?\\s+time\\s+zone";

const COLUMN = new RegExp(
  // name: quoted anything, or a bare identifier
  "^(\"[^\"]+\"|'[^']+'|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_]\\w*)" +
    "\\s+" +
    // type: a known multi-word name or one word, then optional arguments and array marker
    "((?:" + MULTI_WORD_TYPES + "|[A-Za-z_]\\w*)(?:\\s*\\([^)]*\\))?(?:\\s*\\[\\])?)" +
    // everything after it is constraints
    "(?:\\s+([\\s\\S]*))?$",
  "i",
);

function readColumn(line: string): Column | null {
  const match = line.match(COLUMN);
  if (!match) return null;
  const name = unquote(match[1]);
  const rawType = match[2].trim();
  const rest = (match[3] ?? "").trim();
  const all = `${rawType} ${rest}`.trim();
  // A line that begins with a keyword is a table constraint the caller did not recognise, not a
  // column called `PRIMARY`. Checked here as well, because `readColumn` is the fallback arm.
  if (/^(primary|foreign|unique|constraint|check|index|key|exclude)$/i.test(name)) return null;

  const increment =
    /\bAUTO_INCREMENT\b/i.test(all) ||
    /\bIDENTITY\b/i.test(all) ||
    /\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i.test(all) ||
    /^(BIG|SMALL)?SERIAL\b/i.test(rawType);

  const pk = /\bPRIMARY\s+KEY\b/i.test(all);
  const defaultMatch = all.match(/\bDEFAULT\s+('[^']*'|"[^"]*"|`[^`]*`|[\w.]+(?:\([^)]*\))?)/i);

  const cleanType = rawType
    .replace(/\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/gi, "")
    .replace(/\bIDENTITY\s*(\(\s*\d+\s*,\s*\d+\s*\))?/gi, "")
    .replace(/\bAUTO_INCREMENT\b/gi, "")
    .trim();
  if (!cleanType) return null;

  return {
    name,
    type: normaliseType(cleanType),
    pk,
    unique: /\bUNIQUE\b/i.test(all) && !pk,
    notNull: /\bNOT\s+NULL\b/i.test(all) || pk,
    increment,
    // An identity column's default is the sequence, which `increment` already says.
    default: defaultMatch && !increment ? defaultMatch[1] : null,
  };
}

/** The DBML for one SQL script. `dialect` is accepted for symmetry with the core importer. */
export function sqlToDbml(sql: string): string {
  const clean = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();

  const tables: Table[] = [];
  const refs: Reference[] = [];

  // `([^;]*)` is greedy on purpose: it backtracks to the *last* `)` before the `;`, so a
  // `VARCHAR(255)` in the first column does not end the statement.
  const createTable =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?(\w+)["'`\]]?\s*\(([^;]*)\)\s*(?:WITHOUT\s+ROWID\s*)?;?/gi;

  let match: RegExpExecArray | null;
  while ((match = createTable.exec(clean)) !== null) {
    const name = match[1];
    const columns: Column[] = [];
    const primaryKeys: string[] = [];
    const uniqueGroups: string[][] = [];

    for (const part of splitTopLevel(match[2])) {
      const line = part.trim();
      if (!line) continue;

      if (/^(?:CONSTRAINT\s+["'`[]?\w+["'`\]]?\s+)?PRIMARY\s+KEY\s*\(/i.test(line)) {
        const keys = line.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
        if (keys) for (const column of keys[1].split(",")) primaryKeys.push(unquote(column));
        continue;
      }
      if (/^(?:CONSTRAINT\s+["'`[]?\w+["'`\]]?\s+)?UNIQUE\s*(?:KEY\s+\w+\s*)?\(/i.test(line)) {
        const keys = line.match(/UNIQUE\s*(?:KEY\s+\w+\s*)?\(([^)]+)\)/i);
        if (keys) uniqueGroups.push(keys[1].split(",").map(unquote));
        continue;
      }
      if (/^(?:CONSTRAINT\s+["'`[]?\w+["'`\]]?\s+)?FOREIGN\s+KEY\s*\(/i.test(line)) {
        const key = line.match(
          /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?(\w+)["'`\]]?\s*\(([^)]+)\)/i,
        );
        if (key) {
          refs.push({
            fromTable: name,
            fromColumn: unquote(key[1]),
            toTable: key[2],
            toColumn: unquote(key[3]),
          });
        }
        continue;
      }
      if (/^(CHECK|EXCLUDE)\s*\(/i.test(line)) continue;
      if (/^(INDEX|KEY|FULLTEXT|SPATIAL)\s/i.test(line)) continue;
      if (/^CONSTRAINT\s+["'`[]?\w+["'`\]]?\s+(FOREIGN|CHECK)/i.test(line)) continue;

      // An inline `REFERENCES` on the column itself, which is how most hand-written DDL does it.
      const inline = line.match(
        /\bREFERENCES\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?(\w+)["'`\]]?\s*\(([^)]+)\)/i,
      );
      const column = readColumn(line);
      if (!column) continue;
      if (inline) {
        refs.push({
          fromTable: name,
          fromColumn: column.name,
          toTable: inline[1],
          toColumn: unquote(inline[2]),
        });
      }
      columns.push(column);
    }

    for (const key of primaryKeys) {
      const column = columns.find((candidate) => candidate.name === key);
      if (column) {
        column.pk = true;
        column.notNull = true;
      }
    }
    for (const group of uniqueGroups) {
      if (group.length !== 1) continue;
      const column = columns.find((candidate) => candidate.name === group[0]);
      if (column && !column.pk) column.unique = true;
    }

    if (columns.length > 0) {
      tables.push({ name, columns, uniqueGroups: uniqueGroups.filter((group) => group.length > 1) });
    }
  }

  const alterKey =
    /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?(\w+)["'`\]]?\s+ADD\s+(?:CONSTRAINT\s+["'`[]?\w+["'`\]]?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?(\w+)["'`\]]?\s*\(([^)]+)\)/gi;
  while ((match = alterKey.exec(clean)) !== null) {
    refs.push({
      fromTable: match[1],
      fromColumn: unquote(match[2]),
      toTable: match[3],
      toColumn: unquote(match[4]),
    });
  }

  if (tables.length === 0) return "";

  const lines: string[] = [];
  for (const table of tables) {
    lines.push(`Table ${table.name} {`);
    for (const column of table.columns) {
      const settings: string[] = [];
      if (column.pk) settings.push("pk");
      if (column.increment) settings.push("increment");
      if (column.notNull && !column.pk) settings.push("not null");
      if (column.unique) settings.push("unique");
      if (column.default !== null) settings.push(`default: ${column.default}`);
      lines.push(`  ${column.name} ${column.type}${settings.length > 0 ? ` [${settings.join(", ")}]` : ""}`);
    }
    if (table.uniqueGroups.length > 0) {
      lines.push("  indexes {");
      for (const group of table.uniqueGroups) lines.push(`    (${group.join(", ")}) [unique]`);
      lines.push("  }");
    }
    lines.push("}", "");
  }

  // Deduplicated: an inline `REFERENCES` and a later `ALTER TABLE` for the same key are one
  // relationship written twice, and DBML rejects the second one outright.
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.fromTable}.${ref.fromColumn}>${ref.toTable}.${ref.toColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`Ref: ${ref.fromTable}.${ref.fromColumn} > ${ref.toTable}.${ref.toColumn}`);
  }

  return lines.join("\n").trimEnd() + "\n";
}
