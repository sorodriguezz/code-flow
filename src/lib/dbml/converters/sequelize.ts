import type { DbmlSchema } from "../types";
import {
  banner,
  baseType,
  codeName,
  codegenRefs,
  defaultOf,
  findingLines,
  incoming,
  isComposite,
  isKeyColumn,
  isNowExpression,
  isUuidExpression,
  jsLiteral,
  lengthOf,
  NOTHING_TO_CONVERT,
  outgoing,
  pascal,
  precisionOf,
  quotedLiteral,
  type DefaultValue,
} from "./shared";

const TS_TYPE: Record<string, string> = {
  int: "number", integer: "number", bigint: "number", smallint: "number",
  serial: "number", bigserial: "number",
  varchar: "string", text: "string", char: "string",
  boolean: "boolean", bool: "boolean",
  float: "number", double: "number", real: "number", decimal: "number", numeric: "number",
  date: "Date", datetime: "Date", timestamp: "Date", time: "string",
  json: "Record<string, unknown>", jsonb: "Record<string, unknown>",
  uuid: "string",
};

function dataType(type: string): string {
  const base = baseType(type);
  const length = lengthOf(type);
  const precision = precisionOf(type);
  switch (base) {
    case "int": case "integer": case "serial": return "DataTypes.INTEGER";
    case "bigint": case "bigserial": return "DataTypes.BIGINT";
    case "smallint": return "DataTypes.SMALLINT";
    case "varchar": return length ? `DataTypes.STRING(${length})` : "DataTypes.STRING";
    case "char": return length ? `DataTypes.CHAR(${length})` : "DataTypes.CHAR";
    case "text": return "DataTypes.TEXT";
    case "boolean": case "bool": return "DataTypes.BOOLEAN";
    case "float": case "real": return "DataTypes.FLOAT";
    case "double": return "DataTypes.DOUBLE";
    case "decimal": case "numeric":
      return precision ? `DataTypes.DECIMAL(${precision[0]}, ${precision[1]})` : "DataTypes.DECIMAL";
    case "date": return "DataTypes.DATEONLY";
    case "datetime": case "timestamp": return "DataTypes.DATE";
    case "json": case "jsonb": return "DataTypes.JSON";
    case "uuid": return "DataTypes.UUID";
    default: return "DataTypes.STRING";
  }
}

/**
 * A default as Sequelize takes it. An expression is `Sequelize.literal(…)` — as a bare string it
 * would be inserted as the text "now()" — except the two Sequelize has its own words for.
 */
function defaultValue(value: DefaultValue): string {
  if (value.kind !== "expression") return jsLiteral(value);
  if (isNowExpression(value.sql)) return "DataTypes.NOW";
  if (isUuidExpression(value.sql)) return "DataTypes.UUIDV4";
  return `Sequelize.literal(${quotedLiteral(value.sql)})`;
}

/** Sequelize models, typed with `InferAttributes` so the class is usable rather than just present. */
export function toSequelize(schema: DbmlSchema): string {
  if (schema.tables.length === 0) return NOTHING_TO_CONVERT;
  const refs = codegenRefs(schema);

  const lines: string[] = [
    banner("Sequelize models"),
    "",
    ...findingLines(schema),
    "import {",
    "  CreationOptional,",
    "  DataTypes,",
    "  InferAttributes,",
    "  InferCreationAttributes,",
    "  Model,",
    "  Sequelize,",
    "} from 'sequelize';",
    "",
  ];

  for (const table of schema.tables) {
    const cls = pascal(codeName(table));
    lines.push(`export class ${cls} extends Model<`);
    lines.push(`  InferAttributes<${cls}>,`);
    lines.push(`  InferCreationAttributes<${cls}>`);
    lines.push("> {");

    for (const field of table.fields) {
      const ts = TS_TYPE[baseType(field.type)] ?? "string";
      const declared = field.pk || field.increment || field.default !== null
        ? `CreationOptional<${ts}>`
        : field.notNull
          ? ts
          : `${ts} | null`;
      lines.push(`  declare ${field.name}: ${declared};`);
    }

    lines.push("");
    lines.push(`  static initModel(sequelize: Sequelize): typeof ${cls} {`);
    lines.push(`    return ${cls}.init(`);
    lines.push("      {");
    for (const field of table.fields) {
      const props = [`type: ${dataType(field.type)}`];
      // Marked on every column of a composite key, which is how Sequelize declares one — and without
      // any it adds an `id` column of its own.
      if (isKeyColumn(table, field)) props.push("primaryKey: true");
      if (field.increment) props.push("autoIncrement: true");
      if (!field.notNull && !field.pk) props.push("allowNull: true");
      if (field.unique && !field.pk) props.push("unique: true");
      const value = field.increment ? null : defaultOf(field);
      if (value) props.push(`defaultValue: ${defaultValue(value)}`);
      lines.push(`        ${field.name}: { ${props.join(", ")} },`);
    }
    lines.push("      },");
    lines.push("      {");
    lines.push("        sequelize,");
    lines.push(`        tableName: '${table.name}',`);
    lines.push("        timestamps: false,");
    lines.push("      },");
    lines.push("    );");
    lines.push("  }");

    // Sequelize's associations take one `foreignKey`; a composite reference has no spelling there,
    // so it is named in a comment instead of being emitted over its first column.
    const composite = [...outgoing(refs, table), ...incoming(refs, table)].filter(
      (ref) => ref.kind !== "many-to-many" && isComposite(ref),
    );
    const out = outgoing(refs, table).filter((ref) => ref.kind !== "many-to-many" && !isComposite(ref));
    const back = incoming(refs, table).filter((ref) => ref.kind !== "many-to-many" && !isComposite(ref));
    const many = refs.filter(
      (ref) => ref.kind === "many-to-many" && (ref.fkTable.id === table.id || ref.pkTable.id === table.id),
    );
    if (out.length > 0 || back.length > 0 || many.length > 0 || composite.length > 0) {
      lines.push("");
      lines.push("  static associate(models: Record<string, typeof Model>): void {");
      for (const ref of composite) {
        lines.push(
          `    // ${ref.fkTable.name}.(${ref.fkFields.join(", ")}) -> ${ref.pkTable.name}.(${ref.pkFields.join(", ")}): Sequelize cannot associate on a composite key.`,
        );
      }
      for (const ref of out) {
        lines.push(
          `    ${cls}.belongsTo(models.${pascal(codeName(ref.pkTable))}, { foreignKey: '${ref.fkFields[0]}', as: '${ref.pkTable.name}' });`,
        );
      }
      for (const ref of back) {
        const relation = ref.kind === "one-to-one" ? "hasOne" : "hasMany";
        const alias = ref.kind === "one-to-one" ? ref.fkTable.name : `${ref.fkTable.name}s`;
        lines.push(
          `    ${cls}.${relation}(models.${pascal(codeName(ref.fkTable))}, { foreignKey: '${ref.fkFields[0]}', as: '${alias}' });`,
        );
      }
      for (const ref of many) {
        const other = ref.fkTable.id === table.id ? ref.pkTable : ref.fkTable;
        lines.push(
          `    ${cls}.belongsToMany(models.${pascal(codeName(other))}, { through: '${[table.name, other.name].sort().join("_")}' });`,
        );
      }
      lines.push("  }");
    }
    lines.push("}", "");
  }

  return lines.join("\n").trimEnd() + "\n";
}
