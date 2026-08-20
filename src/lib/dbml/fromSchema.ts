import type { DbSchemaDiagram } from "../../types/database";

/**
 * A live database's schema, written out as DBML.
 *
 * The bridge between the two halves of this app that already know about tables: the Database
 * workspace reads a real catalogue, and the Diagrams workspace edits a schema as text. Without
 * this, taking what is actually deployed and *working on it* means retyping it.
 *
 * The counterpart of `toMermaid` in `db/erLayout.ts`, and deliberately in this folder rather than
 * beside it: Mermaid is a picture of a schema, DBML *is* a schema — everything that reads one lives
 * here, and a second DBML emitter is a second answer to how a `bit` column should be spelled.
 */

/** Quotes a name only when DBML would otherwise misread it. */
function name(raw: string): string {
  return /^[A-Za-z_]\w*$/.test(raw) ? raw : `"${raw.replace(/"/g, '\\"')}"`;
}

/**
 * The engine's type as DBML would write it.
 *
 * Deliberately light: a catalogue's `character varying(120)` becomes `varchar(120)` because that is
 * what a person writes, but anything unrecognised is passed straight through. DBML does not
 * validate types, so an unfamiliar one costs nothing — while guessing at it would silently change
 * the schema being described.
 */
function typeOf(raw: string): string {
  const type = raw.trim();
  if (!type) return "varchar";
  const lower = type.toLowerCase();
  const length = lower.match(/\((\d+(?:\s*,\s*\d+)?)\)/)?.[1]?.replace(/\s+/g, "");
  const base = lower.replace(/\(.*\)/, "").trim();
  const map: Record<string, string> = {
    int4: "integer", int8: "bigint", int2: "smallint", int: "integer",
    "character varying": "varchar", nvarchar: "varchar", character: "char", nchar: "char",
    bpchar: "char", ntext: "text", clob: "text",
    float4: "float", float8: "double", "double precision": "double",
    bit: "boolean", tinyint: "smallint",
    timestamptz: "timestamptz", "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp", datetime2: "datetime",
    uniqueidentifier: "uuid", bytea: "blob", varbinary: "blob", binary: "blob",
    objectid: "varchar",
  };
  const mapped = map[base] ?? base;
  return length && !mapped.includes("(") ? `${mapped}(${length})` : mapped;
}

/**
 * Turns a fetched schema into a DBML document.
 *
 * `notes` from the fetch — a truncation, a sample size — are carried across as comments rather than
 * dropped. A schema that was cut short at two hundred tables must say so in the document, or the
 * diagram it produces is a confident picture of a partial answer.
 */
export function schemaToDbml(diagram: DbSchemaDiagram, title?: string): string {
  const lines: string[] = [];
  const heading = title || diagram.schema || diagram.database || "schema";
  lines.push(`// ${heading} — read from the database by CodeFlow`);
  for (const note of diagram.notes) lines.push(`// ${note}`);
  lines.push("");

  // Which columns are the near end of a foreign key: those become an inline `ref`, so the document
  // reads the way somebody would have written it rather than as a wall of `Ref:` lines at the end.
  const inline = new Map<string, { table: string; column: string }>();
  const emitted = new Set<string>();
  for (const edge of diagram.edges) {
    if (edge.inferred) continue;
    const key = `${edge.from_schema ?? ""}.${edge.from_table}|${edge.from_column}`;
    if (inline.has(key)) continue;
    inline.set(key, {
      table: edge.to_schema ? `${edge.to_schema}.${edge.to_table}` : edge.to_table,
      column: edge.to_column,
    });
  }

  for (const table of diagram.tables) {
    const qualified = table.schema ? `${name(table.schema)}.${name(table.name)}` : name(table.name);
    // A view has no keys and cannot be written to; saying which it is keeps the document honest
    // when it is read back as a picture of the database.
    if (table.kind !== "table") lines.push(`// ${table.kind}`);
    lines.push(`Table ${qualified} {`);
    for (const column of table.columns) {
      const settings: string[] = [];
      if (column.primary_key) settings.push("pk");
      else if (!column.nullable) settings.push("not null");
      const key = `${table.schema ?? ""}.${table.name}|${column.name}`;
      const target = inline.get(key);
      if (target && !emitted.has(key)) {
        emitted.add(key);
        settings.push(`ref: > ${target.table}.${target.column}`);
      }
      lines.push(
        `  ${name(column.name)} ${typeOf(column.data_type)}${settings.length > 0 ? ` [${settings.join(", ")}]` : ""}`,
      );
    }
    lines.push("}", "");
  }

  // Whatever could not be written inline — a guessed edge, or a second key on a column that
  // already carries one — as a standalone reference, with the guesses marked as guesses.
  for (const edge of diagram.edges) {
    const key = `${edge.from_schema ?? ""}.${edge.from_table}|${edge.from_column}`;
    if (!edge.inferred && emitted.has(key) && inline.get(key)?.column === edge.to_column) continue;
    const from = edge.from_schema ? `${edge.from_schema}.${edge.from_table}` : edge.from_table;
    const to = edge.to_schema ? `${edge.to_schema}.${edge.to_table}` : edge.to_table;
    const line = `Ref: ${from}.${edge.from_column} > ${to}.${edge.to_column}`;
    lines.push(edge.inferred ? `// guessed from the column name: ${line}` : line);
  }

  return lines.join("\n").trimEnd() + "\n";
}
