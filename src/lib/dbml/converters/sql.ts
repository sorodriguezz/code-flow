import type { DbmlSchema } from "../types";
import {
  banner,
  baseType,
  codegenRefs,
  compositeKey,
  defaultOf,
  findingLines,
  isComposite,
  isKeyColumn,
  isNowExpression,
  isUuidExpression,
  jsLiteral,
  NOTHING_TO_CONVERT,
  pascal,
  type DefaultValue,
} from "./shared";

/** The relational dialects this emits, plus Mongo — which is not SQL and is handled apart. */
export type SqlDialect = "postgresql" | "sqlserver" | "mongodb";

export function toSql(schema: DbmlSchema, dialect: SqlDialect): string {
  if (schema.tables.length === 0) return NOTHING_TO_CONVERT;
  return dialect === "mongodb" ? toMongoose(schema) : toDdl(schema, dialect);
}

/**
 * `CREATE TABLE` and the foreign keys that follow them.
 *
 * The constraints are emitted *after* every table rather than inline, which is the only ordering
 * that works: a schema with a cycle in it — `users.default_org` and `orgs.owner_id` — cannot be
 * created in any table order at all if the keys are inline.
 */
function toDdl(schema: DbmlSchema, dialect: "postgresql" | "sqlserver"): string {
  const mssql = dialect === "sqlserver";
  const quote = (name: string) => (mssql ? `[${name}]` : `"${name}"`);
  const identity = mssql ? "IDENTITY(1,1)" : "GENERATED ALWAYS AS IDENTITY";
  const lines: string[] = [
    banner(dialect === "sqlserver" ? "SQL Server DDL" : "PostgreSQL DDL", "--"),
    "",
    ...findingLines(schema, "--"),
  ];

  // Enums exist in PostgreSQL and not in SQL Server, where the honest translation is a check
  // constraint on each column typed with one — see the column loop below. The declaration itself
  // is left as a comment, since there is nothing in SQL Server to create.
  const enumsByName = new Map(schema.enums.map((entry) => [entry.name.toLowerCase(), entry]));
  for (const entry of schema.enums) {
    if (mssql) {
      lines.push(`-- enum ${entry.name}: ${entry.values.map((value) => value.name).join(", ")}`);
      continue;
    }
    const values = entry.values.map((value) => `'${value.name}'`).join(", ");
    lines.push(`CREATE TYPE ${quote(entry.name)} AS ENUM (${values});`);
  }
  if (schema.enums.length > 0) lines.push("");

  for (const table of schema.tables) {
    const qualified = table.schema === "public" ? quote(table.name) : `${quote(table.schema)}.${quote(table.name)}`;
    lines.push(`CREATE TABLE ${qualified} (`);
    const composite = compositeKey(table);
    const columns = table.fields.map((field) => {
      let type = field.type.replace(/\[\]/g, "").toUpperCase();
      const asEnum = mssql ? enumsByName.get(baseType(field.type)) : undefined;
      if (asEnum) {
        const values = asEnum.values.map((value) => `'${value.name.replace(/'/g, "''")}'`).join(", ");
        type = `NVARCHAR(255) CHECK (${quote(field.name)} IN (${values}))`;
      } else if (mssql) {
        type = type
          .replace(/^BOOLEAN$/, "BIT")
          .replace(/^TEXT$/, "NVARCHAR(MAX)")
          .replace(/^JSONB?$/, "NVARCHAR(MAX)")
          .replace(/^UUID$/, "UNIQUEIDENTIFIER")
          .replace(/^SERIAL$/, "INT")
          .replace(/^TIMESTAMP$/, "DATETIME2");
      }
      const parts = [`  ${quote(field.name)} ${type}`];
      if (field.pk && field.increment) parts.push(identity);
      if (field.notNull || isKeyColumn(table, field)) parts.push("NOT NULL");
      if (field.unique && !field.pk) parts.push("UNIQUE");
      // A key over several columns is one table constraint, below — `PRIMARY KEY` on each of them
      // is two primary keys, which no database accepts.
      if (field.pk && !composite) parts.push("PRIMARY KEY");
      const value = defaultOf(field);
      if (value && !field.increment) parts.push(`DEFAULT ${sqlDefault(value, dialect)}`);
      return parts.join(" ");
    });
    if (composite) columns.push(`  PRIMARY KEY (${composite.map(quote).join(", ")})`);
    lines.push(columns.join(",\n"), ");", "");

    for (const index of table.indexes) {
      if (index.pk || index.columns.length === 0) continue;
      const name = index.name || `idx_${table.name}_${index.columns.join("_")}`;
      const unique = index.unique ? "UNIQUE " : "";
      lines.push(
        `CREATE ${unique}INDEX ${quote(name)} ON ${qualified} (${index.columns.map(quote).join(", ")});`,
      );
    }
    if (table.indexes.some((index) => !index.pk)) lines.push("");
  }

  for (const ref of codegenRefs(schema)) {
    if (ref.kind === "many-to-many") {
      lines.push(
        `-- ${ref.fkTable.name} <> ${ref.pkTable.name}: a many-to-many needs a join table, which this schema does not declare.`,
      );
      continue;
    }
    const child = ref.fkTable.schema === "public" ? quote(ref.fkTable.name) : `${quote(ref.fkTable.schema)}.${quote(ref.fkTable.name)}`;
    const parent = ref.pkTable.schema === "public" ? quote(ref.pkTable.name) : `${quote(ref.pkTable.schema)}.${quote(ref.pkTable.name)}`;
    lines.push(`ALTER TABLE ${child}`);
    lines.push(`  ADD CONSTRAINT ${quote(`fk_${ref.fkTable.name}_${ref.fkFields.join("_")}`)}`);
    lines.push(
      `  FOREIGN KEY (${ref.fkFields.map(quote).join(", ")}) REFERENCES ${parent} (${ref.pkFields.map(quote).join(", ")});`,
      "",
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * A default as the dialect spells it.
 *
 * An expression is written as an expression — `DEFAULT now()`, never `DEFAULT \`now()\``, which is
 * DBML's quoting and no database's. SQL Server gets the handful of expressions that exist there
 * under another name; anything else is passed through as written, because it is the author's SQL.
 * A string is re-quoted the SQL way (`''`), not the way the parser escaped it (`\'`).
 */
export function sqlDefault(value: DefaultValue, dialect: "postgresql" | "sqlserver" | "mysql"): string {
  switch (value.kind) {
    case "expression":
      if (dialect === "sqlserver" && isNowExpression(value.sql)) return "GETDATE()";
      if (dialect === "sqlserver" && isUuidExpression(value.sql)) return "NEWID()";
      if (dialect === "mysql" && isNowExpression(value.sql)) return "CURRENT_TIMESTAMP";
      if (dialect === "mysql" && isUuidExpression(value.sql)) return "(UUID())";
      // MySQL takes an arbitrary expression default only in parentheses (8.0.13+).
      return dialect === "mysql" ? `(${value.sql})` : value.sql;
    case "string":
      return `'${value.value.replace(/'/g, "''")}'`;
    case "number":
      return value.text;
    case "boolean":
      if (dialect === "sqlserver") return value.value ? "1" : "0";
      return value.value ? "TRUE" : "FALSE";
    case "null":
      return "NULL";
  }
}

/** Mongoose schemas, which is what "MongoDB" means for a document with tables in it. */
function toMongoose(schema: DbmlSchema): string {
  const mongoType = (type: string): string => {
    const base = baseType(type);
    if (["int", "integer", "bigint", "smallint", "float", "double", "decimal", "numeric", "real", "serial"].includes(base)) {
      return "Number";
    }
    if (["boolean", "bool"].includes(base)) return "Boolean";
    if (["date", "datetime", "timestamp"].includes(base)) return "Date";
    if (["json", "jsonb"].includes(base)) return "Schema.Types.Mixed";
    return "String";
  };

  const refs = codegenRefs(schema);
  const lines: string[] = [
    banner("Mongoose schemas"),
    "",
    ...findingLines(schema),
    "const mongoose = require('mongoose');",
    "const { Schema } = mongoose;",
    "",
  ];

  for (const table of schema.tables) {
    const model = pascal(table.name);
    lines.push(`const ${model}Schema = new Schema({`);
    for (const field of table.fields) {
      if (field.pk && (field.name === "id" || field.name === "_id")) {
        lines.push("  // _id is managed by MongoDB itself");
        continue;
      }
      // A foreign key becomes a reference rather than a number: that is the whole difference
      // between a translated schema and a transliterated one. Only a single-column key can: an
      // ObjectId stands for one value, so the columns of a composite key stay plain fields.
      const ref = refs.find(
        (candidate) =>
          candidate.fkTable.id === table.id &&
          !isComposite(candidate) &&
          candidate.kind !== "many-to-many" &&
          candidate.fkFields[0] === field.name,
      );
      if (ref) {
        lines.push(
          `  ${field.name}: { type: Schema.Types.ObjectId, ref: '${pascal(ref.pkTable.name)}'${field.notNull ? ", required: true" : ""} },`,
        );
        continue;
      }
      const parts = [`type: ${mongoType(field.type)}`];
      if (field.notNull) parts.push("required: true");
      if (field.unique && !field.pk) parts.push("unique: true");
      const value = defaultOf(field);
      let note = "";
      if (value?.kind === "expression") {
        // A database expression means nothing to a document store, except the one every schema
        // has: "when the row was made" is `Date.now`, called per document. Anything else is said
        // rather than quoted into a string that would be stored verbatim.
        if (isNowExpression(value.sql)) parts.push("default: Date.now");
        else note = ` // default ${value.sql} is a database expression`;
      } else if (value) {
        parts.push(`default: ${jsLiteral(value)}`);
      }
      lines.push(`  ${field.name}: { ${parts.join(", ")} },${note}`);
    }
    lines.push("}, { timestamps: true });", "");
    lines.push(`const ${model} = mongoose.model('${model}', ${model}Schema);`, "");
  }

  lines.push(`module.exports = { ${schema.tables.map((table) => pascal(table.name)).join(", ")} };`);
  return lines.join("\n").trimEnd() + "\n";
}
