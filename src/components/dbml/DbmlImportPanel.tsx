import { useState } from "react";
import { FileUp, Wand2 } from "lucide-react";
import { Select } from "../common/Select";
import { INPUT } from "../db/dbChrome";
import type { SqlImportDialect } from "../../lib/dbml/parse";
import { apiReadTextFile } from "../../lib/tauri/apiCommands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/** The dialects the importer knows, in the order a paste is most likely to be one of them. */
const DIALECTS: { id: SqlImportDialect; label: string }[] = [
  { id: "postgres", label: "PostgreSQL" },
  { id: "mysql", label: "MySQL" },
  { id: "mssql", label: "SQL Server" },
  { id: "oracle", label: "Oracle" },
  { id: "snowflake", label: "Snowflake" },
];

/**
 * SQL DDL in, DBML out.
 *
 * The way an existing database gets into this workspace when you cannot connect to it — a schema
 * dump in a ticket, a migration file, the output of `pg_dump -s`.
 *
 * **The result is shown before it is applied, and applying it is two different verbs.** "Replace"
 * is what you want the first time; "add" is what you want when you are importing one more table
 * into a schema you have been writing. A single Import button would have to guess, and guessing
 * wrong overwrites work.
 */
export function DbmlImportPanel({
  convert,
  onReplace,
  onAppend,
}: {
  /** `sqlToDbmlWithCore`, handed down so the 15 MB parser stays owned by one component. */
  convert: (sql: string, dialect: SqlImportDialect) => string;
  onReplace: (dbml: string) => void;
  onAppend: (dbml: string) => void;
}) {
  const t = useT();
  const [sql, setSql] = useState("");
  const [dialect, setDialect] = useState<SqlImportDialect>("postgres");
  const [result, setResult] = useState<string | null>(null);

  const run = () => {
    const dbml = convert(sql, dialect);
    if (!dbml.trim()) {
      setResult(null);
      useToastStore.getState().pushToast(t("dbml.import.nothing"), "error");
      return;
    }
    setResult(dbml);
  };

  const openFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "SQL", extensions: ["sql", "ddl", "txt"] }],
      });
      if (typeof picked !== "string") return;
      setSql(await apiReadTextFile(picked));
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const tables = result ? (result.match(/^\s*table\s/gim) ?? []).length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-[11px] font-medium">{t("dbml.import.paste")}</span>
        <span className="flex-1" />
        <Select
          value={dialect}
          onChange={(value) => setDialect(value as SqlImportDialect)}
          options={DIALECTS.map((entry) => ({ value: entry.id, label: entry.label }))}
          ariaLabel={t("dbml.import.dialect")}
        />
        <button
          type="button"
          onClick={() => void openFile()}
          className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-[3px] text-[10.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
        >
          <FileUp size={11} />
          {t("dbml.import.openFile")}
        </button>
        <button
          type="button"
          onClick={run}
          disabled={!sql.trim()}
          className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-[3px] text-[10.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Wand2 size={11} />
          {t("dbml.import.convert")}
        </button>
      </div>

      <textarea
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        spellCheck={false}
        placeholder={t("dbml.import.placeholder")}
        className={`${INPUT} min-h-0 flex-1 resize-none font-mono text-[11.5px] leading-relaxed`}
      />

      {result !== null && (
        <div className="flex min-h-0 flex-[1.2] flex-col gap-1.5">
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10.5px] text-[var(--cf-text-muted)]">
              {t("dbml.import.result", { count: String(tables) })}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => onAppend(result)}
              className="rounded-md border border-[var(--cf-border)] px-2 py-[3px] text-[10.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
            >
              {t("dbml.import.append")}
            </button>
            <button
              type="button"
              onClick={() => onReplace(result)}
              className="rounded-md bg-[var(--cf-accent)] px-2 py-[3px] text-[10.5px] font-medium text-white transition-opacity hover:opacity-90"
            >
              {t("dbml.import.replace")}
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] p-2 font-mono text-[11px] leading-relaxed">
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}
