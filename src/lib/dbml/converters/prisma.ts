import type { DbmlSchema, DbmlTable } from "../types";
import {
  banner,
  baseType,
  camel,
  codeName,
  codegenRefs,
  compositeKey,
  defaultOf,
  fieldOf,
  findingLines,
  isNowExpression,
  isOptional,
  NOTHING_TO_CONVERT,
  pascal,
  relationStem,
  type CodegenRef,
} from "./shared";

const PRISMA_TYPE: Record<string, string> = {
  int: "Int", integer: "Int", bigint: "BigInt", smallint: "Int", tinyint: "Int",
  mediumint: "Int", serial: "Int", bigserial: "BigInt",
  varchar: "String", text: "String", char: "String", nvarchar: "String",
  boolean: "Boolean", bool: "Boolean",
  float: "Float", double: "Float", real: "Float",
  decimal: "Decimal", numeric: "Decimal", money: "Decimal",
  date: "DateTime", datetime: "DateTime", timestamp: "DateTime", timestamptz: "DateTime",
  time: "String",
  json: "Json", jsonb: "Json",
  uuid: "String",
  bytea: "Bytes", binary: "Bytes", blob: "Bytes",
};

/** The relation property a foreign key suggests: `author_id` → `author`. */
function accessor(fkField: string): string {
  return camel(fkField.replace(/_(id|fk|key)$/i, "")) || camel(fkField);
}

interface RelationField {
  name: string;
  type: string;
  array: boolean;
  optional: boolean;
  fkFields?: string[];
  refFields?: string[];
  relationName: string | null;
}

/**
 * A Prisma schema.
 *
 * The hard part is not the types, it is **that Prisma requires both sides of every relation to be
 * declared and requires them to be unambiguous**. Two references between the same pair of tables —
 * `messages.sender_id` and `messages.recipient_id`, both to `users` — are a compile error in Prisma
 * unless each carries a distinct `@relation` name. So the pairs are counted first and named only
 * where they collide, which keeps the common case clean and the awkward case correct.
 */
