import type { DbmlSchema } from "../types";
import {
  banner,
  baseType,
  camel,
  codeName,
  codegenRefs,
  incoming,
  isOptional,
  lengthOf,
  NOTHING_TO_CONVERT,
  outgoing,
  pascal,
} from "./shared";

/** DBML type → the string TypeORM's `@Column` takes. */
const COLUMN_TYPE: Record<string, string> = {
  int: "int", integer: "int", bigint: "bigint", smallint: "smallint", serial: "int",
  varchar: "varchar", text: "text", char: "char", nvarchar: "varchar",
  boolean: "boolean", bool: "boolean",
  float: "float", double: "double", real: "float", decimal: "decimal", numeric: "decimal",
  date: "date", datetime: "datetime", timestamp: "timestamp", time: "time",
  json: "json", jsonb: "jsonb", uuid: "uuid",
};

/** DBML type → the TypeScript type of the property. */
const TS_TYPE: Record<string, string> = {
  int: "number", integer: "number", bigint: "bigint", smallint: "number", serial: "number",
  varchar: "string", text: "string", char: "string", nvarchar: "string",
  boolean: "boolean", bool: "boolean",
  float: "number", double: "number", real: "number", decimal: "number", numeric: "number",
  date: "Date", datetime: "Date", timestamp: "Date", time: "string",
  json: "Record<string, unknown>", jsonb: "Record<string, unknown>", uuid: "string",
};

/**
 * TypeORM entities.
 *
 * One class per table, with `@ManyToOne`/`@JoinColumn` on the side that holds the key and
 * `@OneToMany` on the side that is pointed at — which is why this reads `codegenRefs` rather than
 * the raw references: the orientation is decided once, there.
 */
export function toTypeOrm(schema: DbmlSchema): string {
  if (schema.tables.length === 0) return NOTHING_TO_CONVERT;
  const refs = codegenRefs(schema);

  const blocks = schema.tables.map((table) => {
    const cls = pascal(codeName(table));
    const lines: string[] = [`@Entity({ name: '${table.name}' })`, `export class ${cls} {`];

    for (const field of table.fields) {
      const base = baseType(field.type);
      const column = COLUMN_TYPE[base] ?? "varchar";
      const ts = TS_TYPE[base] ?? "string";

      const options: string[] = [];
      if (field.unique && !field.pk) options.push("unique: true");
      if (isOptional(field)) options.push("nullable: true");
      if (field.default !== null) options.push(`default: ${field.default}`);
      const length = lengthOf(field.type);
      if (length) options.push(`length: ${length}`);
      if (field.note) options.push(`comment: ${JSON.stringify(field.note)}`);
      const suffix = options.length > 0 ? `, { ${options.join(", ")} }` : "";

      if (field.pk && field.increment) lines.push("  @PrimaryGeneratedColumn()");
      else if (field.pk && base === "uuid") lines.push("  @PrimaryGeneratedColumn('uuid')");
      else if (field.pk) lines.push("  @PrimaryColumn()");
      else lines.push(`  @Column('${column}'${suffix})`);

      lines.push(`  ${field.name}!: ${ts}${isOptional(field) ? " | null" : ""};`, "");
    }

    for (const ref of outgoing(refs, table)) {
      if (ref.kind === "many-to-many") continue;
      const target = pascal(codeName(ref.pkTable));
      const property = camel(ref.fkField.replace(/_(id|fk|key)$/i, "")) || camel(ref.pkTable.name);
      const decorator = ref.kind === "one-to-one" ? "OneToOne" : "ManyToOne";
      lines.push(`  @${decorator}(() => ${target}, { nullable: true })`);
      lines.push(`  @JoinColumn({ name: '${ref.fkField}' })`);
      lines.push(`  ${property}!: ${target};`, "");
    }
    for (const ref of incoming(refs, table)) {
      if (ref.kind === "many-to-many") continue;
      const source = pascal(codeName(ref.fkTable));
      const back = camel(ref.fkField.replace(/_(id|fk|key)$/i, "")) || camel(table.name);
      if (ref.kind === "one-to-one") {
        lines.push(`  @OneToOne(() => ${source}, (row) => row.${back})`);
        lines.push(`  ${camel(ref.fkTable.name)}!: ${source};`, "");
      } else {
        lines.push(`  @OneToMany(() => ${source}, (row) => row.${back})`);
        lines.push(`  ${camel(ref.fkTable.name)}s!: ${source}[];`, "");
      }
    }

    while (lines[lines.length - 1] === "") lines.pop();
    lines.push("}");
    return lines.join("\n");
  });

  return [
    banner("TypeORM entities"),
    "",
    "import {",
    "  Column,",
    "  Entity,",
    "  JoinColumn,",
    "  ManyToOne,",
    "  OneToMany,",
    "  OneToOne,",
    "  PrimaryColumn,",
    "  PrimaryGeneratedColumn,",
    "} from 'typeorm';",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ]
    .join("\n")
    .trimEnd() + "\n";
}
