import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FileUp, FolderOpen, Loader2 } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { apiPickFile } from "../../lib/tauri/apiCommands";
import {
  dbCancel,
  dbChildren,
  dbCsvInspect,
  dbImportCsv,
  type DbCsvPreview,
  type DbImportOutcome,
} from "../../lib/tauri/dbCommands";
import { autoMapColumns } from "../../lib/db/csvMapping";
import { useT } from "../../state/languageStore";
import type { DbNode, DbNodeRef } from "../../types/database";

/** The separators the picker offers; `""` is "detect". */
const DELIMITERS = [
  { value: "", label: "auto" },
  { value: ",", label: ", (comma)" },
  { value: ";", label: "; (semicolon)" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "| (pipe)" },
];

/** Rows of the file shown under the mapping — enough to recognise the data, not a spreadsheet. */
const PREVIEW_ROWS = 8;

/**
 * Importing a CSV file into a table.
 *
 * The file never crosses into the webview: the backend reads its start for this preview
 * (`db_csv_inspect`) and the whole of it for the import (`db_import_csv`), which runs in one
 * transaction on a session of its own — so Cancel is a rollback, and a failed row either sinks the
 * import or, with "skip", is left out and named in the report by its line.
 *
 * The separator and the header are guesses shown as controls, and so is the mapping: by name when
 * the file has a header, by position when it doesn't (`autoMapColumns`). Each CSV column can go to
 * one table column or be left out.
 */
