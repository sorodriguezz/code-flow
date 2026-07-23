import { Parser } from "@dbml/core";

export interface DbmlColumn {
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
  unique: boolean;
}

export interface DbmlTable {
  name: string;
  note: string;
  columns: DbmlColumn[];
}

export interface DbmlRef {
  fromTable: string;
  fromField: string;
  fromRelation: string;
  toTable: string;
  toField: string;
  toRelation: string;
}

export interface DbmlSchema {
  tables: DbmlTable[];
  refs: DbmlRef[];
  error: string | null;
}

function typeName(type: unknown): string {
  if (typeof type === "string") return type;
  if (type && typeof type === "object" && "type_name" in type) {
    return String((type as { type_name: unknown }).type_name);
  }
  return "?";
}

interface DbmlDiagnostic {
  message?: string;
  location?: { start?: { line: number; column: number } };
}

/** @dbml/core doesn't throw plain `Error`s on invalid DBML — it throws a `CompilerError`
 * shaped as `{ diags: DbmlDiagnostic[] }`, so `String(e)`/`e.message` both fall through to
 * `[object Object]` unless that shape is unpacked explicitly. */
function formatParseError(e: unknown): string {
  if (e && typeof e === "object" && "diags" in e && Array.isArray((e as { diags: unknown }).diags)) {
    const diags = (e as { diags: DbmlDiagnostic[] }).diags;
    return diags
      .map((d) => {
        const loc = d.location?.start ? ` (${d.location.start.line}:${d.location.start.column})` : "";
        return `${d.message ?? "Parse error"}${loc}`;
      })
      .join("\n");
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function parseDbml(source: string): DbmlSchema {
  if (!source.trim()) return { tables: [], refs: [], error: null };
  try {
    const database = Parser.parse(source, "dbml");
    const tables: DbmlTable[] = [];
    const refs: DbmlRef[] = [];
    for (const schema of database.schemas) {
      for (const table of schema.tables) {
        tables.push({
          name: table.name,
          note: table.note ?? "",
          columns: table.fields.map((f) => ({
            name: f.name,
            type: typeName(f.type),
            pk: !!f.pk,
            notNull: !!f.not_null,
            unique: !!f.unique,
          })),
        });
      }
      for (const ref of schema.refs) {
        const [from, to] = ref.endpoints;
        if (!from || !to) continue;
        refs.push({
          fromTable: from.tableName,
          fromField: from.fieldNames?.[0] ?? "",
          fromRelation: from.relation === "1" ? "1" : "N",
          toTable: to.tableName,
          toField: to.fieldNames?.[0] ?? "",
          toRelation: to.relation === "1" ? "1" : "N",
        });
      }
    }
    return { tables, refs, error: null };
  } catch (e) {
    return { tables: [], refs: [], error: formatParseError(e) };
  }
}
