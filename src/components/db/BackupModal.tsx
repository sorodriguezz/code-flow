import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ArchiveRestore, Copy, DatabaseBackup, ExternalLink, FolderOpen, Loader2 } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { buttonClass } from "../common/Button";
import { Select } from "../common/Select";
import {
  dbBackupCancel,
  dbBackupCheck,
  dbBackupRun,
  dbRestoreRun,
  type DbBackupMissingTool,
  type DbBackupOutcome,
  type DbBackupProgress,
} from "../../lib/tauri/dbCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import {
  backupFileName,
  backupFilters,
  hasFormatChoice,
  restoreFilters,
  type PgBackupFormat,
} from "../../lib/db/backup";
import { formatBytes } from "../../lib/db/drivers";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { DbKind } from "../../types/database";

/** Lines of tool output kept on screen; the tail is what says how it ended. */
const LOG_LINES = 500;

/**
 * Backing a database up to a file, or restoring one from it, with the engine's own tool
 * (`pg_dump`/`psql`/`pg_restore`, `mysqldump`/`mysql`, `mongodump`/`mongorestore`; SQLite in-process).
 *
 * The tool is checked first, and a missing one is the whole answer: which tool, the command that
 * installs it, and nothing to press but Close. Otherwise the file comes from the native dialog, the
 * tool's output streams into the log, and Cancel kills it. A restore writes into the database, so it
 * asks first — and the backend refuses it outright on a read-only connection.
 */
export function BackupModal({
  connectionId,
  database,
  kind,
  mode,
  onClose,
}: {
  connectionId: string;
  database: string | null;
  kind: DbKind;
  mode: "backup" | "restore";
  onClose: () => void;
}) {
  const t = useT();
  const [missing, setMissing] = useState<DbBackupMissingTool | null>(null);
  const [checking, setChecking] = useState(true);
  const [format, setFormat] = useState<PgBackupFormat>("plain");
  const [runId, setRunId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DbBackupOutcome | null>(null);
  const cancelled = useRef(false);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    dbBackupCheck(kind, mode)
      .then((found) => live && setMissing(found))
      .catch((e) => live && setError(String(e)))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [kind, mode]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [log]);

  const running = runId !== null;
  const restore = mode === "restore";

  const run = async () => {
    const path = restore
      ? await openDialog({ multiple: false, directory: false, filters: restoreFilters(kind) }).catch(() => null)
      : await saveDialog({
          defaultPath: backupFileName(database ?? "", kind, format),
          filters: backupFilters(kind, format),
        }).catch(() => null);
    if (typeof path !== "string" || !path) return;
    if (restore) {
      const file = path.split(/[\\/]/).pop() ?? path;
      const ok = await confirmAction(
        t("db.backup.confirmRestore", { file, database: database ?? t("db.backup.thisDatabase") }),
        true,
        t("db.backup.restore"),
      );
      if (!ok) return;
    }

    const id = `dbbackup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    cancelled.current = false;
    setLog([]);
    setError(null);
    setOutcome(null);
    setRunId(id);
    // Subscribed before the call, so the first lines aren't lost to a listener still registering.
    const unlisten = await listen<DbBackupProgress>("db:backup-progress", (event) => {
      if (event.payload.runId !== id) return;
      setLog((current) => [...current.slice(-(LOG_LINES - 1)), event.payload.line]);
    });
    try {
      const done = restore
        ? await dbRestoreRun(connectionId, database, path, id)
        : await dbBackupRun(connectionId, database, path, hasFormatChoice(kind) ? format : null, id);
      setOutcome(done);
    } catch (e) {
      setError(cancelled.current ? t(restore ? "db.backup.restoreCancelled" : "db.backup.cancelled") : String(e));
    } finally {
      unlisten();
      setRunId(null);
    }
  };

  const cancel = () => {
    if (!runId) return;
    cancelled.current = true;
    void dbBackupCancel(runId);
  };

  return (
    <ApiModal
      icon={restore ? ArchiveRestore : DatabaseBackup}
      title={restore ? t("db.backup.restoreTitle") : t("db.backup.title")}
      subtitle={database ?? undefined}
      width="max-w-2xl"
      busy={running}
      dismissOnBackdrop={!running}
      onClose={onClose}
      footer={
        <>
          {!checking && !missing && hasFormatChoice(kind) && !restore && (
            <div className="w-[200px]">
              <Select
                size="sm"
                value={format}
                onChange={(value) => setFormat(value as PgBackupFormat)}
                disabled={running}
                options={[
                  { value: "plain", label: t("db.backup.formatPlain") },
                  { value: "custom", label: t("db.backup.formatCustom") },
                ]}
                ariaLabel={t("db.backup.format")}
              />
            </div>
          )}
          <span className="flex-1" />
          {running ? (
            <GhostButton onClick={cancel}>{t("db.cancel")}</GhostButton>
          ) : (
            <GhostButton onClick={onClose}>{outcome || missing ? t("common.close") : t("common.cancel")}</GhostButton>
          )}
          {!checking && !missing && (
            <button onClick={() => void run()} disabled={running} className={buttonClass({ variant: "primary" })}>
              {running ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
              {running
                ? t(restore ? "db.backup.restoring" : "db.backup.running")
                : t(restore ? "db.backup.chooseRestore" : "db.backup.chooseBackup")}
            </button>
          )}
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[12px]">
        {checking && (
          <p className="flex items-center gap-2 text-[var(--cf-text-muted)]">
            <Loader2 size={12} className="animate-spin" />
            {t("db.backup.checking")}
          </p>
        )}

        {missing && <MissingTool missing={missing} />}

        {!checking && !missing && !running && !outcome && !error && log.length === 0 && (
          <p className="text-[var(--cf-text-muted)]">{restore ? t("db.backup.restoreHint") : t("db.backup.hint")}</p>
        )}

        {outcome && (
          <p className="break-all text-[var(--cf-text)]">
            {t(restore ? "db.backup.restored" : "db.backup.done", {
              size: formatBytes(outcome.bytes),
              seconds: (outcome.durationMs / 1000).toFixed(1),
            })}{" "}
            <span className="font-mono text-[11.5px] text-[var(--cf-text-muted)]">{outcome.path}</span>
          </p>
        )}

        {error && (
          <p className="whitespace-pre-wrap break-words leading-relaxed text-[var(--cf-danger)]">{error}</p>
        )}

        {log.length > 0 && (
          <div className="max-h-72 overflow-y-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
            {log.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        )}
      </div>
    </ApiModal>
  );
}

/** Which tool is missing and how to get it — the only thing the dialog says when one is. */
function MissingTool({ missing }: { missing: DbBackupMissingTool }) {
  const t = useT();
  return (
    <div className="space-y-2">
      <p className="text-[var(--cf-text)]">{t("db.backup.missingTool", { tool: missing.tool })}</p>
      {missing.install && (
        <div className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-1.5">
          <code className="min-w-0 flex-1 select-text truncate font-mono text-[11.5px] text-[var(--cf-text)]">
            {missing.install}
          </code>
          <button
            type="button"
            title={t("db.backup.copyCommand")}
            aria-label={t("db.backup.copyCommand")}
            onClick={() => void navigator.clipboard.writeText(missing.install).catch(() => undefined)}
            className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <Copy size={12} />
          </button>
        </div>
      )}
      {missing.docs && (
        <GhostButton onClick={() => void openExternalUrl(missing.docs)}>
          <ExternalLink size={12} />
          {t("db.backup.download")}
        </GhostButton>
      )}
    </div>
  );
}
