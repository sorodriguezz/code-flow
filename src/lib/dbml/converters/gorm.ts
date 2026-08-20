import type { DbmlSchema } from "../types";
import {
  banner,
  baseType,
  codeName,
  codegenRefs,
  incoming,
  lengthOf,
  NOTHING_TO_CONVERT,
  outgoing,
  pascal,
  precisionOf,
} from "./shared";

function goType(type: string, nullable: boolean): string {
  const base = baseType(type);
  let go: string;
  switch (base) {
    case "int": case "integer": case "smallint": go = "int"; break;
    case "bigint": case "serial": case "bigserial": go = "int64"; break;
    case "float": case "real": go = "float32"; break;
    case "double": case "decimal": case "numeric": go = "float64"; break;
    case "boolean": case "bool": go = "bool"; break;
    case "date": case "datetime": case "timestamp": go = "time.Time"; break;
    case "json": case "jsonb": go = "datatypes.JSON"; break;
    default: go = "string"; break;
  }
  // `datatypes.JSON` is already a nullable slice type; a pointer to one is a Go idiom nobody wants.
  return nullable && go !== "datatypes.JSON" ? `*${go}` : go;
}

/** Pads a struct field name out to a common column, which is what `gofmt` would do anyway. */
function pad(name: string, width = 20): string {
  return name + " ".repeat(Math.max(1, width - name.length));
}

/** GORM models. */
export function toGorm(schema: DbmlSchema): string {
  if (schema.tables.length === 0) return NOTHING_TO_CONVERT;
  const refs = codegenRefs(schema);

  const usesTime = schema.tables.some((table) =>
    table.fields.some((field) => ["date", "datetime", "timestamp"].includes(baseType(field.type))),
  );
  const usesJson = schema.tables.some((table) =>
    table.fields.some((field) => ["json", "jsonb"].includes(baseType(field.type))),
  );

  const lines: string[] = [banner("GORM models"), "package models", "", "import ("];
  if (usesTime) lines.push('\t"time"');
  if (usesTime && usesJson) lines.push("");
  if (usesJson) lines.push('\t"gorm.io/datatypes"');
  // An import block with nothing in it does not compile, and neither does one importing `gorm`
  // without using it — which a schema of plain columns does not.
  if (!usesTime && !usesJson) lines.pop();
  else lines.push(")");
  lines.push("");

  for (const table of schema.tables) {
    const struct = pascal(codeName(table));
    lines.push(`type ${struct} struct {`);

    for (const field of table.fields) {
      const nullable = !field.notNull && !field.pk;
      const tags = [`column:${field.name}`];
      if (field.pk) tags.push("primaryKey");
      if (field.increment) tags.push("autoIncrement");
      const base = baseType(field.type);
      const length = lengthOf(field.type);
      const precision = precisionOf(field.type);
      if (length && (base === "varchar" || base === "char")) tags.push(`size:${length}`);
      if (precision && (base === "decimal" || base === "numeric")) {
        tags.push(`precision:${precision[0]};scale:${precision[1]}`);
      }
      if (field.notNull && !field.pk) tags.push("not null");
      if (field.unique && !field.pk) tags.push("uniqueIndex");
      if (field.default !== null && !field.increment) {
        tags.push(`default:${field.default.replace(/^'|'$/g, "").replace(/^`|`$/g, "")}`);
      }
      lines.push(
        `\t${pad(pascal(field.name))}${goType(field.type, nullable)}\t\`gorm:"${tags.join(";")}"\``,
      );
    }

    const out = outgoing(refs, table).filter((ref) => ref.kind !== "many-to-many");
    const back = incoming(refs, table).filter((ref) => ref.kind !== "many-to-many");
    const many = refs.filter(
      (ref) => ref.kind === "many-to-many" && (ref.fkTable.id === table.id || ref.pkTable.id === table.id),
    );
    if (out.length > 0 || back.length > 0 || many.length > 0) lines.push("");
    for (const ref of out) {
      const target = pascal(codeName(ref.pkTable));
      lines.push(
        `\t${pad(target)}${target}\t\`gorm:"foreignKey:${pascal(ref.fkField)};references:${pascal(ref.pkField)}"\``,
      );
    }
    for (const ref of back) {
      const source = pascal(codeName(ref.fkTable));
      const name = ref.kind === "one-to-one" ? source : `${source}s`;
      const type = ref.kind === "one-to-one" ? source : `[]${source}`;
      lines.push(`\t${pad(name)}${type}\t\`gorm:"foreignKey:${pascal(ref.fkField)}"\``);
    }
    for (const ref of many) {
      const other = pascal(codeName(ref.fkTable.id === table.id ? ref.pkTable : ref.fkTable));
      lines.push(`\t${pad(`${other}s`)}[]${other}\t\`gorm:"many2many:${table.name}_${other.toLowerCase()}"\``);
    }

    lines.push("}", "");
    lines.push(`func (${struct}) TableName() string { return "${table.name}" }`, "");
  }

  return lines.join("\n").trimEnd() + "\n";
}
