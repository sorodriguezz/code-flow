import { useMemo, useState } from "react";
import { AlertTriangle, Search, Trash2, X } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { dangerIconButtonClass, formatCount, formatDuration } from "./dbChrome";
import { recordModel } from "../../lib/db/engineModel";
import { useDbStore } from "../../state/dbStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";

/**
 * Every statement that ran, newest first.
 *
 * Failed statements are kept and marked, not hidden — a statement that errored is the one most worth
 * finding again, because it is about to be fixed and re-run. Clicking an entry drops it into a new
 * console on the connection it came from rather than running it: re-running a `DELETE` on click
 * would be the worst possible interpretation of "I want to look at this again".
 *
 * It sits under the explorer's own head, whose switch already says "History", so it has no heading
 * of its own: the search box is its first row, with the one action that is about the whole list —
 * clearing it — beside the box.
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
      <div className="flex shrink-0 items-center gap-1 pb-2 pl-3.5 pr-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("db.searchHistory")}
            aria-label={t("db.searchHistory")}
            className={fieldClass({ size: "sm", className: "w-full select-text pl-7 pr-7" })}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title={t("db.clearSearch")}
              aria-label={t("db.clearSearch")}
              className={iconButtonClass({
                size: "xs",
                className: "absolute right-0.5 top-1/2 -translate-y-1/2",
              })}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <Tooltip label={t("db.clearHistory")}>
          <button
            type="button"
            onClick={async () => {
              if (await confirmAction(t("db.clearHistoryConfirm"))) void store.clearHistory();
            }}
            disabled={history.length === 0}
            aria-label={t("db.clearHistory")}
            className={dangerIconButtonClass({ size: "sm" })}
          >
            <Trash2 size={15} />
          </button>
        </Tooltip>
      </div>

      {entries.length === 0 ? (
        // The state in one faint line — there is nothing to do about an empty history but run
        // something, which happens elsewhere.
        <p className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[12px] text-[var(--cf-text-faint)]">
          {t("db.noHistory")}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2.5">
          {entries.map((entry, at) => {
            const stillExists = connections.some((c) => c.id === entry.connection_id);
            return (
              <div
                key={entry.id}
                style={riseDelay(at)}
                className="cf-rise group relative rounded-md px-2 py-1.5 hover:bg-[var(--cf-hover)]"
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
                  // Room on the right for the delete button, which floats over the entry's corner
                  // rather than taking a line of its own under every statement.
                  className="w-full pr-6 text-left disabled:cursor-default"
                >
                  <span className="flex items-center gap-1.5">
                    {entry.error && (
                      <AlertTriangle size={13} className="shrink-0 text-[var(--cf-danger)]" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text)]">
                      {entry.statement.replace(/\s+/g, " ").trim()}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-faint)]">
                    <span className="truncate">{entry.connection_name || "—"}</span>
                    {entry.database_name && <span className="truncate">· {entry.database_name}</span>}
                    <span className="ml-auto shrink-0 tabular-nums">
                      {formatDuration(entry.duration_ms)}
                    </span>
                    {!entry.error && (
                      <span className="shrink-0 tabular-nums">
                        ·{" "}
                        {t(
                          // The engine the statement ran on, not the workspace's default: a history
                          // list mixing a Postgres and a Mongo connection would otherwise call both
                          // of them rows.
                          recordModel(
                            connections.find((c) => c.id === entry.connection_id)?.kind ??
                              "postgres",
                          ).counts.n,
                          { n: formatCount(entry.row_count) },
                        )}
                      </span>
                    )}
                  </span>
                </button>
                {entry.error && (
                  <p className="mt-0.5 break-words text-[11px] text-[var(--cf-danger)]">
                    {entry.error}
                  </p>
                )}
                <span className="absolute right-1 top-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <Tooltip label={t("db.deleteEntry")}>
                    <button
                      type="button"
                      onClick={() => void store.deleteHistory(entry.id)}
                      aria-label={t("db.deleteEntry")}
                      className={dangerIconButtonClass()}
                    >
                      <Trash2 size={13} />
                    </button>
                  </Tooltip>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
