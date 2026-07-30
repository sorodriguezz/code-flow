import { useMemo, useState } from "react";
import { AlertTriangle, Search, Trash2, X } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { History } from "lucide-react";
import { ToolbarButton, formatCount, formatDuration } from "./dbChrome";
import { useDbStore } from "../../state/dbStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * Every statement that ran, newest first.
 *
 * Failed statements are kept and marked, not hidden — a statement that errored is the one most worth
 * finding again, because it is about to be fixed and re-run. Clicking an entry drops it into a new
 * console on the connection it came from rather than running it: re-running a `DELETE` on click
 * would be the worst possible interpretation of "I want to look at this again".
 */
export function DbHistoryList() {
  const t = useT();
  const history = useDbStore((s) => s.history);
  const connections = useDbStore((s) => s.connections);
  const [query, setQuery] = useState("");
  const store = useDbStore.getState();

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return history;
    return history.filter(
      (entry) =>
        entry.statement.toLowerCase().includes(needle) ||
        entry.connection_name.toLowerCase().includes(needle),
    );
  }, [history, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("db.history")}
        </span>
        <ToolbarButton
          onClick={async () => {
            if (await confirmAction(t("db.clearHistoryConfirm"))) void store.clearHistory();
          }}
          disabled={history.length === 0}
          title={t("db.clearHistory")}
        >
          <Trash2 size={13} />
        </ToolbarButton>
      </div>

      <div className="relative shrink-0 px-1.5 py-1.5">
        <Search
          size={12}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("db.searchHistory")}
          className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] py-1 pl-6 pr-6 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            title={t("db.clearSearch")}
            aria-label={t("db.clearSearch")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="min-h-0 flex-1">
          <EmptyState icon={History} title={t("db.noHistory")} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {entries.map((entry) => {
            const stillExists = connections.some((c) => c.id === entry.connection_id);
            return (
              <div
                key={entry.id}
                className="group rounded-md px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <button
                  onClick={() =>
                    stillExists &&
                    store.newConsole(
                      entry.connection_id,
                      entry.database_name || undefined,
                      undefined,
                      entry.statement,
                    )
                  }
                  // A connection that has been deleted can't host a console, so the entry becomes a
                  // record to read rather than one to reopen.
                  disabled={!stillExists}
                  title={stillExists ? t("db.openInConsole") : t("db.connectionGone")}
                  className="w-full text-left disabled:cursor-default"
                >
                  <span className="flex items-center gap-1.5">
                    {entry.error && (
                      <AlertTriangle size={11} className="shrink-0 text-[var(--cf-danger)]" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text)]">
                      {entry.statement.replace(/\s+/g, " ").trim()}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
                    <span className="truncate">{entry.connection_name || "—"}</span>
                    {entry.database_name && <span className="truncate">· {entry.database_name}</span>}
                    <span className="ml-auto shrink-0 tabular-nums">
                      {formatDuration(entry.duration_ms)}
                    </span>
                    {!entry.error && (
                      <span className="shrink-0 tabular-nums">
                        · {t("db.rowsN", { n: formatCount(entry.row_count) })}
                      </span>
                    )}
                  </span>
                </button>
                {entry.error && (
                  <p className="mt-0.5 break-words text-[11px] text-[var(--cf-danger)]">
                    {entry.error}
                  </p>
                )}
                <div className="mt-0.5 flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                  <ToolbarButton
                    onClick={() => void store.deleteHistory(entry.id)}
                    title={t("db.deleteEntry")}
                  >
                    <Trash2 size={11} />
                  </ToolbarButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
