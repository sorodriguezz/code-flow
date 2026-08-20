import type { DbmlSchema } from "../types";
import { banner, baseType, codegenRefs, NOTHING_TO_CONVERT, pascal } from "./shared";

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
  const lines: string[] = [banner(dialect === "sqlserver" ? "SQL Server DDL" : "PostgreSQL DDL", "--"), ""];

  // Enums exist in PostgreSQL and not in SQL Server, where the honest translation is a check
  // constraint — which needs the column to exist, so it is left as a comment rather than emitted
  // against a table that may not have a column of that type at all.
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
    const columns = table.fields.map((field) => {
      let type = field.type.replace(/\[\]/g, "").toUpperCase();
      if (mssql) {
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
      if (field.notNull || field.pk) parts.push("NOT NULL");
      if (field.unique && !field.pk) parts.push("UNIQUE");
      if (field.pk) parts.push("PRIMARY KEY");
      if (field.default !== null && !field.increment) parts.push(`DEFAULT ${field.default}`);
      return parts.join(" ");
    });
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
    lines.push(`  ADD CONSTRAINT ${quote(`fk_${ref.fkTable.name}_${ref.fkField}`)}`);
    lines.push(`  FOREIGN KEY (${quote(ref.fkField)}) REFERENCES ${parent} (${quote(ref.pkField)});`, "");
  }

  return lines.join("\n").trimEnd() + "\n";
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
      // between a translated schema and a transliterated one.
      const ref = refs.find(
        (candidate) => candidate.fkTable.id === table.id && candidate.fkField === field.name,
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
      if (field.default !== null) parts.push(`default: ${field.default}`);
      lines.push(`  ${field.name}: { ${parts.join(", ")} },`);
    }
    lines.push("}, { timestamps: true });", "");
    lines.push(`const ${model} = mongoose.model('${model}', ${model}Schema);`, "");
  }

  lines.push(`module.exports = { ${schema.tables.map((table) => pascal(table.name)).join(", ")} };`);
  return lines.join("\n").trimEnd() + "\n";
}
