import type { DbmlField, DbmlSchema } from "../types";
import {
  banner,
  baseType,
  codegenRefs,
  lengthOf,
  NOTHING_TO_CONVERT,
  pascal,
  precisionOf,
} from "./shared";

/** The `$table->…` call one column becomes. */
function column(field: DbmlField): string {
  const base = baseType(field.type);
  const length = lengthOf(field.type);
  const precision = precisionOf(field.type);

  if ((field.pk && field.increment) || base === "serial" || base === "bigserial") {
    return "$table->id()";
  }
  if (field.pk && base === "uuid") return `$table->uuid('${field.name}')->primary()`;
  if (field.pk && (base === "int" || base === "integer")) {
    return `$table->integer('${field.name}')->primary()`;
  }
  if (field.pk) return `$table->string('${field.name}')->primary()`;

  switch (base) {
    case "int": case "integer": return `$table->integer('${field.name}')`;
    case "bigint": return `$table->bigInteger('${field.name}')`;
    case "smallint": return `$table->smallInteger('${field.name}')`;
    case "varchar":
      return length ? `$table->string('${field.name}', ${length})` : `$table->string('${field.name}')`;
    case "char":
      return length ? `$table->char('${field.name}', ${length})` : `$table->char('${field.name}')`;
    case "text": return `$table->text('${field.name}')`;
    case "boolean": case "bool": return `$table->boolean('${field.name}')`;
    case "float": case "real": return `$table->float('${field.name}')`;
    case "double": return `$table->double('${field.name}')`;
    case "decimal": case "numeric":
      return precision
        ? `$table->decimal('${field.name}', ${precision[0]}, ${precision[1]})`
        : `$table->decimal('${field.name}')`;
    case "date": return `$table->date('${field.name}')`;
    case "datetime": return `$table->dateTime('${field.name}')`;
    case "timestamp": return `$table->timestamp('${field.name}')`;
    case "time": return `$table->time('${field.name}')`;
    case "json": case "jsonb": return `$table->json('${field.name}')`;
    case "uuid": return `$table->uuid('${field.name}')`;
    default: return `$table->string('${field.name}')`;
  }
}

/**
 * Laravel migrations, one anonymous class per table.
 *
 * The foreign keys go in each table's own `up()`, which is what `php artisan` generates too — and
 * the reason the files must be run in dependency order. Said in a comment rather than solved,
 * because the alternative is emitting a second migration per constraint and this is generated code
 * somebody is going to read.
 */
export function toLaravel(schema: DbmlSchema): string {
  if (schema.tables.length === 0) return NOTHING_TO_CONVERT;
  const refs = codegenRefs(schema);

  const out: string[] = [
    "<?php",
    "",
    banner("Laravel migrations"),
    "// One migration per table — split these into database/migrations/ in dependency order.",
    "",
    "use Illuminate\\Database\\Migrations\\Migration;",
    "use Illuminate\\Database\\Schema\\Blueprint;",
    "use Illuminate\\Support\\Facades\\Schema;",
    "",
  ];

  for (const table of schema.tables) {
    out.push(`// ${pascal(table.name)}: create_${table.name}_table`);
    out.push("return new class extends Migration");
    out.push("{");
    out.push("    public function up(): void");
    out.push("    {");
    out.push(`        Schema::create('${table.name}', function (Blueprint $table) {`);

    for (const field of table.fields) {
      const base = baseType(field.type);
      const auto = (field.pk && field.increment) || base === "serial" || base === "bigserial";
      let line = `            ${column(field)}`;
      if (!auto) {
        if (field.unique && !field.pk) line += "->unique()";
        if (!field.notNull && !field.pk) line += "->nullable()";
        if (field.default !== null && !field.increment) {
          const value = field.default;
          line += /^`?(now\(\)|current_timestamp)`?$/i.test(value)
            ? "->useCurrent()"
            : `->default(${value.replace(/^`|`$/g, "'")})`;
        }
        if (field.note) line += `->comment(${JSON.stringify(field.note)})`;
      }
      out.push(`${line};`);
    }

    for (const index of table.indexes) {
      if (index.pk || index.columns.length === 0) continue;
      const columns = index.columns.map((name) => `'${name}'`).join(", ");
      const call = index.unique ? "unique" : "index";
      out.push(`            $table->${call}([${columns}]);`);
    }

    for (const ref of refs) {
      if (ref.fkTable.id !== table.id || ref.kind === "many-to-many") continue;
      out.push(
        `            $table->foreign('${ref.fkField}')->references('${ref.pkField}')->on('${ref.pkTable.name}')->cascadeOnDelete();`,
      );
    }

    out.push("        });");
    out.push("    }");
    out.push("");
    out.push("    public function down(): void");
    out.push("    {");
    out.push(`        Schema::dropIfExists('${table.name}');`);
    out.push("    }");
    out.push("};");
    out.push("");
  }

  return out.join("\n").trimEnd() + "\n";
}
