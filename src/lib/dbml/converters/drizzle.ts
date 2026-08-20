import type { DbmlField, DbmlSchema } from "../types";
import {
  banner,
  baseType,
  camel,
  codegenRefs,
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
    const keys = new Map(
      refs
        .filter((ref) => ref.fkTable.id === table.id && ref.kind !== "many-to-many")
        .map((ref) => [ref.fkField, ref]),
    );

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
      if (field.pk) chain.push(".primaryKey()");
      if (field.notNull && !field.pk) chain.push(".notNull()");
      if (field.unique && !field.pk) chain.push(".unique()");
      if (field.default !== null && !field.increment) {
        const value = field.default;
        if (/^`?(now\(\)|current_timestamp)`?$/i.test(value)) chain.push(".defaultNow()");
        else if (/^`?(gen_random_uuid|uuid_generate_v4)\(\)`?$/i.test(value)) chain.push(".defaultRandom()");
        else chain.push(`.default(${value.replace(/^`|`$/g, "")})`);
      }
      const ref = keys.get(field.name);
      if (ref) chain.push(`.references(() => ${camel(ref.pkTable.name)}.${camel(ref.pkField)})`);

      lines.push(`  ${camel(field.name)}: ${call}${chain.join("")},`);
    }
    lines.push("});");
    blocks.push(lines.join("\n"), "");
  }

  const importLine = `import { ${[...imports].sort().join(", ")} } from 'drizzle-orm/pg-core';`;
  return [banner("Drizzle ORM schema"), "", importLine, "", ...blocks].join("\n").trimEnd() + "\n";
}