export function ImportCsvModal({
  connectionId,
  node,
  columns: known,
  onClose,
  onImported,
}: {
  connectionId: string;
  node: DbNodeRef;
  /** The table's columns as the tab already read them; fetched here when it hadn't. */
  columns: DbNode[];
  onClose: () => void;
  /** Called after an import that kept rows, so the tab can reload. */
  onImported: () => void;
}) {
  const t = useT();
  const [columns, setColumns] = useState<DbNode[]>(known);
  const [path, setPath] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState("");
  const [preview, setPreview] = useState<DbCsvPreview | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [skipErrors, setSkipErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<DbImportOutcome | null>(null);
  const opened = useRef(false);

  const names = useMemo(() => columns.map((column) => column.name), [columns]);

  // The table's columns, when the tab hadn't read them yet.
  useEffect(() => {
    if (known.length > 0) return;
    void dbChildren(connectionId, { ...node, kind: "column_folder" })
      .then(setColumns)
      .catch((e) => setError(String(e)));
  }, [connectionId, node, known.length]);

  const inspect = async (file: string, separator: string) => {
    setError(null);
    try {
      const found = await dbCsvInspect(file, separator || null, names);
      setPreview(found);
      setDelimiter(separator);
      setHasHeader(found.has_header);
      setMapping(autoMapColumns(found.first, found.columns, names, found.has_header));
    } catch (e) {
      setPreview(null);
      setError(String(e));
    }
  };

  const choose = async () => {
    const picked = await apiPickFile(["csv", "tsv", "txt"]).catch(() => null);
    if (!picked) return;
    setPath(picked);
    setOutcome(null);
    await inspect(picked, "");
  };

  // Straight to the file picker: choosing the file is the first thing anyone does here.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void choose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!runId) return;
    const stop = listen<{ run_id: string; rows: number }>("db:import-progress", (event) => {
      if (event.payload.run_id === runId) setProgress(event.payload.rows);
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [runId]);

  const width = preview?.columns ?? 0;
  const headers = Array.from({ length: width }, (_, index) =>
    hasHeader && preview?.first[index] ? (preview.first[index] as string) : t("db.importColumnN", { n: index + 1 }),
  );
  const body = preview ? (hasHeader ? preview.rows : [preview.first, ...preview.rows]) : [];
  const mapped = mapping.filter((target) => target !== null).length;
  const running = runId !== null;

  const run = async () => {
    if (!path || !preview || mapped === 0) return;
    const id = `dbimport-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setRunId(id);
    setProgress(0);
    setError(null);
    try {
      const done = await dbImportCsv(
        connectionId,
        {
          node,
          path,
          delimiter: delimiter || preview.delimiter,
          has_header: hasHeader,
          mapping,
          types: mapping.map((target) => columns.find((column) => column.name === target)?.column?.data_type ?? ""),
          skip_errors: skipErrors,
        },
        id,
      );
      setOutcome(done);
      if (done.committed && done.inserted > 0) onImported();
    } catch (e) {
      // Cancelling closes the import's own session, which the server answers with a rollback.
      setError(String(e) === "Query cancelled" ? t("db.importCancelled") : String(e));
    } finally {
      setRunId(null);
    }
  };

  const targetOptions = [
    { value: "", label: t("db.importSkipColumn") },
    ...names.map((name) => ({ value: name, label: name })),
  ];

  return (
    <ApiModal
      icon={FileUp}
      title={t("db.importTitle", { table: node.name ?? "" })}
      subtitle={path ?? undefined}
      width="max-w-3xl"
      busy={running}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={() => void choose()} disabled={running}>
            <FolderOpen size={12} />
            {t("db.importChooseFile")}
          </GhostButton>
          <span className="flex-1" />
          {running ? (
            <GhostButton onClick={() => runId && void dbCancel(runId)}>{t("db.cancel")}</GhostButton>
          ) : (
            <GhostButton onClick={onClose}>{outcome ? t("db.importClose") : t("common.cancel")}</GhostButton>
          )}
          <button
            onClick={() => void run()}
            disabled={running || !preview || mapped === 0}
            className={buttonClass({ variant: "primary" })}
          >
            {running && <Loader2 size={12} className="animate-spin" />}
            {running ? t("db.importRunning", { rows: progress.toLocaleString() }) : t("db.importRun")}
          </button>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {error && (
          <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--cf-danger)]">{error}</p>
        )}

        {outcome && <ImportReport outcome={outcome} />}

        {preview && !outcome && (
          <>
            <div className="flex flex-wrap items-center gap-4 text-[12px] text-[var(--cf-text)]">
              <span className="flex items-center gap-2">
                <span className="text-[var(--cf-text-muted)]">{t("db.importDelimiter")}</span>
                <div className="w-[140px]">
                  <Select
                    size="sm"
                    value={delimiter}
                    onChange={(value) => path && void inspect(path, value)}
                    options={DELIMITERS.map((option) =>
                      option.value === ""
                        ? { value: "", label: t("db.importDelimiterAuto", { found: preview.delimiter === "\t" ? "Tab" : preview.delimiter }) }
                        : option,
                    )}
                    ariaLabel={t("db.importDelimiter")}
                  />
                </div>
              </span>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={hasHeader}
                  onChange={(checked) => {
                    setHasHeader(checked);
                    setMapping(autoMapColumns(preview.first, width, names, checked));
                  }}
                />
                {t("db.importHeader")}
              </label>
              <label className="flex cursor-pointer items-center gap-2" title={t("db.importSkipErrorsHint")}>
                <Checkbox checked={skipErrors} onChange={setSkipErrors} />
                {t("db.importSkipErrors")}
              </label>
            </div>

            <div className="overflow-x-auto rounded-md border border-[var(--cf-border)]">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--cf-border)] bg-[var(--cf-sunken)]">
                    {headers.map((header, index) => (
                      <th key={index} className="min-w-[140px] px-2 py-1.5 text-left align-top font-medium">
                        <div className="mb-1 truncate text-[var(--cf-text)]" title={header}>
                          {header}
                        </div>
                        <div className="w-[140px]">
                          <Select
                            size="sm"
                            value={mapping[index] ?? ""}
                            onChange={(value) =>
                              setMapping((current) => current.map((target, at) => (at === index ? value || null : target)))
                            }
                            options={targetOptions}
                            ariaLabel={t("db.importTarget", { column: header })}
                          />
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.slice(0, PREVIEW_ROWS).map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-[var(--cf-border)] last:border-b-0">
                      {headers.map((_, index) => {
                        const value = row[index];
                        return (
                          <td
                            key={index}
                            className={`max-w-[200px] truncate px-2 py-1 font-mono text-[11.5px] ${
                              mapping[index] ? "text-[var(--cf-text)]" : "text-[var(--cf-text-faint)]"
                            }`}
                            title={value ?? "NULL"}
                          >
                            {value === null || value === undefined ? <span className="italic opacity-60">NULL</span> : value}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </ApiModal>
  );
}

/** What an import did: how many rows went in, whether they were kept, and which lines failed. */
function ImportReport({ outcome }: { outcome: DbImportOutcome }) {
  const t = useT();
  return (
    <div className="space-y-2">
      <p className={`text-[12.5px] ${outcome.committed ? "text-[var(--cf-text)]" : "text-[var(--cf-danger)]"}`}>
        {outcome.committed
          ? t("db.importDone", { inserted: outcome.inserted.toLocaleString(), read: outcome.read.toLocaleString() })
          : t("db.importRolledBack", { failed: outcome.failures.length.toLocaleString() })}
      </p>
      {outcome.failures.length > 0 && (
        <ul className="max-h-64 overflow-y-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 font-mono text-[11.5px] leading-relaxed">
          {outcome.failures.map((failure, index) => (
            <li key={`${failure.line}-${index}`} className="break-words">
              <span className="text-[var(--cf-text-muted)]">{t("db.importLine", { line: failure.line })}</span>{" "}
              <span className="text-[var(--cf-danger)]">{failure.error}</span>
            </li>
          ))}
        </ul>
      )}
      {outcome.failures_truncated && (
        <p className="text-[11px] text-[var(--cf-text-muted)]">{t("db.importTruncated")}</p>
      )}
    </div>
  );
}