export function toPrisma(schema: DbmlSchema): string {
  if (schema.tables.length === 0) return NOTHING_TO_CONVERT;
  const refs = codegenRefs(schema);

  // Where one pair of tables is joined more than once, every one of its relations needs a name.
  const pairs = new Map<string, number>();
  for (const ref of refs) {
    if (ref.kind === "many-to-many") continue;
    const key = [ref.fkTable.id, ref.pkTable.id].sort().join("|");
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const nameOf = (ref: CodegenRef): string | null => {
    if (ref.kind === "many-to-many") return null;
    const key = [ref.fkTable.id, ref.pkTable.id].sort().join("|");
    if ((pairs.get(key) ?? 0) < 2) return null;
    return `${pascal(codeName(ref.fkTable))}${pascal(codeName(ref.pkTable))}_${pascal(accessor(relationStem(ref)))}`;
  };

  const relations = new Map<string, RelationField[]>(schema.tables.map((table) => [table.id, []]));
  const push = (table: DbmlTable, field: RelationField) => relations.get(table.id)?.push(field);

  for (const ref of refs) {
    const relationName = nameOf(ref);
    // Missing only when the document is mid-edit, and an optional relation is the forgiving
    // guess: Prisma rejects a required relation whose key can be null, never the other way round.
    // A composite key is optional when any of its columns is.
    const optional = ref.fkFields.some((name) => {
      const key = fieldOf(ref.fkTable, name);
      return key ? isOptional(key, ref.fkTable) : true;
    });

    if (ref.kind === "many-to-many") {
      push(ref.fkTable, {
        name: `${camel(ref.pkTable.name)}s`,
        type: pascal(codeName(ref.pkTable)),
        array: true,
        optional: false,
        relationName,
      });
      push(ref.pkTable, {
        name: `${camel(ref.fkTable.name)}s`,
        type: pascal(codeName(ref.fkTable)),
        array: true,
        optional: false,
        relationName,
      });
      continue;
    }

    push(ref.fkTable, {
      name: accessor(relationStem(ref)) || camel(ref.pkTable.name),
      type: pascal(codeName(ref.pkTable)),
      array: false,
      optional,
      fkFields: ref.fkFields,
      refFields: ref.pkFields,
      relationName,
    });
    push(ref.pkTable, {
      name: ref.kind === "one-to-one" ? camel(ref.fkTable.name) : `${camel(ref.fkTable.name)}s`,
      type: pascal(codeName(ref.fkTable)),
      array: ref.kind !== "one-to-one",
      // The back side of a one-to-one is always optional: nothing forces the other row to exist.
      optional: ref.kind === "one-to-one",
      relationName,
    });
  }

  const out: string[] = [
    banner("Prisma schema"),
    "",
    ...findingLines(schema),
    "generator client {",
    '  provider = "prisma-client-js"',
    "}",
    "",
    "datasource db {",
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    "}",
    "",
  ];

  for (const entry of schema.enums) {
    out.push(`enum ${pascal(entry.name)} {`);
    for (const value of entry.values) out.push(`  ${value.name}`);
    out.push("}", "");
  }

  for (const table of schema.tables) {
    out.push(`model ${pascal(codeName(table))} {`);
    const used = new Set(table.fields.map((field) => field.name));
    // A key over several columns is `@@id([…])` on the model; `@id` on each is a schema error.
    const composite = compositeKey(table);

    for (const field of table.fields) {
      const base = baseType(field.type);
      const asEnum = schema.enums.find((entry) => entry.name.toLowerCase() === base);
      const type = asEnum ? pascal(asEnum.name) : (PRISMA_TYPE[base] ?? "String");

      const attributes: string[] = [];
      if (field.pk && !composite) attributes.push("@id");
      if (field.increment || base === "serial" || base === "bigserial") {
        attributes.push("@default(autoincrement())");
      } else if (base === "uuid" && field.pk) {
        attributes.push("@default(uuid())");
      } else {
        const value = defaultOf(field);
        if (value?.kind === "expression") {
          attributes.push(
            isNowExpression(value.sql)
              ? "@default(now())"
              : `@default(dbgenerated(${JSON.stringify(value.sql)}))`,
          );
        } else if (value?.kind === "string") {
          // An enum's default is one of its members, written bare; any other string is a Prisma
          // string literal, which takes double quotes — `@default('user')` does not parse.
          attributes.push(asEnum ? `@default(${value.value})` : `@default(${JSON.stringify(value.value)})`);
        } else if (value?.kind === "number") {
          attributes.push(`@default(${value.text})`);
        } else if (value?.kind === "boolean") {
          attributes.push(`@default(${value.value})`);
        }
        // `null` needs no attribute: an optional field already defaults to it, and Prisma has no
        // `@default(null)`.
      }
      if (field.unique && !field.pk) attributes.push("@unique");

      const length = field.type.match(/(?:n?varchar|char)\((\d+)\)/i);
      if (length) attributes.push(`@db.VarChar(${length[1]})`);
      else if (base === "text") attributes.push("@db.Text");
      const decimal = field.type.match(/(?:decimal|numeric)\((\d+)\s*,\s*(\d+)\)/i);
      if (decimal) attributes.push(`@db.Decimal(${decimal[1]}, ${decimal[2]})`);
      if (base === "timestamptz") attributes.push("@db.Timestamptz(6)");

      const suffix = attributes.length > 0 ? `  ${attributes.join(" ")}` : "";
      out.push(`  ${field.name.padEnd(22)} ${type}${isOptional(field, table) ? "?" : ""}${suffix}`);
    }

    const related = relations.get(table.id) ?? [];
    if (related.length > 0) out.push("");
    for (const relation of related) {
      // A relation property can collide with a scalar of the same name — `author_id` next to a
      // column literally called `author`. Prisma refuses the model outright, so the collision is
      // resolved here rather than left to the user to find in a migration.
      let name = relation.name;
      while (used.has(name)) name = `${name}Rel`;
      used.add(name);

      const type = relation.array
        ? `${relation.type}[]`
        : `${relation.type}${relation.optional ? "?" : ""}`;
      let attribute = "";
      if (relation.fkFields && relation.refFields) {
        const named = relation.relationName ? `"${relation.relationName}", ` : "";
        attribute = `  @relation(${named}fields: [${relation.fkFields.join(", ")}], references: [${relation.refFields.join(", ")}])`;
      } else if (relation.relationName) {
        attribute = `  @relation("${relation.relationName}")`;
      }
      out.push(`  ${name.padEnd(22)} ${type}${attribute}`);
    }

    out.push("");
    if (composite) out.push(`  @@id([${composite.join(", ")}])`);
    out.push(`  @@map("${table.name}")`, "}", "");
  }

  return out.join("\n").trimEnd() + "\n";
}
