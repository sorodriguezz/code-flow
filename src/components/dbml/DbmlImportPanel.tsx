import { useState } from "react";
import { FileUp, Wand2 } from "lucide-react";
import { Select } from "../common/Select";
import type { SqlImportDialect } from "../../lib/dbml/parse";
import { apiReadTextFile } from "../../lib/tauri/apiCommands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { TOOL_AREA, TOOL_BAR, TOOL_BTN, TOOL_BTN_PRIMARY, ToolClose } from "./toolChrome";
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
  onClose,
}: {
  /** `sqlToDbmlWithCore`, handed down so the 15 MB parser stays owned by one component. */
  convert: (sql: string, dialect: SqlImportDialect) => string;
  onReplace: (dbml: string) => void;
  onAppend: (dbml: string) => void;
  /** Closes the tool. Last in the bar's cluster — see `ToolClose`. */
  onClose: () => void;
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
    <div className="flex h-full min-h-0 flex-col">
      <div className={TOOL_BAR}>
        <span className="text-[13px] font-medium text-[var(--cf-text)]">
          {t("dbml.import.paste")}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Boxed at a fixed width: the trigger is `w-full`, so in a flex row it grew to whatever
              was left over — half the bar on a wide drawer — and pushed the two buttons beside it
              into wrapping, which is what made them read as leftovers. 28px tall, the height of
              every other control on this bar. */}
          <div className="w-[140px] shrink-0">
            <Select
              value={dialect}
              onChange={(value) => setDialect(value as SqlImportDialect)}
              options={DIALECTS.map((entry) => ({ value: entry.id, label: entry.label }))}
              ariaLabel={t("dbml.import.dialect")}
              size="field"
              className="h-7"
            />
          </div>
          <button
            type="button"
            onClick={() => void openFile()}
            title={t("dbml.import.openFileHint")}
            className={TOOL_BTN}
          >
            <FileUp size={14} />
            {t("dbml.import.openFile")}
          </button>
          <button type="button" onClick={run} disabled={!sql.trim()} className={TOOL_BTN_PRIMARY}>
            <Wand2 size={14} />
            {t("dbml.import.convert")}
          </button>
          <ToolClose onClose={onClose} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <textarea
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          spellCheck={false}
          placeholder={t("dbml.import.placeholder")}
          className={`${TOOL_AREA} min-h-0 flex-1 resize-none font-mono leading-relaxed`}
        />

        {result !== null && (
          <div className="flex min-h-0 flex-[1.2] flex-col gap-2">
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-[var(--cf-text-muted)]">
                {t("dbml.import.result", { count: String(tables) })}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <button type="button" onClick={() => onAppend(result)} className={TOOL_BTN}>
                  {t("dbml.import.append")}
                </button>
                <button type="button" onClick={() => onReplace(result)} className={TOOL_BTN_PRIMARY}>
                  {t("dbml.import.replace")}
                </button>
              </div>
            </div>
            {/* A code well — the sunken tone every read-only block of code in a sheet wears. */}
            <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] p-2.5 font-mono text-[12px] leading-relaxed">
              {result}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
