import type { DbColumn, DbStatementResult } from "../../types/database";

/**
 * Turning a result set into something you can paste elsewhere.
 *
 * The one rule that shapes all of it: **NULL and the empty string must not collapse.** They are
 * different values in every engine here, and an export that writes both as `` is an export that
 * silently corrupts the data on the way back in. So CSV writes NULL as an unquoted empty field and
 * `""` as a quoted one; JSON writes `null` and `""`; SQL writes `NULL` and `''`.
 */

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown";

/** RFC 4180: quote when the value holds a delimiter, a quote or a newline; double the quotes. */
function csvField(value: string | null, delimiter: string): string {
  // Unquoted empty is NULL; `""` is an empty string. That is the only way CSV can carry both.
  if (value === null) return "";
  if (value === "") return '""';
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toDelimited(
  columns: DbColumn[],
  rows: (string | null)[][],
  delimiter: string,
): string {
  const header = columns.map((column) => csvField(column.name, delimiter)).join(delimiter);
  const body = rows.map((row) => row.map((cell) => csvField(cell, delimiter)).join(delimiter));
  return [header, ...body].join("\n");
}

export function toJson(columns: DbColumn[], rows: (string | null)[][]): string {
  const objects = rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column.name, row[index] ?? null])),
  );
  return JSON.stringify(objects, null, 2);
}

/**
 * `INSERT` statements for the rows shown.
 *
 * Values are emitted as quoted literals with the quotes doubled — the same rule the backend's
 * `sqlgen::quote_literal` follows, and for the same reason: this text is going to be pasted into a
 * console, and a value containing `'` must not be able to end the literal it sits in.
 */
export function toInsertStatements(
  table: string,
  columns: DbColumn[],
  rows: (string | null)[][],
): string {
  const names = columns.map((column) => `"${column.name.replace(/"/g, '""')}"`).join(", ");
  return rows
    .map((row) => {
      const values = row
        .map((cell) => (cell === null ? "NULL" : `'${cell.replace(/'/g, "''")}'`))
        .join(", ");
      return `INSERT INTO ${table} (${names}) VALUES (${values});`;
    })
    .join("\n");
}

/** A GitHub-flavoured table — for pasting a result into a pull request or an issue. */
export function toMarkdown(columns: DbColumn[], rows: (string | null)[][]): string {
  const escape = (value: string | null) =>
    value === null ? "_NULL_" : value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const header = `| ${columns.map((column) => escape(column.name)).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(escape).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

export function formatResult(
  result: DbStatementResult,
  format: ExportFormat,
  table = "table",
): string {
  switch (format) {
    case "csv":
      return toDelimited(result.columns, result.rows, ",");
    case "tsv":
      return toDelimited(result.columns, result.rows, "\t");
    case "json":
      // Mongo results already carry the real documents; flattening them into column/value pairs
      // would throw away the nesting that is the whole point of the engine.
      if (result.documents.length > 0) return `[\n${result.documents.join(",\n")}\n]`;
      return toJson(result.columns, result.rows);
    case "sql":
      return toInsertStatements(table, result.columns, result.rows);
    case "markdown":
      return toMarkdown(result.columns, result.rows);
  }
}

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  sql: "sql",
  markdown: "md",
};
