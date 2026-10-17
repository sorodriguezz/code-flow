import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Loader2, RefreshCw, Square, XCircle } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { ToolbarButton } from "./dbChrome";
import { useDbStore } from "../../state/dbStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { dbExecute } from "../../lib/tauri/dbCommands";
import { blockers, sessionDialect } from "../../lib/db/sessionQueries";

interface SessionRow {
  id: string;
  values: Record<string, string | null>;
  blockedBy: string | null;
}

const REFRESH_MS = 3000;

/** The shared columns' headers; an engine's extra columns keep the name the server gave them. */
const HEADERS: Record<string, TranslationKey> = {
  id: "db.sessionCol.id",
  user: "db.sessionCol.user",
  database: "db.sessionCol.database",
  state: "db.sessionCol.state",
  seconds: "db.sessionCol.seconds",
  blocked_by: "db.sessionCol.blocked_by",
  query: "db.sessionCol.query",
};

/**
 * What is running on the server right now: every other session, how long its statement has been
 * going, and who is waiting on whom — with a way to cancel a statement or end a session.
 *
 * Read with the account's own rights (see `lib/db/sessionQueries`), on the app's working session,
 * never a console's: a console may be the very thing that is stuck.
 */
export function SessionsModal({
  connectionId,
  database,
  onClose,
}: {
  connectionId: string;
  database: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const connection = useDbStore((s) => s.connections.find((c) => c.id === connectionId));
  const dialect = connection ? sessionDialect(connection.kind) : null;
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [activeOnly, setActiveOnly] = useState(true);

  const ctx = useMemo(() => ({ database, schema: null, max_rows: 1000 }), [database]);

  const load = useCallback(async () => {
    if (!dialect) return;
    setLoading(true);
    try {
      const result = await dbExecute(connectionId, dialect.list, ctx, crypto.randomUUID());
      const first = result.results[0];
      if (!first || first.error) throw new Error(first?.error ?? "no result");
      const names = first.columns.map((column) => column.name.toLowerCase());
      setColumns(names);
      setRows(
        first.rows.map((row) => {
          const values = Object.fromEntries(names.map((name, index) => [name, row[index] ?? null]));
          return { id: values.id ?? "", values, blockedBy: values.blocked_by ?? null };
        }),
      );
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, ctx, dialect]);

  useEffect(() => {
    void load();
    if (!live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, live]);

  const stop = async (row: SessionRow, how: "cancel" | "kill") => {
    if (!dialect) return;
    const statement = how === "cancel" ? dialect.cancel?.(row.id) : dialect.kill(row.id);
    if (!statement) return;
    if (how === "kill" && !(await confirmAction(t("db.sessionKillConfirm", { id: row.id }), true, t("db.sessionKill")))) {
      return;
    }
    try {
      const result = await dbExecute(connectionId, statement, ctx, crypto.randomUUID());
      const failed = result.results.find((entry) => entry.error);
      if (failed?.error) pushErrorToast(failed.error);
    } catch (e) {
      pushErrorToast(String(e));
    }
    void load();
  };

  const holding = useMemo(() => blockers(rows), [rows]);
  const shown = activeOnly
    ? rows.filter((row) => {
        const state = (row.values.state ?? "").toLowerCase();
        return state !== "idle" && state !== "sleep" && state !== "sleeping" && state !== "inactive";
      })
    : rows;
  const extra = columns.filter((name) => !["id", "user", "database", "state", "seconds", "blocked_by", "query"].includes(name));

  return (
    <ApiModal
      icon={Activity}
      title={t("db.sessions")}
      subtitle={connection?.name}
      width="max-w-6xl"
      height="h-[78vh]"
      onClose={onClose}
      toolbar={
        dialect ? (
          <div className="flex items-center gap-3 text-[11.5px] text-[var(--cf-text-muted)]">
            <label className="flex items-center gap-1.5">
              <Checkbox checked={activeOnly} onChange={setActiveOnly} />
              {t("db.sessionsActiveOnly")}
            </label>
            <label className="flex items-center gap-1.5">
              <Checkbox checked={live} onChange={setLive} />
              {t("db.sessionsLive")}
            </label>
            <ToolbarButton onClick={() => void load()} title={t("db.refresh")}>
              {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            </ToolbarButton>
          </div>
        ) : undefined
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2 text-[11px] text-[var(--cf-text-muted)]">
          <span>{dialect ? t("db.sessionsCount", { n: String(shown.length), total: String(rows.length) }) : ""}</span>
          <GhostButton onClick={onClose}>{t("common.close")}</GhostButton>
        </div>
      }
    >
      {!dialect ? (
        <p className="flex flex-1 items-center justify-center p-6 text-[12px] text-[var(--cf-text-muted)]">
          {t("db.sessionsUnsupported")}
        </p>
      ) : error ? (
        <p className="m-4 flex items-start gap-2 rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/[0.06] p-2 font-mono text-[12px] text-[var(--cf-danger)]">
          <AlertTriangle size={13} className="mt-[2px] shrink-0" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-[1] bg-[var(--cf-surface)] text-left text-[10.5px] uppercase tracking-wide text-[var(--cf-text-faint)]">
              <tr>
                {["id", "user", "database", "state", "seconds", "blocked_by", "query", ...extra].map((name) => (
                  <th key={name} className="border-b border-[var(--cf-border)] px-2 py-1.5 font-semibold">
                    {name in HEADERS ? t(HEADERS[name]) : name}
                  </th>
                ))}
                <th className="border-b border-[var(--cf-border)] px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const blocking = holding.has(row.id);
                const waiting = Boolean(row.blockedBy);
                return (
                  <tr
                    key={row.id}
                    className={`group border-b border-[var(--cf-border)] align-top ${
                      blocking
                        ? "bg-[var(--cf-danger)]/[0.07]"
                        : waiting
                          ? "bg-[var(--cf-warning)]/[0.08]"
                          : "hover:bg-[var(--cf-hover)]"
                    }`}
                  >
                    <td className="whitespace-nowrap px-2 py-1 font-mono tabular-nums">
                      {row.id}
                      {blocking && (
                        <span className="ml-1 rounded bg-[var(--cf-danger)] px-1 text-[9.5px] font-bold uppercase text-[var(--cf-on-accent)]">
                          {t("db.sessionBlocking")}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1">{row.values.user}</td>
                    <td className="whitespace-nowrap px-2 py-1">{row.values.database}</td>
                    <td className="whitespace-nowrap px-2 py-1">{row.values.state}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{formatSeconds(row.values.seconds)}</td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-[var(--cf-warning)]">{row.blockedBy}</td>
                    <td className="max-w-[420px] px-2 py-1">
                      <span title={row.values.query ?? ""} className="line-clamp-2 break-all font-mono text-[11.5px] text-[var(--cf-text)]">
                        {row.values.query}
                      </span>
                    </td>
                    {extra.map((name) => (
                      <td key={name} className="max-w-[160px] truncate px-2 py-1 text-[var(--cf-text-muted)]" title={row.values[name] ?? ""}>
                        {row.values[name]}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-1 py-0.5 text-right">
                      <span className="inline-flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        {dialect.cancel && (
                          <ToolbarButton onClick={() => void stop(row, "cancel")} title={t("db.sessionCancel")}>
                            <Square size={11} />
                          </ToolbarButton>
                        )}
                        <ToolbarButton onClick={() => void stop(row, "kill")} title={t("db.sessionKill")}>
                          <XCircle size={12} className="text-[var(--cf-danger)]" />
                        </ToolbarButton>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ApiModal>
  );
}

function formatSeconds(raw: string | null): string {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || raw === null) return "";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}
