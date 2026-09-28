import type { DbmlField, DbmlSchema } from "../types";
import {
  banner,
  baseType,
  camel,
  codegenRefs,
  compositeKey,
  defaultOf,
  findingLines,
  isComposite,
  isNowExpression,
  isUuidExpression,
  jsLiteral,
  lengthOf,
  NOTHING_TO_CONVERT,
  precisionOf,
} from "./shared";

interface Column {
  /** The helper to import from `drizzle-orm/pg-core`. */
  helper: string;
  /** The call, arguments included. */
  call: string;
}

function column(field: DbmlField): Column {
  const base = baseType(field.type);
  const length = lengthOf(field.type);
  const precision = precisionOf(field.type);
  const call = (helper: string, args = "") =>
    ({ helper, call: `${helper}('${field.name}'${args})` });

  if ((field.pk && field.increment) || base === "serial") return call("serial");
  if (base === "bigserial") return call("bigserial", ", { mode: 'number' }");
  if (base === "int" || base === "integer" || base === "int4") return call("integer");
  if (base === "bigint" || base === "int8") return call("bigint", ", { mode: 'number' }");
  if (base === "smallint" || base === "int2") return call("smallint");
  if (base === "varchar" || base === "nvarchar" || base === "character varying") {
    return call("varchar", length ? `, { length: ${length} }` : "");
  }
  if (base === "char" || base === "nchar") return call("char", length ? `, { length: ${length} }` : "");
  if (base === "text") return call("text");
  if (base === "boolean" || base === "bool") return call("boolean");
  if (base === "real" || base === "float4" || base === "float") return call("real");
  if (base === "double" || base === "double precision" || base === "float8") return call("doublePrecision");
  if (base === "decimal" || base === "numeric") {
    return call("numeric", precision ? `, { precision: ${precision[0]}, scale: ${precision[1]} }` : "");
  }
  if (base === "date") return call("date");
  if (base === "timestamp" || base === "datetime") return call("timestamp");
  if (base === "time") return call("time");
  if (base === "json") return call("json");
  if (base === "jsonb") return call("jsonb");
  if (base === "uuid") return call("uuid");
  return call("text");
}

/**
 * A Drizzle schema for Postgres.
 *
 * The imports are collected as the columns are emitted rather than listed up front, so the file
 * imports exactly what it uses — a `drizzle-orm/pg-core` import of thirty unused helpers is the
 * first thing a linter complains about in generated code.
 */
export function toDrizzle(schema: DbmlSchema): string {
  if (schema.tables.length === 0) return NOTHING_TO_CONVERT;

  const imports = new Set<string>(["pgTable"]);
  /** `sql` comes from `drizzle-orm` itself rather than from `pg-core`, and only when a default needs it. */
  let usesSql = false;
  const blocks: string[] = [];
  const refs = codegenRefs(schema);
  const enumsByName = new Map(schema.enums.map((entry) => [entry.name.toLowerCase(), entry]));

  for (const entry of schema.enums) {
    imports.add("pgEnum");
    const values = entry.values.map((value) => `'${value.name}'`).join(", ");
    blocks.push(`export const ${camel(entry.name)}Enum = pgEnum('${entry.name}', [${values}]);`);
  }
  if (schema.enums.length > 0) blocks.push("");

  for (const table of schema.tables) {
    const own = refs.filter((ref) => ref.fkTable.id === table.id && ref.kind !== "many-to-many");
    // A single-column key is a `.references()` on its column; a composite one cannot be — it is a
    // `foreignKey()` over both columns in the table's extra config, below.
    const keys = new Map(own.filter((ref) => !isComposite(ref)).map((ref) => [ref.fkFields[0], ref]));
    const composite = own.filter(isComposite);
    // A key over several columns is a `primaryKey()` in the extra config for the same reason.
    const primary = compositeKey(table);

    const lines = [`export const ${camel(table.name)} = pgTable('${table.name}', {`];
    for (const field of table.fields) {
      const asEnum = enumsByName.get(baseType(field.type));
      let call: string;
      if (asEnum) {
        call = `${camel(asEnum.name)}Enum('${field.name}')`;
      } else {
        const emitted = column(field);
        imports.add(emitted.helper);
        call = emitted.call;
      }

      const chain: string[] = [];
      if (field.pk && !primary) chain.push(".primaryKey()");
      if (field.notNull && !(field.pk && !primary)) chain.push(".notNull()");
      if (field.unique && !field.pk) chain.push(".unique()");
      const value = field.increment ? null : defaultOf(field);
      if (value?.kind === "expression") {
        if (isNowExpression(value.sql)) chain.push(".defaultNow()");
        else if (isUuidExpression(value.sql)) chain.push(".defaultRandom()");
        else {
          // Raw SQL goes through the `sql` tag; without it the expression is either a syntax error
          // in the generated file or, quoted, a string default.
          usesSql = true;
          chain.push(`.default(sql\`${value.sql.replace(/[`\\]/g, "\\$&")}\`)`);
        }
      } else if (value?.kind === "number" && call.startsWith("numeric(")) {
        // `numeric` reads and writes strings in Drizzle, so its default is one too.
        chain.push(`.default('${value.text}')`);
      } else if (value) {
        chain.push(`.default(${jsLiteral(value)})`);
      }
      const ref = keys.get(field.name);
      if (ref) chain.push(`.references(() => ${camel(ref.pkTable.name)}.${camel(ref.pkFields[0])})`);

      lines.push(`  ${camel(field.name)}: ${call}${chain.join("")},`);
    }
    if (composite.length > 0 || primary) {
      lines.push("}, (table) => [");
      if (primary) {
        imports.add("primaryKey");
        lines.push(`  primaryKey({ columns: [${primary.map((name) => `table.${camel(name)}`).join(", ")}] }),`);
      }
      if (composite.length > 0) imports.add("foreignKey");
      for (const ref of composite) {
        const parent = camel(ref.pkTable.name);
        lines.push("  foreignKey({");
        lines.push(`    columns: [${ref.fkFields.map((name) => `table.${camel(name)}`).join(", ")}],`);
        lines.push(`    foreignColumns: [${ref.pkFields.map((name) => `${parent}.${camel(name)}`).join(", ")}],`);
        lines.push("  }),");
      }
      lines.push("]);");
    } else {
      lines.push("});");
    }
    blocks.push(lines.join("\n"), "");
  }

  const importLines = [
    ...(usesSql ? ["import { sql } from 'drizzle-orm';"] : []),
    `import { ${[...imports].sort().join(", ")} } from 'drizzle-orm/pg-core';`,
  ];
  return (
    [banner("Drizzle ORM schema"), "", ...findingLines(schema), ...importLines, "", ...blocks]
      .join("\n")
      .trimEnd() + "\n"
  );
}
